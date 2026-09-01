/** Validates the scalar shapes every other boundary is built from. */

/* —— Imports —— */

import { ContractValidationError, IDENTIFIER_PATTERN } from "../index.js";

/* —— Scalar validation —— */

export type JsonRecord = Record<string, unknown>;
export { ContractValidationError };

export interface ExactMessageMap {
  readonly unexpected: (label: string, field: string) => string;
  readonly missing: (label: string, field: string) => string;
}

export const GENERIC_EXACT_MESSAGES: ExactMessageMap = Object.freeze({
  unexpected: (label: string) => `${label} has unexpected or missing fields`,
  missing: (label: string) => `${label} has unexpected or missing fields`,
});

export const NAMED_EXACT_MESSAGES: ExactMessageMap = Object.freeze({
  unexpected: (label: string, field: string) => `${label} has unexpected field ${field}`,
  missing: (label: string, field: string) => `${label} is missing field ${field}`,
});

export const PATH_EXACT_MESSAGES: ExactMessageMap = Object.freeze({
  unexpected: (label: string, field: string) => `${label}.${field} is not supported`,
  missing: (label: string, field: string) => `${label}.${field} is required`,
});

interface FieldSetOptions {
  readonly messages?: ExactMessageMap;
  readonly required?: readonly string[];
}

export function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractValidationError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

// Unexpected keys follow received order; missing keys follow required-field order.
export function exact(
  value: unknown,
  fields: readonly string[],
  label: string,
  options: FieldSetOptions = {}
): JsonRecord {
  const item = record(value, label);
  const messages = options.messages ?? GENERIC_EXACT_MESSAGES;
  const permitted = new Set(fields);
  const unexpected = Object.keys(item).find((key) => !permitted.has(key));
  if (unexpected !== undefined) throw new ContractValidationError(messages.unexpected(label, unexpected));
  const required = options.required ?? fields;
  const missing = required.find((key) => !(key in item));
  if (missing !== undefined) throw new ContractValidationError(messages.missing(label, missing));
  return item;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ContractValidationError(`${label} must be a string`);
  return value;
}

export interface ScalarMessageProfile {
  readonly stringType: (label: string) => string;
  readonly integerAtLeast: (label: string, minimum: number) => string;
}

// Browser responses preserve their historical scalar error wording for compatibility.
export const BROWSER_SCALAR_MESSAGES: ScalarMessageProfile = Object.freeze({
  stringType: (label: string) => `${label} must be a string`,
  integerAtLeast: (label: string, minimum: number) => `${label} must be a safe integer of at least ${minimum}`,
});

interface TextOptions {
  readonly maximum?: number;
  readonly allowEmpty?: boolean;
  readonly trim?: boolean;
  readonly message?: string;
  readonly scalarMessages?: ScalarMessageProfile;
  // normalizeCarriageReturns in task-worker/worker.ts normalizes production
  // writes before the outbound worker client sends them.
  readonly carriageReturns?: "reject" | "normalize" | "preserve";
}

// Human-entered board text is trimmed at the boundary and rejects control characters.
export function text(value: unknown, label: string, options: TextOptions = {}): string {
  const maximum = options.maximum ?? 8_000;
  if (typeof value !== "string") {
    throw new ContractValidationError(
      options.scalarMessages?.stringType(label) ?? options.message ?? `${label} is invalid`
    );
  }
  const carriageReturns = options.carriageReturns ?? "reject";
  const normalized = carriageReturns === "normalize" ? value.replace(/\r\n?/gu, "\n") : value;
  const parsed = options.trim === false ? normalized : normalized.trim();
  const controlPattern =
    carriageReturns !== "reject"
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
      : /[\u0000-\u0008\u000b-\u001f\u007f]/u;
  if ((!options.allowEmpty && parsed.length === 0) || normalized.length > maximum || controlPattern.test(normalized)) {
    throw new ContractValidationError(options.message ?? `${label} is invalid`);
  }
  return parsed;
}

interface ProseOptions {
  readonly maximum: number;
  readonly allowEmpty?: boolean;
  // Worker-authored text is normalized immediately before board writes.
  readonly carriageReturns?: "reject" | "normalize" | "preserve";
  readonly message?: string;
  readonly scalarMessages?: ScalarMessageProfile;
}

// Worker providers may emit carriage returns, while persisted contract prose stays whitespace-stable.
export function prose(value: unknown, label: string, options: ProseOptions): string {
  const parsed = text(value, label, {
    maximum: options.maximum,
    allowEmpty: options.allowEmpty,
    trim: false,
    carriageReturns: options.carriageReturns,
    message: options.message,
    scalarMessages: options.scalarMessages,
  });
  if (parsed.trim() !== parsed) throw new ContractValidationError(options.message ?? `${label} is invalid`);
  return parsed;
}

const IDENTIFIER = new RegExp(IDENTIFIER_PATTERN, "u");

export function identifier(
  value: unknown,
  label: string,
  message = `${label} is invalid`,
  scalarMessages?: ScalarMessageProfile
): string {
  if (typeof value !== "string") throw new ContractValidationError(scalarMessages?.stringType(label) ?? message);
  if (!IDENTIFIER.test(value)) throw new ContractValidationError(message);
  return value;
}

export function timestamp(
  value: unknown,
  label: string,
  message = `${label} must be a timestamp`,
  canonical = false,
  scalarMessages?: ScalarMessageProfile
): string {
  if (typeof value !== "string") throw new ContractValidationError(scalarMessages?.stringType(label) ?? message);
  if (Number.isNaN(Date.parse(value))) throw new ContractValidationError(message);
  if (canonical && new Date(value).toISOString() !== value) throw new ContractValidationError(message);
  return value;
}

export function contractMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  message = `${label} is invalid`,
  scalarMessages?: ScalarMessageProfile
): Values[number] {
  if (typeof value !== "string") throw new ContractValidationError(scalarMessages?.stringType(label) ?? message);
  if (!(values as readonly string[]).includes(value)) throw new ContractValidationError(message);
  return value as Values[number];
}

export function contractSetMember<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
  message = `${label} has an unsupported value`
): T {
  const parsed = stringValue(value, label);
  if (!values.has(parsed as T)) throw new ContractValidationError(message);
  return parsed as T;
}

export function booleanValue(value: unknown, label: string, message = `${label} must be a boolean`): boolean {
  if (typeof value !== "boolean") throw new ContractValidationError(message);
  return value;
}

export function integer(
  value: unknown,
  label: string,
  minimum = 0,
  message = `${label} must be a safe integer of at least ${minimum}`
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ContractValidationError(message);
  return Number(value);
}

export function boundedClaimText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const clean = value.trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, Math.max(1, maximum - 16)).trimEnd()}\n[truncated]`;
}

export function positiveClaimInteger(value: unknown, label: string): number {
  return integer(value, label, 1, `${label} is invalid`);
}

export function claimEstimateMinutes(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 15 || Number(value) > 10_080 || Number(value) % 15 !== 0) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

export function arrayOf<T>(value: unknown, label: string, parser: (item: unknown, label: string) => T): T[] {
  if (!Array.isArray(value)) throw new ContractValidationError(`${label} must be an array`);
  return value.map((item, index) => parser(item, `${label}[${index}]`));
}
