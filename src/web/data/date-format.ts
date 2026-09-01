/** Formats web timestamps consistently while preserving invalid raw values. */

const shortDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const yearDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const auditDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function formatDateTime(value: string, formatter: Intl.DateTimeFormat): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : formatter.format(parsed);
}

export function formatShortDateTime(value: string): string {
  return formatDateTime(value, shortDateTime);
}

export function formatYearDateTime(value: string): string {
  return formatDateTime(value, yearDateTime);
}

export function formatAuditDateTime(value: string): string {
  return formatDateTime(value, auditDateTime);
}
