export const MAX_SAFE_ERROR_DETAIL_CHARACTERS = 2_000;

/** Scrubs credentials and control characters before an error can reach durable state or logs. */
export function safeErrorDetail(error: unknown, fallback = "Task worker failed"): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const redacted = source
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/giu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\b(?:(?:sk|xox)_|sk-(?:proj-|ant-)?|github_pat_|gh[pousr]_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9._~+/-]+/gu, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted]")
    .replace(/\bhttps?:\/\/[^\s/:@]{1,128}:[^\s/@]{4,256}@/giu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return (redacted || fallback).slice(0, MAX_SAFE_ERROR_DETAIL_CHARACTERS);
}
