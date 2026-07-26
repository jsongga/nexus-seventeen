import { createHash, timingSafeEqual } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function tokenMatches(expectedHash: string, supplied: string | undefined): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(sha256(supplied ?? ""), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
