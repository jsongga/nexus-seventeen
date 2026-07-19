import { createHash, timingSafeEqual } from "node:crypto";

function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers cannot be encoded");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Cyclic values cannot be encoded");
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = normalize(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Unsupported value type: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function tokenMatches(expected: string, supplied: string | undefined): boolean {
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  const suppliedHash = createHash("sha256").update(supplied ?? "", "utf8").digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}
