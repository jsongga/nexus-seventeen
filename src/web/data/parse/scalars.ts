/** Reads the scalar shapes every wire record is built from, in the browser's tolerant profile. */

/* —— Imports —— */

import {
  BROWSER_SCALAR_MESSAGES,
  PATH_EXACT_MESSAGES,
  arrayOf,
  booleanValue,
  contractSetMember,
  exact,
  identifier as contractIdentifier,
  integer as contractInteger,
  prose,
  record as contractRecord,
  skillIdentifier as contractSkillIdentifier,
  stringValue,
  timestamp as contractTimestamp,
  type JsonRecord,
} from "@shared/task-board-contract/validate";

/* —— Scalars —— */

export const loose = {
  exact: false,
  identifiers: "string",
  projection: "browser",
  scalarMessages: BROWSER_SCALAR_MESSAGES,
  tolerantEnums: true,
} as const;

export const strict = {
  exact: PATH_EXACT_MESSAGES,
  identifierMessages: "valid-identifier",
  projection: "browser",
  scalarMessages: BROWSER_SCALAR_MESSAGES,
} as const;

export const ms = (value: string): number => Date.parse(value);

export const nullableMs = (value: string | null): number | null => (value === null ? null : ms(value));

export const withoutApiVersion = <T extends { apiVersion: unknown }>(item: T): Omit<T, "apiVersion"> => {
  const { apiVersion: _apiVersion, ...value } = item;
  return value;
};

export function record(value: unknown, path: string): JsonRecord {
  return contractRecord(value, path);
}

export function exactRecord(value: unknown, path: string, fields: readonly string[]): JsonRecord {
  return exact(value, fields, path, { messages: PATH_EXACT_MESSAGES });
}

export function string(value: unknown, path: string): string {
  return stringValue(value, path);
}

export function boundedText(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  return prose(value, path, {
    maximum,
    allowEmpty,
    message: `${path} must ${allowEmpty ? "" : "not be empty and "}contain at most ${maximum.toLocaleString()} characters`,
    scalarMessages: BROWSER_SCALAR_MESSAGES,
  });
}

export function integer(value: unknown, path: string, minimum = 0): number {
  return contractInteger(value, path, minimum);
}

export function array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  return arrayOf(value, path, parse);
}

export function identifier(value: unknown, path: string): string {
  return contractIdentifier(value, path, `${path} must be a valid identifier`, BROWSER_SCALAR_MESSAGES);
}

export function skillIdentifier(value: unknown, path: string): string {
  return contractSkillIdentifier(value, path, BROWSER_SCALAR_MESSAGES);
}

export function boolean(value: unknown, path: string): boolean {
  return booleanValue(value, path);
}

export function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : stringValue(value, path);
}

export function timestamp(value: unknown, path: string): string {
  return contractTimestamp(value, path, `${path} must be a timestamp`, false, BROWSER_SCALAR_MESSAGES);
}

export function member<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  return contractSetMember(value, values, path);
}
