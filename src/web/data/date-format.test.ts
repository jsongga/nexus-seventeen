import { describe, expect, it } from "vitest";
import { formatAuditDateTime, formatShortDateTime, formatYearDateTime } from "./date-format";

const validDate = "2026-08-29T16:05:06.000Z";
const invalidDate = "not-a-date";

describe("web date formatting", () => {
  it("preserves each existing display shape", () => {
    const parsed = new Date(validDate);
    expect(formatShortDateTime(validDate)).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(parsed)
    );
    expect(formatYearDateTime(validDate)).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(parsed)
    );
    expect(formatAuditDateTime(validDate)).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(parsed)
    );
  });

  it("returns an unparseable raw value from every formatter", () => {
    expect(formatShortDateTime(invalidDate)).toBe(invalidDate);
    expect(formatYearDateTime(invalidDate)).toBe(invalidDate);
    expect(formatAuditDateTime(invalidDate)).toBe(invalidDate);
  });
});
