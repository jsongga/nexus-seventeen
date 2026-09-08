import {
  type FindingsLedger,
  type ParkRecord,
  type ParksLedger,
  type ReviewFinding,
} from "#shared/task-board-contract";
import { parseParkRecord, parseReviewFindingEntity } from "#shared/task-board-contract/validate";
import { nullableString, numberValue, stringValue, type Row } from "../persistence/rows.js";
import type { TaskBoardRuntime } from "./board-runtime.js";
import { workItemTitleProjection } from "./work-items.js";

const PARK_RECORDS_SINCE = "2026-08-20";

function findingFromRow(row: Row): ReviewFinding & Readonly<{ workItemId: string }> {
  const finding = parseReviewFindingEntity(
    {
      findingId: row.finding_id,
      nodeId: row.node_id,
      stage: row.stage,
      round: numberValue(row, "round"),
      file: row.file,
      line: row.line === null ? null : numberValue(row, "line"),
      category: row.category,
      severity: row.severity,
      expected: row.expected,
      actual: row.actual,
      blocking: numberValue(row, "blocking") === 1,
      createdAt: row.created_at,
    },
    "reviewFinding"
  );
  return Object.freeze({ ...finding, workItemId: stringValue(row, "work_item_id") });
}

function parkFromRow(row: Row): ParkRecord & Readonly<{ workItemTitle: string }> {
  const park = parseParkRecord(
    {
      parkRecordId: row.park_record_id,
      workItemId: row.work_item_id,
      category: row.category,
      reason: row.reason,
      parkedAt: row.parked_at,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
    },
    "parkRecord"
  );
  return Object.freeze({
    ...park,
    workItemTitle: workItemTitleProjection({
      originalRequest: stringValue(row, "original_request"),
      refinedObjective: nullableString(row, "refined_objective"),
    }),
  });
}

export class LedgersCollaborator {
  constructor(private readonly runtime: TaskBoardRuntime) {}

  findingsLedger(projectId?: string): FindingsLedger {
    // These joins depend on the no-post-confirm-replanning invariant: one confirmed plan per work item.
    const projectFilter = projectId === undefined ? "" : "WHERE plan.project_id=?";
    const parameters = projectId === undefined ? [] : [projectId];
    const categories = (
      this.runtime.store.db
        .prepare(
          `
      SELECT finding.category, finding.severity, finding.blocking, COUNT(*) AS count
      FROM review_findings finding
      JOIN work_nodes node ON node.node_id=finding.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      ${projectFilter}
      GROUP BY finding.category, finding.severity, finding.blocking
      ORDER BY finding.category, finding.severity, finding.blocking
    `
        )
        .all(...parameters) as Row[]
    ).map((row) =>
      Object.freeze({
        category: stringValue(row, "category") as FindingsLedger["categories"][number]["category"],
        severity: stringValue(row, "severity") as FindingsLedger["categories"][number]["severity"],
        blocking: numberValue(row, "blocking") === 1,
        count: numberValue(row, "count"),
      })
    );
    const perProject = (
      this.runtime.store.db
        .prepare(
          `
      SELECT plan.project_id, finding.category, COUNT(*) AS count
      FROM review_findings finding
      JOIN work_nodes node ON node.node_id=finding.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      ${projectFilter}
      GROUP BY plan.project_id, finding.category
      ORDER BY plan.project_id, finding.category
    `
        )
        .all(...parameters) as Row[]
    ).map((row) =>
      Object.freeze({
        projectId: stringValue(row, "project_id"),
        category: stringValue(row, "category") as FindingsLedger["perProject"][number]["category"],
        count: numberValue(row, "count"),
      })
    );
    const recent = (
      this.runtime.store.db
        .prepare(
          `
      SELECT finding.*, item.work_item_id
      FROM review_findings finding
      JOIN work_nodes node ON node.node_id=finding.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      ${projectFilter}
      ORDER BY finding.created_at DESC, finding.rowid DESC
      LIMIT 50
    `
        )
        .all(...parameters) as Row[]
    ).map(findingFromRow);
    return Object.freeze({
      categories: Object.freeze(categories),
      perProject: Object.freeze(perProject),
      recent: Object.freeze(recent),
    });
  }

  parksLedger(): ParksLedger {
    const select = `
      SELECT park.*, item.original_request, item.refined_objective
      FROM park_records park
      JOIN work_items item ON item.work_item_id=park.work_item_id
    `;
    const open = (
      this.runtime.store.db
        .prepare(
          `
      ${select}
      WHERE park.resolved_at IS NULL
      ORDER BY park.parked_at, park.rowid
    `
        )
        .all() as Row[]
    ).map(parkFromRow);
    const resolved = (
      this.runtime.store.db
        .prepare(
          `
      ${select}
      WHERE park.resolved_at IS NOT NULL
      ORDER BY park.resolved_at DESC, park.rowid DESC
      LIMIT 100
    `
        )
        .all() as Row[]
    ).map(parkFromRow);
    return Object.freeze({
      open: Object.freeze(open),
      resolved: Object.freeze(resolved),
      recordsSince: PARK_RECORDS_SINCE,
    });
  }
}
