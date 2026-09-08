/** Owns the credential-recognition patterns and text-redaction policy used by the server. */

/* —— Credential vocabulary —— */

// One vocabulary of credential shapes, two policies over it. Persistence
// redaction over-matches on purpose because it is the last defense before
// durable storage and a false positive does not abort a run. The boundary is
// handed user-authored work-item prose and workspace paths, so it rewrites with
// the narrower set to preserve ordinary prose while still removing its
// recognized credential shapes. The shapes below are shared; the boundary set
// narrows three of them — a length floor, a character class, and the weak
// prefixes — each for a reason stated where it is defined. Nothing else may
// differ, and the tests assert that.
const BEARER_CHARACTERS = String.raw`[A-Za-z0-9._~+/=-]`;

// Prefixes that name a vendor's key format. Seeing one is a strong signal on its
// own, so both policies act on them.
const VENDOR_TOKEN_PREFIX = String.raw`(?:sk-(?:proj-|ant-)?|sk_(?:live|test)_|github_pat_|gh[pousr]_|glpat-|npm_|xox[a-z]-)`;
// A bare `sk_`/`xox_` is also just ordinary snake_case: `sk_buff_alloc` is a
// kernel symbol, not a key. Redaction takes them anyway (a wrongly redacted
// identifier in a log costs nothing); rejection does not, and reaches real
// Stripe keys through the `sk_live_`/`sk_test_` forms above instead.
const WEAK_TOKEN_PREFIX = String.raw`(?:sk|xox)_`;

// Redaction runs over a token's full character set. Rejection measures its floor
// over token-shaped characters only: with `~ + /` included, a path such as
// `packages/sk-utils/index.ts` clears any length floor by crossing punctuation,
// and `workspaceRefs` hands this filter exactly such paths.
const TOKEN_CHARACTERS = String.raw`[A-Za-z0-9._~+/-]`;
const REJECTED_TOKEN_CHARACTERS = String.raw`[A-Za-z0-9._-]`;

// A real bearer token is far longer than the word that follows "Bearer" in a
// sentence, and a real prefixed token far longer than a prefix quoted in prose.
const REJECTED_BEARER_MINIMUM = 12;
const REJECTED_TOKEN_MINIMUM = 8;

// Length alone is not enough for the bearer rule: "Bearer authentication" is
// fourteen characters of ordinary prose, and rejecting it kills an agent run.
// Neither is "contains a non-letter", which was the first attempt: `.` `-` `/`
// `_` are all inside the token character class, so a sentence-final full stop
// turns "Bearer authentication." into a credential — the same bug, one keystroke
// away. What actually separates them is a **digit**. English words have none,
// and neither do the CamelCase identifiers a work item is full of
// (`AuthenticationMiddleware`, `JwtBearerAuthenticationHandler`), while a JWT, a
// hex token and a base62 token essentially always do.
//
// Two gaps, both decisions rather than oversights:
//   - An all-letter token is not rejected at any length. That is 0.36% of
//     32-character base62 strings, and roughly one in eight at twelve — but
//     tokens that short are themselves uncommon, and the persistence path still
//     redacts every one of them.
//   - An identifier that does carry a digit ("Bearer OAuth2Middleware") is still
//     rejected. Rarer than the prose above, and the failure is visible.
// A length-based safety net was tried and removed: at any threshold low enough
// to catch a digit-free token it also catches a real class name.
const REJECTED_BEARER_DIGIT = String.raw`(?=[A-Za-z0-9._~+/=-]*[0-9])`;

/** Recognizes credentials for rewriting. Global: every occurrence is replaced. */
export const CREDENTIAL_PATTERNS = Object.freeze({
  privateKey: /-----BEGIN ((?:[A-Z0-9 ]+ )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/giu,
  urlCredential: /\bhttps?:\/\/[^\s/:@]{1,128}:[^\s/@]{4,256}@/giu,
  bearer: new RegExp(String.raw`\bBearer\s+${BEARER_CHARACTERS}+`, "giu"),
  prefixedToken: new RegExp(String.raw`\b(?:${WEAK_TOKEN_PREFIX}|${VENDOR_TOKEN_PREFIX})${TOKEN_CHARACTERS}+`, "gu"),
  awsAccessKey: /\bAKIA[0-9A-Z]{16}\b/gu,
});

// Deliberately not global: `test` on a global regex advances `lastIndex`, so a
// shared pattern would resume mid-string on its next call. Deriving fresh
// non-global copies removes that state rather than resetting it around each use.
const withoutGlobalFlag = (pattern: RegExp): RegExp => new RegExp(pattern.source, pattern.flags.replace("g", ""));

/** Recognizes credentials at the agent boundary. Same shapes, narrowed so prose and paths survive. */
export const CREDENTIAL_REJECTION_PATTERNS = Object.freeze({
  privateKey: withoutGlobalFlag(CREDENTIAL_PATTERNS.privateKey),
  urlCredential: withoutGlobalFlag(CREDENTIAL_PATTERNS.urlCredential),
  bearer: new RegExp(
    String.raw`\bBearer\s+${REJECTED_BEARER_DIGIT}${BEARER_CHARACTERS}{${REJECTED_BEARER_MINIMUM},}`,
    "iu"
  ),
  prefixedToken: new RegExp(
    String.raw`\b${VENDOR_TOKEN_PREFIX}${REJECTED_TOKEN_CHARACTERS}{${REJECTED_TOKEN_MINIMUM},}`,
    "u"
  ),
  awsAccessKey: withoutGlobalFlag(CREDENTIAL_PATTERNS.awsAccessKey),
});

export type CredentialPatternName = keyof typeof CREDENTIAL_REJECTION_PATTERNS;

/* —— Redaction —— */

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/gu;
const CONTROL_CHARACTER_EXCEPT_NEWLINE_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f]/gu;
const REDACTION_MARKER_PATTERN = /^\[redacted:(?:token|bearer|pem|url-credential)\]/u;

export interface CredentialRedactionMarkers {
  readonly token: string;
  readonly bearer: string;
  readonly pem: string;
  readonly urlCredential: string;
}

const PERSISTENCE_CREDENTIAL_MARKERS: CredentialRedactionMarkers = Object.freeze({
  token: "[redacted:token]",
  bearer: "[redacted:bearer]",
  pem: "[redacted:pem]",
  urlCredential: "[redacted:url-credential]",
});

function truncatePreservingRedactionMarkers(value: string, maxLength: number): string {
  const limit = Math.max(0, Math.trunc(maxLength));
  if (limit === 0) return "";
  if (value.length <= limit) return value;
  const markerStart = value.lastIndexOf("[redacted:", limit - 1);
  const marker = markerStart < 0 ? null : (REDACTION_MARKER_PATTERN.exec(value.slice(markerStart))?.[0] ?? null);
  if (marker === null || markerStart + marker.length <= limit) return value.slice(0, limit);
  if (marker.length > limit) return value.slice(0, markerStart);
  return `${value.slice(0, limit - marker.length)}${marker}`;
}

function redact(value: string, controlCharacters: RegExp, maxLength: number | undefined): string {
  const redacted = redactRecognizedCredentials(value.replace(controlCharacters, ""));
  return maxLength === undefined ? redacted : truncatePreservingRedactionMarkers(redacted, maxLength);
}

/** Applies the repository's credential patterns with caller-selected display markers. */
export function redactRecognizedCredentials(
  value: string,
  markers: CredentialRedactionMarkers = PERSISTENCE_CREDENTIAL_MARKERS
): string {
  return value
    .replace(CREDENTIAL_PATTERNS.privateKey, () => markers.pem)
    .replace(CREDENTIAL_PATTERNS.urlCredential, () => markers.urlCredential)
    .replace(CREDENTIAL_PATTERNS.bearer, () => markers.bearer)
    .replace(CREDENTIAL_PATTERNS.prefixedToken, () => markers.token)
    .replace(CREDENTIAL_PATTERNS.awsAccessKey, () => markers.token);
}

/** Pattern-based only — a secret in an unrecognized format persists. Entropy scanning is out of scope (spec §Redact). */
export function redactForPersistence(value: string, maxLength?: number): string {
  return redact(value, CONTROL_CHARACTER_PATTERN, maxLength);
}

/** Gap-report ingress only: applies the standard persistence scrub while retaining Markdown line breaks. */
export function redactMultilineForPersistence(value: string, maxLength?: number): string {
  return redact(value, CONTROL_CHARACTER_EXCEPT_NEWLINE_PATTERN, maxLength);
}

export const MAX_SAFE_ERROR_DETAIL_CHARACTERS = 2_000;

/** Scrubs credentials and control characters before an error can reach durable state or logs. */
export function safeErrorDetail(error: unknown, fallback = "Task worker failed"): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const redacted = redactForPersistence(source, MAX_SAFE_ERROR_DETAIL_CHARACTERS).trim();
  return redacted || redactForPersistence(fallback, MAX_SAFE_ERROR_DETAIL_CHARACTERS).trim();
}
