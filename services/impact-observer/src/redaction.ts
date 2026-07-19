import type { TaskStatus } from "@cicada/steward-protocol";
import type { ImpactModelRequest, ImpactModelTaskFacts, ImpactObserverLimits } from "./types.js";

const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN [^-\r\n]{1,80} PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{1,80} PRIVATE KEY-----/giu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/giu,
  /\b(?:sk|rk|pk|ghp|gho|ghu|ghs|github_pat)-?[A-Za-z0-9_\-]{10,}\b/giu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|password|passwd|secret|credential)\s*[:=]\s*[^\s,;]{4,}/giu,
  /\b(?:https?|wss?):\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/giu,
]);

const TECHNICAL_LINE = /(?:```|`[^`]+`|(?:^|\s)(?:npm|pnpm|yarn|git|curl|docker|kubectl)\s|(?:^|\s)(?:src|lib|dist|services|packages|node_modules)[/\\]|\b(?:backend|frontend|server|runtime|repository|commit|dependency|framework|module|container|cluster|stack trace|exception|segfault|http\s+[1-5]\d\d|sql|json|typescript|javascript|python|database schema|api endpoint|codex|claude)\b|(?:^|\s)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+|[{}]|=>)/iu;
const RELEASE_CLAIM = /\b(?:deployed|released|shipped|live)\b[^.!?]{0,40}\b(?:production|prod|users?)\b|\bin production\b|\b(?:now available|available now|customers? can now|users? can now|already live)\b/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const URL = /\b(?:https?|wss?):\/\/[^\s<>{}\[\]]+/giu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return value.slice(0, maximum);
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function replaceSecrets(value: string): string {
  let sanitized = value;
  for (const pattern of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[private value omitted]");
  return sanitized;
}

export function containsSensitiveMaterial(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/** Removes credentials and implementation-shaped lines before any model sees them. */
export function sanitizeSourceText(value: string, maximumCharacters: number): string {
  const bounded = value.slice(0, Math.max(maximumCharacters * 4, maximumCharacters));
  const withoutCodeBlocks = bounded.replace(/```[\s\S]*?```/gu, "\n[technical details omitted]\n");
  const sanitized = replaceSecrets(withoutCodeBlocks)
    .replace(EMAIL, "[private contact omitted]")
    .replace(URL, "[link omitted]")
    .replace(CONTROL_CHARACTERS, " ");

  const safeLines: string[] = [];
  for (const rawLine of sanitized.split(/\r?\n/gu)) {
    const line = rawLine.replace(/\s+/gu, " ").trim();
    if (line.length === 0) continue;
    if (TECHNICAL_LINE.test(line)) {
      if (safeLines.at(-1) !== "[technical details omitted]") safeLines.push("[technical details omitted]");
      continue;
    }
    safeLines.push(line);
  }
  const result = safeLines.join(" ").trim();
  return clip(result.length > 0 ? result : "[details withheld]", maximumCharacters);
}

export function estimateTokens(value: string): number {
  if (value.length === 0) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

export const IMPACT_INSTRUCTION =
  "Explain only the user-facing outcome and current confidence in plain language. " +
  "Do not mention code, tools, models, files, systems, credentials, internal steps, or production deployment. " +
  "Do not claim the change is available to users; every release still requires human approval. Use at most three short sentences.";

function requestSize(task: ImpactModelTaskFacts): number {
  return estimateTokens(JSON.stringify({ instruction: IMPACT_INSTRUCTION, task }));
}

export function buildImpactModelRequest(
  input: {
    readonly title: string;
    readonly objective: string;
    readonly status: TaskStatus;
    readonly recentUpdates: readonly string[];
  },
  limits: ImpactObserverLimits,
): ImpactModelRequest {
  let title = sanitizeSourceText(input.title, Math.min(limits.maxSourceChars, 160));
  let objective = sanitizeSourceText(input.objective, Math.min(limits.maxSourceChars, 480));
  let recentUpdates = input.recentUpdates
    .map((update) => sanitizeSourceText(update, Math.min(limits.maxSourceChars, 240)))
    .slice(-limits.maxProgressEntriesPerTask);

  const facts = (): ImpactModelTaskFacts => Object.freeze({
    title,
    objective,
    status: input.status,
    recentUpdates: Object.freeze([...recentUpdates]),
  });

  while (requestSize(facts()) > limits.maxInputTokens && recentUpdates.length > 0) {
    recentUpdates = recentUpdates.slice(1);
  }
  if (requestSize(facts()) > limits.maxInputTokens) objective = clip(objective, 160);
  if (requestSize(facts()) > limits.maxInputTokens) title = clip(title, 80);
  if (requestSize(facts()) > limits.maxInputTokens) objective = "Requested user improvement";
  if (requestSize(facts()) > limits.maxInputTokens) title = "Requested work";

  const task = facts();
  const estimatedInputTokens = requestSize(task);
  if (estimatedInputTokens > limits.maxInputTokens) {
    throw new Error("Impact model input budget is too small for the safety instruction");
  }
  return Object.freeze({
    instruction: IMPACT_INSTRUCTION,
    task,
    estimatedInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
  });
}

function safeFallback(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return "The requested improvement is queued; users are not affected yet.";
    case "running":
      return "Work on the requested improvement is underway; user-facing results are not confirmed yet.";
    case "paused":
      return "Work on the requested improvement is paused; user-facing results are not confirmed yet.";
    case "completed":
      return "The requested improvement is complete and ready for human review before any user release.";
    case "failed":
      return "The requested improvement is not ready for users yet; more work is needed before human review.";
  }
}

/** Fails closed to a status-only sentence if model output contains unsafe detail. */
export function sanitizePublicSummary(
  value: string,
  status: TaskStatus,
  maximumCharacters: number,
): string {
  const bounded = value.slice(0, maximumCharacters * 4);
  const candidateSentences = bounded
    .replace(CONTROL_CHARACTERS, " ")
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 6);

  const safe: string[] = [];
  for (const sentence of candidateSentences) {
    if (containsSensitiveMaterial(sentence) || TECHNICAL_LINE.test(sentence) || RELEASE_CLAIM.test(sentence)) continue;
    if (patternMatches(EMAIL, sentence) || patternMatches(URL, sentence)) continue;
    safe.push(sentence);
    if (safe.length === 3) break;
  }
  const result = safe.join(" ").trim();
  return clip(result.length > 0 ? result : safeFallback(status), maximumCharacters);
}
