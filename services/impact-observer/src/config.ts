import { isAbsolute, parse, resolve, sep } from "node:path";
import {
  createModelRouter,
  type ModelCatalog,
  type ModelProfile,
  type ModelProvider,
  type ModelTier,
  type RateCard,
} from "@cicada/steward-model-routing";
import type { WorkspaceId } from "@cicada/steward-protocol";
import type { ImpactObserverLimits } from "./types.js";

export interface ImpactObserverConfig {
  readonly controlPlaneOrigin: string;
  readonly workspaceId: WorkspaceId;
  readonly readToken: string;
  readonly outputToken: string;
  readonly statePath: string;
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: ReadonlySet<string>;
  readonly reconnectMinimumMs: number;
  readonly reconnectMaximumMs: number;
  readonly limits: ImpactObserverLimits;
  readonly modelCatalog: ModelCatalog;
  readonly fakeModel: boolean;
  readonly adapterModulePath: string | null;
}

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u;
const MODEL_PROVIDERS = Object.freeze(["codex", "claude"] as const);
const MODEL_TIERS = Object.freeze(["economy", "balanced", "frontier"] as const);
const MAXIMUM_CATALOG_BYTES = 64 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const accepted = [...expected].sort();
  if (actual.length !== accepted.length || actual.some((key, index) => key !== accepted[index])) {
    throw new Error(`${label} must contain exactly: ${accepted.join(", ")}`);
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
    throw new Error(`${label} must be a bounded non-empty string without surrounding whitespace`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
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
    inputPerMillionTokens: nonNegativeNumber(item.inputPerMillionTokens, `${label}.inputPerMillionTokens`),
    outputPerMillionTokens: nonNegativeNumber(item.outputPerMillionTokens, `${label}.outputPerMillionTokens`),
    effectiveAt: boundedText(item.effectiveAt, `${label}.effectiveAt`, 64),
  });
}

function parseModelProfile(
  value: unknown,
  provider: ModelProvider,
  tier: ModelTier,
): ModelProfile {
  const label = `STEWARD_MODEL_CATALOG_JSON.${provider}.${tier}`;
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
    throw new Error(`${label} must identify its configured provider and tier`);
  }
  const common = {
    provider,
    tier,
    modelId: boundedText(item.modelId, `${label}.modelId`, 256),
    contextWindowTokens: positiveInteger(item.contextWindowTokens, `${label}.contextWindowTokens`),
    maximumOutputTokens: positiveInteger(item.maximumOutputTokens, `${label}.maximumOutputTokens`),
  } as const;
  return Object.freeze(
    hasRateCard
      ? { ...common, rateCard: parseRateCard(item.rateCard, `${label}.rateCard`) }
      : common,
  );
}

export function parseImpactModelCatalog(raw: string | undefined): ModelCatalog {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("STEWARD_MODEL_CATALOG_JSON is required");
  }
  if (Buffer.byteLength(raw, "utf8") > MAXIMUM_CATALOG_BYTES) {
    throw new Error("STEWARD_MODEL_CATALOG_JSON exceeds the configured size limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("STEWARD_MODEL_CATALOG_JSON must be valid JSON");
  }
  const value = record(decoded, "STEWARD_MODEL_CATALOG_JSON");
  exactKeys(value, MODEL_PROVIDERS, "STEWARD_MODEL_CATALOG_JSON");
  const providers = {} as Record<ModelProvider, Record<ModelTier, ModelProfile>>;
  for (const provider of MODEL_PROVIDERS) {
    const configuredProvider = record(value[provider], `STEWARD_MODEL_CATALOG_JSON.${provider}`);
    exactKeys(configuredProvider, MODEL_TIERS, `STEWARD_MODEL_CATALOG_JSON.${provider}`);
    const tiers = {} as Record<ModelTier, ModelProfile>;
    for (const tier of MODEL_TIERS) {
      tiers[tier] = parseModelProfile(configuredProvider[tier], provider, tier);
    }
    providers[provider] = Object.freeze(tiers);
  }
  const catalog = Object.freeze(providers);
  createModelRouter(catalog);
  return catalog;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (/\p{Cc}/u.test(value)) throw new Error(`${name} contains control characters`);
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function controlPlaneOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("STEWARD_CONTROL_PLANE_URL must be an HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("STEWARD_CONTROL_PLANE_URL must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  const loopback = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("STEWARD_CONTROL_PLANE_URL requires HTTPS except on loopback");
  }
  return url.origin;
}

function safeStatePath(value: string): string {
  if (!isAbsolute(value)) throw new Error("STEWARD_IMPACT_STATE_PATH must be absolute");
  const path = resolve(value);
  const root = parse(path).root;
  if (path === root || path.split(sep).filter(Boolean).length < 3) {
    throw new Error("STEWARD_IMPACT_STATE_PATH is too broad");
  }
  return path;
}

function origins(value: string | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const item of (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`Invalid STEWARD_IMPACT_CORS_ORIGINS entry: ${item}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== item) {
      throw new Error(`Unsafe STEWARD_IMPACT_CORS_ORIGINS entry: ${item}`);
    }
    result.add(item);
  }
  return result;
}

export function loadImpactObserverConfig(env: NodeJS.ProcessEnv = process.env): ImpactObserverConfig {
  const workspaceId = required(env, "STEWARD_WORKSPACE_ID");
  if (!IDENTIFIER.test(workspaceId)) throw new Error("STEWARD_WORKSPACE_ID is not a valid Steward identifier");
  const readToken = required(env, "STEWARD_IMPACT_READ_TOKEN");
  const outputToken = required(env, "STEWARD_IMPACT_OUTPUT_TOKEN");
  if (readToken.length < 16 || outputToken.length < 16) throw new Error("Impact observer tokens must be at least 16 characters");
  if (readToken === outputToken) {
    throw new Error("STEWARD_IMPACT_OUTPUT_TOKEN must differ from the command-capable control-plane token");
  }
  const reconnectMinimumMs = integer(env, "STEWARD_IMPACT_RECONNECT_MIN_MS", 500, 100, 60_000);
  const reconnectMaximumMs = integer(env, "STEWARD_IMPACT_RECONNECT_MAX_MS", 15_000, 100, 300_000);
  if (reconnectMaximumMs < reconnectMinimumMs) {
    throw new Error("STEWARD_IMPACT_RECONNECT_MAX_MS must not be lower than the minimum");
  }
  const fakeModel = env.STEWARD_IMPACT_FAKE_MODEL === "true";
  const adapterModulePath = env.STEWARD_IMPACT_ADAPTER_MODULE?.trim() || null;
  if (!fakeModel && adapterModulePath === null) {
    throw new Error("Set STEWARD_IMPACT_ADAPTER_MODULE or STEWARD_IMPACT_FAKE_MODEL=true");
  }
  if (adapterModulePath !== null && !isAbsolute(adapterModulePath)) {
    throw new Error("STEWARD_IMPACT_ADAPTER_MODULE must be an absolute path");
  }

  return Object.freeze({
    controlPlaneOrigin: controlPlaneOrigin(required(env, "STEWARD_CONTROL_PLANE_URL")),
    workspaceId: workspaceId as WorkspaceId,
    readToken,
    outputToken,
    statePath: safeStatePath(required(env, "STEWARD_IMPACT_STATE_PATH")),
    host: env.STEWARD_IMPACT_HOST?.trim() || "127.0.0.1",
    port: integer(env, "STEWARD_IMPACT_PORT", 4319, 0, 65_535),
    corsOrigins: origins(env.STEWARD_IMPACT_CORS_ORIGINS),
    reconnectMinimumMs,
    reconnectMaximumMs,
    limits: Object.freeze({
      maxTrackedTasks: integer(env, "STEWARD_IMPACT_MAX_TASKS", 100, 1, 1_000),
      maxProgressEntriesPerTask: integer(env, "STEWARD_IMPACT_MAX_PROGRESS", 6, 1, 32),
      maxSourceChars: integer(env, "STEWARD_IMPACT_MAX_SOURCE_CHARS", 600, 128, 4_096),
      maxInputTokens: integer(env, "STEWARD_IMPACT_MAX_INPUT_TOKENS", 512, 128, 4_096),
      maxOutputTokens: integer(env, "STEWARD_IMPACT_MAX_OUTPUT_TOKENS", 96, 32, 512),
      maxSummaryChars: integer(env, "STEWARD_IMPACT_MAX_SUMMARY_CHARS", 480, 80, 2_048),
    }),
    modelCatalog: parseImpactModelCatalog(env.STEWARD_MODEL_CATALOG_JSON),
    fakeModel,
    adapterModulePath,
  });
}
