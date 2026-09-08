import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RawFindingsLedger, RawParksLedger } from "../data/parse";
import { findingCategoryCounts, FindingsLedgerSection, ParksLedgerSection } from "./LedgersPage";

const noon = "2026-08-21T12:00:00.000Z";

const findings: RawFindingsLedger = {
  categories: [
    { category: "correctness", severity: "major", blocking: true, count: 2 },
    { category: "correctness", severity: "minor", blocking: false, count: 3 },
    { category: "docs", severity: "critical", blocking: false, count: 1 },
  ],
  perProject: [
    { projectId: "project-one", category: "correctness", count: 5 },
    { projectId: "project-one", category: "docs", count: 1 },
  ],
  recent: [
    {
      findingId: "finding-one",
      nodeId: "node-one",
      stage: "verification",
      round: 2,
      file: "src/web/task-board/BoardApp.tsx",
      line: 42,
      category: "correctness",
      severity: "major",
      expected: "The notification disappears immediately.",
      actual: "The notification remained visible.",
      blocking: true,
      createdAt: noon,
      createdAtMs: Date.parse(noon),
      workItemId: "work-item-one",
    },
  ],
};

const parks: RawParksLedger = {
  recordsSince: "2026-08-20",
  open: [
    {
      parkRecordId: "park-newer",
      workItemId: "work-item-newer",
      workItemTitle: "Newer parked item",
      category: "bright_line",
      reason: "A newer operator decision is required.",
      parkedAt: "2026-08-21T11:30:00.000Z",
      parkedAtMs: Date.parse("2026-08-21T11:30:00.000Z"),
      resolvedAt: null,
      resolvedAtMs: null,
      resolution: null,
    },
    {
      parkRecordId: "park-older",
      workItemId: "work-item-older",
      workItemTitle: "Older parked item",
      category: "open_question",
      reason: "The oldest question still needs an answer.",
      parkedAt: "2026-08-20T10:00:00.000Z",
      parkedAtMs: Date.parse("2026-08-20T10:00:00.000Z"),
      resolvedAt: null,
      resolvedAtMs: null,
      resolution: null,
    },
  ],
  resolved: [
    {
      parkRecordId: "park-resolved",
      workItemId: "work-item-resolved",
      workItemTitle: "Resolved parked item",
      category: "scope_violation",
      reason: "The declared scope was corrected.",
      parkedAt: "2026-08-20T09:00:00.000Z",
      parkedAtMs: Date.parse("2026-08-20T09:00:00.000Z"),
      resolvedAt: "2026-08-21T10:00:00.000Z",
      resolvedAtMs: Date.parse("2026-08-21T10:00:00.000Z"),
      resolution: "resumed",
    },
  ],
};

describe("ledgers page panels", () => {
  it("reduces mixed severities and blocking findings into exact per-category counts", () => {
    const mixedFindings: RawFindingsLedger = {
      ...findings,
      categories: [
        { category: "correctness", severity: "minor", blocking: false, count: 2 },
        { category: "correctness", severity: "major", blocking: true, count: 3 },
        { category: "correctness", severity: "critical", blocking: false, count: 5 },
        { category: "docs", severity: "minor", blocking: true, count: 7 },
        { category: "docs", severity: "critical", blocking: true, count: 11 },
      ],
    };

    expect(findingCategoryCounts(mixedFindings)).toEqual([
      {
        category: "correctness",
        total: 10,
        minor: 2,
        major: 3,
        critical: 5,
        other: 0,
        blocking: 3,
      },
      {
        category: "docs",
        total: 18,
        minor: 7,
        major: 0,
        critical: 11,
        other: 0,
        blocking: 18,
      },
    ]);
  });

  it("renders the category count table and expandable linked recent findings", () => {
    const markup = renderToStaticMarkup(createElement(FindingsLedgerSection, { ledger: findings }));

    for (const text of [
      "Review findings",
      "Category",
      "Minor",
      "Major",
      "Critical",
      "Blocking",
      "Correctness findings",
      "The notification disappears immediately.",
      "src/web/task-board/BoardApp.tsx:42",
      "Open request work-item-one",
    ])
      expect(markup).toContain(text);
    expect(markup).toContain('href="#/intake/work-item-one"');
    expect(markup).toContain("<details");
  });

  it("renders age-sorted open parks, resolution history, links, and the exact history notice", () => {
    const markup = renderToStaticMarkup(
      createElement(ParksLedgerSection, {
        ledger: parks,
        nowMs: Date.parse(noon),
      })
    );

    expect(markup).toContain("Park records begin 2026-08-20; older parks have no ledger entry.");
    expect(markup).toContain("1d 2h");
    expect(markup).toContain("30m");
    expect(markup.indexOf("Older parked item")).toBeLessThan(markup.indexOf("Newer parked item"));
    expect(markup).toContain("Resolution history");
    expect(markup).toContain("Resolved parked item");
    expect(markup).toContain("Resumed");
    expect(markup).toContain('href="#/intake/work-item-resolved"');
  });

  it("renders explicit empty states for both datasets", () => {
    const findingsMarkup = renderToStaticMarkup(
      createElement(FindingsLedgerSection, {
        ledger: { categories: [], perProject: [], recent: [] },
      })
    );
    const parksMarkup = renderToStaticMarkup(
      createElement(ParksLedgerSection, {
        ledger: { open: [], resolved: [], recordsSince: "2026-08-20" },
      })
    );

    expect(findingsMarkup).toContain("No review findings have been recorded.");
    expect(parksMarkup).toContain("No requests are currently parked.");
    expect(parksMarkup).toContain("No park resolutions have been recorded.");
  });
});
