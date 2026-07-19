import {
  createModelRouter,
  type ModelCatalog,
  type ModelProfile,
  type ModelProvider,
  type ModelRouteDecision,
  type ModelTier,
  type RateCard,
} from "@cicada/steward-model-routing";
import type {
  ProviderAdapterConfig,
  ProviderStepInput,
} from "@cicada/steward-supervisor";
import { providerPrompt } from "./prompt.js";

export const ENGINEER_MODEL_CATALOG_ENV = "CICADA_STEWARD_MODEL_CATALOG_JSON";

const MODEL_PROVIDERS = Object.freeze(["codex", "claude"] as const);
const MODEL_TIERS = Object.freeze(["economy", "balanced", "frontier"] as const);
const MAXIMUM_CATALOG_BYTES = 64 * 1024;
const MAXIMUM_MODEL_ID_CHARS = 128;
const MAXIMUM_TURN_TOKENS = 32_768;
const RESERVED_OUTPUT_TOKENS = 2_048;
const FIXED_CONTEXT_OVERHEAD_TOKENS = 1_024;
const ESTIMATED_UTF8_BYTES_PER_TOKEN = 3;
const MODEL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$/u;

export class EngineerRoutingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineerRoutingError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new EngineerRoutingError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Reflect.ownKeys(value).map(String).sort();
  const accepted = [...expected].sort();
  if (actual.length !== accepted.length || actual.some((key, index) => key !== accepted[index])) {
    throw new EngineerRoutingError(`${label} must contain exactly: ${accepted.join(", ")}`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new EngineerRoutingError(
      `${label} must be a bounded non-empty string without controls or surrounding whitespace`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new EngineerRoutingError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EngineerRoutingError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function parseRateCard(value: unknown, label: string): RateCard {
  const item = record(value, label);
  exactKeys(
    item,
    ["id", "currency", "inputPerMillionTokens", "outputPerMillionTokens", "effectiveAt"],
    label,
  );
  return Object.freeze({
    id: boundedText(item.id, `${label}.id`, 128),
    currency: boundedText(item.currency, `${label}.currency`, 16),
    inputPerMillionTokens: nonNegativeNumber(
      item.inputPerMillionTokens,
      `${label}.inputPerMillionTokens`,
    ),
    outputPerMillionTokens: nonNegativeNumber(
      item.outputPerMillionTokens,
      `${label}.outputPerMillionTokens`,
    ),
    effectiveAt: boundedText(item.effectiveAt, `${label}.effectiveAt`, 64),
  });
}

function parseModelProfile(
  value: unknown,
  provider: ModelProvider,
  tier: ModelTier,
): ModelProfile {
  const label = `${ENGINEER_MODEL_CATALOG_ENV}.${provider}.${tier}`;
  const item = record(value, label);
  const hasRateCard = Object.hasOwn(item, "rateCard");
  exactKeys(
    item,
    hasRateCard
      ? ["provider", "tier", "modelId", "contextWindowTokens", "maximumOutputTokens", "rateCard"]
      : ["provider", "tier", "modelId", "contextWindowTokens", "maximumOutputTokens"],
    label,
  );
  if (item.provider !== provider || item.tier !== tier) {
    throw new EngineerRoutingError(`${label} must identify its configured provider and tier`);
  }
  const modelId = boundedText(item.modelId, `${label}.modelId`, MAXIMUM_MODEL_ID_CHARS);
  if (!MODEL_ID.test(modelId)) {
    throw new EngineerRoutingError(`${label}.modelId contains unsupported characters`);
  }
  const common = {
    provider,
    tier,
    modelId,
    contextWindowTokens: positiveInteger(
      item.contextWindowTokens,
      `${label}.contextWindowTokens`,
    ),
    maximumOutputTokens: positiveInteger(
      item.maximumOutputTokens,
      `${label}.maximumOutputTokens`,
    ),
  } as const;
  return Object.freeze(
    hasRateCard
      ? { ...common, rateCard: parseRateCard(item.rateCard, `${label}.rateCard`) }
      : common,
  );
}

export function parseEngineerModelCatalog(raw: string | undefined): ModelCatalog {
  if (raw === undefined || raw.trim().length === 0) {
    throw new EngineerRoutingError(`${ENGINEER_MODEL_CATALOG_ENV} is required`);
  }
  if (Buffer.byteLength(raw, "utf8") > MAXIMUM_CATALOG_BYTES) {
    throw new EngineerRoutingError(`${ENGINEER_MODEL_CATALOG_ENV} exceeds the fixed size limit`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new EngineerRoutingError(`${ENGINEER_MODEL_CATALOG_ENV} must be valid JSON`, { cause: error });
  }
  const value = record(decoded, ENGINEER_MODEL_CATALOG_ENV);
  exactKeys(value, MODEL_PROVIDERS, ENGINEER_MODEL_CATALOG_ENV);
  const providers = {} as Record<ModelProvider, Record<ModelTier, ModelProfile>>;
  for (const provider of MODEL_PROVIDERS) {
    const configuredProvider = record(value[provider], `${ENGINEER_MODEL_CATALOG_ENV}.${provider}`);
    exactKeys(configuredProvider, MODEL_TIERS, `${ENGINEER_MODEL_CATALOG_ENV}.${provider}`);
    const tiers = {} as Record<ModelTier, ModelProfile>;
    const modelIds = new Set<string>();
    for (const tier of MODEL_TIERS) {
      const profile = parseModelProfile(configuredProvider[tier], provider, tier);
      if (modelIds.has(profile.modelId)) {
        throw new EngineerRoutingError(
          `${ENGINEER_MODEL_CATALOG_ENV}.${provider} must use a distinct modelId for every tier`,
        );
      }
      modelIds.add(profile.modelId);
      tiers[tier] = profile;
    }
    providers[provider] = Object.freeze(tiers);
  }
  const catalog = Object.freeze(providers);
  try {
    createModelRouter(catalog);
  } catch (error) {
    throw new EngineerRoutingError(`${ENGINEER_MODEL_CATALOG_ENV} failed routing validation`, {
      cause: error,
    });
  }
  return catalog;
}

function estimateInputTokens(input: ProviderStepInput): number {
  const promptBytes = Buffer.byteLength(providerPrompt(input), "utf8");
  const unabridgedTaskBytes =
    Buffer.byteLength(input.task.title, "utf8") + Buffer.byteLength(input.task.objective, "utf8");
  const estimated =
    FIXED_CONTEXT_OVERHEAD_TOKENS +
    Math.ceil(Math.max(promptBytes, unabridgedTaskBytes) / ESTIMATED_UTF8_BYTES_PER_TOKEN);
  // The cap avoids unsafe arithmetic while deliberately leaving enough tokens
  // to produce a blocked turn once the reserved output is included.
  return Math.min(estimated, MAXIMUM_TURN_TOKENS);
}

export interface EngineerModelSelector {
  select(input: ProviderStepInput): ModelRouteDecision;
}

export function createEngineerModelSelector(
  config: ProviderAdapterConfig,
  environment: NodeJS.ProcessEnv = process.env,
): EngineerModelSelector {
  if (config.role !== "engineer") {
    throw new EngineerRoutingError("The engineer model router may only own engineer RPET lanes");
  }
  if (config.providerName !== "codex") {
    throw new EngineerRoutingError("Engineer RPET requires the configured Codex provider");
  }
  const catalog = parseEngineerModelCatalog(environment[ENGINEER_MODEL_CATALOG_ENV]);
  if (config.model !== catalog.codex.economy.modelId) {
    throw new EngineerRoutingError(
      "The declared provider model must match the caller-supplied Codex economy baseline",
    );
  }
  const router = createModelRouter(catalog);
  return Object.freeze({
    select(input: ProviderStepInput): ModelRouteDecision {
      if (!Number.isSafeInteger(input.iteration) || input.iteration < 1) {
        throw new EngineerRoutingError("RPET iteration must be a positive safe integer");
      }
      const decision = router.route({
        role: "engineer",
        phase: input.phase,
        purpose: "development",
        // Risk and complexity are not present in the provider protocol yet.
        // Keep them low instead of inferring spend from task prose.
        complexity: "low",
        risk: "low",
        context: {
          estimatedInputTokens: estimateInputTokens(input),
          reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
          maximumTurnTokens: MAXIMUM_TURN_TOKENS,
        },
        // A new RPET iteration exists only after the preceding Test failed.
        priorFailedTests: input.iteration - 1,
      });
      if (decision.disposition !== "model") {
        throw new EngineerRoutingError(
          `Engineer model routing denied this step: ${decision.disposition}/${decision.reason}`,
        );
      }
      if (
        decision.provider !== "codex" ||
        decision.model.provider !== "codex" ||
        decision.provider !== config.providerName
      ) {
        throw new EngineerRoutingError("Engineer model routing returned a provider mismatch");
      }
      return decision;
    },
  });
}

export function engineerRouteCurrentAction(
  input: ProviderStepInput,
  route: ModelRouteDecision,
): string {
  const phase = input.phase === "test"
    ? "Testing"
    : `${input.phase[0]!.toUpperCase()}${input.phase.slice(1)}ing`;
  const reasons = route.reasons.map(({ code }) => code).join(",");
  const summary =
    `${phase} iteration ${input.iteration} via ${route.selectedTier}/${route.model.modelId}; reasons=${reasons}`;
  if (summary.length > 280) {
    throw new EngineerRoutingError("The selected route cannot fit the bounded current action");
  }
  return summary;
}
