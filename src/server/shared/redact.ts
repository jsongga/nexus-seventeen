const PRIVATE_KEY_PATTERN = /-----BEGIN ((?:[A-Z0-9 ]+ )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/giu;
const URL_CREDENTIAL_PATTERN = /\bhttps?:\/\/[^\s/:@]{1,128}:[^\s/@]{4,256}@/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const PREFIXED_TOKEN_PATTERN = /\b(?:(?:sk|xox)_|sk-(?:proj-|ant-)?|github_pat_|gh[pousr]_|glpat-|npm_|xox[a-z]-)[A-Za-z0-9._~+/-]+/gu;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/gu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/gu;
const CONTROL_CHARACTER_EXCEPT_NEWLINE_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f]/gu;
const REDACTION_MARKER_PATTERN = /^\[redacted:(?:token|bearer|pem|url-credential)\]/u;

function truncatePreservingRedactionMarkers(value: string, maxLength: number): string {
  const limit = Math.max(0, Math.trunc(maxLength));
  if (limit === 0) return "";
  if (value.length <= limit) return value;
  const markerStart = value.lastIndexOf("[redacted:", limit - 1);
  const marker = markerStart < 0 ? null : REDACTION_MARKER_PATTERN.exec(value.slice(markerStart))?.[0] ?? null;
  if (marker === null || markerStart + marker.length <= limit) return value.slice(0, limit);
  if (marker.length > limit) return value.slice(0, markerStart);
  return `${value.slice(0, limit - marker.length)}${marker}`;
}

function redact(
  value: string,
  controlCharacters: RegExp,
  maxLength: number | undefined,
): string {
  const redacted = value
    .replace(controlCharacters, "")
    .replace(PRIVATE_KEY_PATTERN, "[redacted:pem]")
    .replace(URL_CREDENTIAL_PATTERN, "[redacted:url-credential]")
    .replace(BEARER_PATTERN, "[redacted:bearer]")
    .replace(PREFIXED_TOKEN_PATTERN, "[redacted:token]")
    .replace(AWS_ACCESS_KEY_PATTERN, "[redacted:token]");
  return maxLength === undefined ? redacted : truncatePreservingRedactionMarkers(redacted, maxLength);
}

/** Pattern-based only — a secret in an unrecognized format persists. Entropy scanning is out of scope (spec §Redact). */
export function redactForPersistence(value: string, maxLength?: number): string {
  return redact(value, CONTROL_CHARACTER_PATTERN, maxLength);
}

/** Gap-report ingress only: applies the standard persistence scrub while retaining Markdown line breaks. */
export function redactMultilineForPersistence(value: string, maxLength?: number): string {
  return redact(value, CONTROL_CHARACTER_EXCEPT_NEWLINE_PATTERN, maxLength);
}
