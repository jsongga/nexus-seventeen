import type { ProviderStepResult } from "@cicada/steward-supervisor";
import type { RpetPhase } from "@cicada/steward-supervisor";

const MAX_JSON_LINE_CHARS = 1024 * 1024;
const SECRET_ERROR = "Provider output failed the credential-safety filter";

const DIRECT_SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk-(?:proj-|ant-)?|github_pat_|gh[pousr]_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9._-]{8,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\bhttps?:\/\/[^\s/:@]{1,128}:[^\s/@]{4,256}@/iu,
] as const);

const CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b\s*(?:=|:)\s*["']?([^\s,"'`;]{8,512})/giu;
const HIGH_ENTROPY_CANDIDATE = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{40,256}(?![A-Za-z0-9+/_=-])/gu;
const SAFE_PLACEHOLDERS = new Set([
  "redacted",
  "[redacted]",
  "placeholder",
  "example",
  "example-only",
  "not-a-secret",
  "unset",
]);

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksLikeOrdinaryDigest(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64}|[A-F0-9]{40}|[A-F0-9]{64})$/u.test(value);
}

function assertCredentialSafe(value: string): void {
  if (DIRECT_SECRET_PATTERNS.some((pattern) => pattern.test(value))) throw new Error(SECRET_ERROR);

  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  for (const match of value.matchAll(CREDENTIAL_ASSIGNMENT)) {
    const candidate = (match[1] ?? "").replace(/[.,;:)\]}]+$/u, "");
    if (!SAFE_PLACEHOLDERS.has(candidate.toLowerCase())) throw new Error(SECRET_ERROR);
  }

  HIGH_ENTROPY_CANDIDATE.lastIndex = 0;
  for (const match of value.matchAll(HIGH_ENTROPY_CANDIDATE)) {
    const candidate = match[0];
    if (looksLikeOrdinaryDigest(candidate)) continue;
    const characterClasses = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[+/_=-]/u]
      .filter((pattern) => pattern.test(candidate)).length;
    if (characterClasses >= 3 && shannonEntropy(candidate) >= 4.25) {
      throw new Error(SECRET_ERROR);
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function structuredResult(value: unknown, phase: RpetPhase): ProviderStepResult {
  const item = record(value, "Provider structured result");
  const allowed = new Set(["journal", "testOutcome", "resultOverview"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) {
    throw new Error("Provider structured result contains unexpected fields");
  }
  const journal = text(item.journal, "Provider journal", 1_200);
  const testOutcome = item.testOutcome;
  if (phase === "test") {
    if (testOutcome !== "passed" && testOutcome !== "failed") {
      throw new Error("The test phase must return an evidence-backed outcome");
    }
  } else if (testOutcome !== null && testOutcome !== undefined) {
    throw new Error("Only the test phase may return a test outcome");
  }
  const overview = item.resultOverview === null || item.resultOverview === undefined
    ? undefined
    : text(item.resultOverview, "Provider result overview", 2_000);
  if (phase !== "test" && overview !== undefined) {
    throw new Error("Only a completed test phase may return a result overview");
  }
  if (testOutcome !== "passed" && overview !== undefined) {
    throw new Error("A result overview requires passing test evidence");
  }
  assertCredentialSafe(journal);
  if (overview !== undefined) assertCredentialSafe(overview);
  return Object.freeze({
    journal,
    ...(testOutcome === "passed" || testOutcome === "failed" ? { testOutcome } : {}),
    ...(overview === undefined ? {} : { resultOverview: overview }),
  });
}

function decodeJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

export function parseCodexResult(stdout: string, phase: RpetPhase): ProviderStepResult {
  let finalMessage: string | undefined;
  let completed = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    if (line.length > MAX_JSON_LINE_CHARS) throw new Error("Codex emitted an oversized JSONL event");
    const event = record(decodeJson(line, "Codex event"), "Codex event");
    if (event.type === "turn.failed" || event.type === "error") throw new Error("Codex reported a failed turn");
    if (event.type === "turn.completed") completed = true;
    if (event.type !== "item.completed") continue;
    const item = record(event.item, "Codex completed item");
    if (item.type === "agent_message" && typeof item.text === "string") finalMessage = item.text;
  }
  if (!completed || finalMessage === undefined) throw new Error("Codex ended without a completed structured result");
  return structuredResult(decodeJson(finalMessage, "Codex final message"), phase);
}

export function parseClaudeResult(stdout: string, phase: RpetPhase): ProviderStepResult {
  const envelope = record(decodeJson(stdout, "Claude result envelope"), "Claude result envelope");
  if (envelope.is_error === true || envelope.subtype === "error") throw new Error("Claude reported a failed turn");
  if (envelope.structured_output !== undefined) {
    return structuredResult(envelope.structured_output, phase);
  }
  if (typeof envelope.result === "string") {
    return structuredResult(decodeJson(envelope.result, "Claude final result"), phase);
  }
  return structuredResult(envelope.result, phase);
}
