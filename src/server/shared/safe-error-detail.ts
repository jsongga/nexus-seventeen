import { redactForPersistence } from "./redact.js";

export const MAX_SAFE_ERROR_DETAIL_CHARACTERS = 2_000;

/** Scrubs credentials and control characters before an error can reach durable state or logs. */
export function safeErrorDetail(error: unknown, fallback = "Task worker failed"): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const redacted = redactForPersistence(source, MAX_SAFE_ERROR_DETAIL_CHARACTERS).trim();
  return redacted || redactForPersistence(fallback, MAX_SAFE_ERROR_DETAIL_CHARACTERS).trim();
}
