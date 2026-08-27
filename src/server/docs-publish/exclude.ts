const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const GLOB_CHARACTER = /[*?[\]{}()!\\]/u;

export function validateExcludePattern(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.trim() !== value ||
    CONTROL_CHARACTER.test(value) || !value.endsWith("/**")
  ) {
    throw new Error(`${label} must use glob-lite <prefix>/** syntax`);
  }

  const prefix = value.slice(0, -3);
  const segments = prefix.split("/");
  if (
    prefix.length < 1 || prefix.startsWith("/") || prefix.endsWith("/") || GLOB_CHARACTER.test(prefix) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must use glob-lite <prefix>/** syntax`);
  }
  return value;
}
