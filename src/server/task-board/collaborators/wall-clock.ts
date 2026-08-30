import type { WorkItemStage, WorkItemState } from "#shared/task-board-contract";
import type { Row } from "../persistence/rows.js";
import { exactIsoTimestamp } from "../persistence/timestamps.js";
import type { TaskBoardStore } from "../persistence/store.js";
import type { NotificationsCollaborator } from "./notifications.js";
import type { RunsCollaborator } from "./runs.js";
import type { TaskBoardRuntime } from "./runtime.js";
import { transitionWorkItemInTransaction } from "./work-item-transitions.js";

interface WallClockCandidate {
  readonly runId: string;
  readonly workItemId: string;
  readonly projectId: string;
  readonly nodeId: string | null;
  readonly attemptOrRunId: string;
  readonly stage: string;
  readonly runStartedAt: string;
  readonly state: WorkItemState;
}

interface CapAction {
  readonly category: "stage_cap_exceeded" | "task_cap_exceeded";
  readonly actor: Readonly<{ type: "system"; id: string }>;
  readonly reason: string;
}

export interface WallClockSweepResult {
  readonly suspended: number;
  readonly parked: number;
}

function timestampMilliseconds(value: unknown, source: string): number {
  if (typeof value !== "string" || !exactIsoTimestamp(value)) {
    throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${source}`);
  }
  return Date.parse(value);
}

function elapsedSeconds(startedAt: string, now: string): number {
  return Math.max(
    0,
    Math.floor(
      (timestampMilliseconds(now, "wall_clock_now") - timestampMilliseconds(startedAt, "wall_clock_started_at")) / 1_000
    )
  );
}

export function stageElapsedSeconds(db: TaskBoardStore["db"], nodeId: string, now: string): number | null {
  if (!exactIsoTimestamp(now)) throw new Error("TASK_BOARD_CLOCK_INVALID");
  const row = db
    .prepare(
      `
    SELECT MAX(created_at) AS started_at
    FROM project_events
    WHERE node_id=? AND event_type IN ('stage_started','stage_retry_ready')
  `
    )
    .get(nodeId) as Row | undefined;
  if (row === undefined || row.started_at === null) return null;
  if (typeof row.started_at !== "string") {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:stage_clock_started_at");
  }
  return elapsedSeconds(row.started_at, now);
}

export function taskActiveSeconds(db: TaskBoardStore["db"], workItemId: string, now: string): number {
  if (!exactIsoTimestamp(now)) throw new Error("TASK_BOARD_CLOCK_INVALID");
  const rows = db
    .prepare(
      `
    WITH resumed_epoch AS (
      SELECT MAX(resolved_at) AS resumed_at
      FROM park_records
      WHERE work_item_id=? AND resolution='resumed'
    ), item_tasks AS (
      SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?
      UNION
      SELECT task_id FROM work_item_design_tasks WHERE work_item_id=?
      UNION
      SELECT attempt.task_id
      FROM stage_attempts AS attempt
      JOIN work_nodes AS node ON node.node_id=attempt.node_id
      JOIN plan_revisions AS plan ON plan.plan_revision_id=node.plan_revision_id
      WHERE plan.work_item_id=?
    )
    SELECT run.started_at,run.ended_at
    FROM runs AS run
    JOIN item_tasks AS task ON task.task_id=run.task_id
    CROSS JOIN resumed_epoch AS epoch
    WHERE epoch.resumed_at IS NULL OR run.started_at>=epoch.resumed_at
    ORDER BY run.started_at,run.run_id
  `
    )
    .all(workItemId, workItemId, workItemId, workItemId) as Row[];
  let activeMilliseconds = 0;
  for (const row of rows) {
    if (typeof row.started_at !== "string") {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:task_run_started_at");
    }
    if (row.ended_at !== null && typeof row.ended_at !== "string") {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:task_run_ended_at");
    }
    const startedAt = timestampMilliseconds(row.started_at, "task_run_started_at");
    const endedAt = timestampMilliseconds(row.ended_at ?? now, "task_run_ended_at");
    activeMilliseconds += Math.max(0, endedAt - startedAt);
  }
  return Math.floor(activeMilliseconds / 1_000);
}

function candidateFromRow(row: Row): WallClockCandidate {
  if (
    typeof row.run_id !== "string" ||
    typeof row.work_item_id !== "string" ||
    typeof row.project_id !== "string" ||
    (row.node_id !== null && typeof row.node_id !== "string") ||
    typeof row.attempt_or_run_id !== "string" ||
    typeof row.stage !== "string" ||
    typeof row.run_started_at !== "string" ||
    typeof row.item_state !== "string"
  ) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:wall_clock_candidate");
  }
  return Object.freeze({
    runId: row.run_id,
    workItemId: row.work_item_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    attemptOrRunId: row.attempt_or_run_id,
    stage: row.stage,
    runStartedAt: row.run_started_at,
    state: row.item_state as WorkItemState,
  });
}

export class WallClockCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly runs: RunsCollaborator,
    private readonly notifications: NotificationsCollaborator
  ) {}

  sweepWallClockCaps(now: string): WallClockSweepResult {
    const { stageCapSeconds, taskCapSeconds } = this.runtime.config;
    if (stageCapSeconds === 0 && taskCapSeconds === 0) {
      return Object.freeze({ suspended: 0, parked: 0 });
    }
    if (!exactIsoTimestamp(now)) throw new Error("TASK_BOARD_CLOCK_INVALID");

    const candidates = (
      this.runtime.store.db
        .prepare(
          `
      -- Mirrors pipelineTemplateShape in src/shared/task-board-contract/index.ts.
      WITH pipeline_plans AS (
        SELECT plan.plan_revision_id,plan.work_item_id
        FROM plan_revisions AS plan
        JOIN work_items AS item ON item.work_item_id=plan.work_item_id
        WHERE plan.state='confirmed'
          AND (
            item.pipeline_branch IS NOT NULL
            OR (
              (SELECT COUNT(*) FROM work_nodes AS counted
                WHERE counted.plan_revision_id=plan.plan_revision_id) = 1
              AND EXISTS (
                SELECT 1
                FROM work_nodes AS shaped
                WHERE shaped.plan_revision_id=plan.plan_revision_id
                  AND (
                    (
                      json_array_length(shaped.stage_template_json)=2
                      AND json_extract(shaped.stage_template_json,'$[0]')='implementation'
                      AND json_extract(shaped.stage_template_json,'$[1]')='testing'
                    )
                    OR (
                      json_array_length(shaped.stage_template_json)=3
                      AND json_extract(shaped.stage_template_json,'$[0]')='implementation'
                      AND json_extract(shaped.stage_template_json,'$[1]')='testing'
                      AND json_extract(shaped.stage_template_json,'$[2]')='verification'
                    )
                  )
              )
            )
          )
      )
      SELECT
        run.run_id,
        plan.work_item_id,
        run.project_id,
        attempt.node_id,
        attempt.attempt_id AS attempt_or_run_id,
        attempt.stage,
        run.started_at AS run_started_at,
        item.state AS item_state
      FROM runs AS run
      JOIN stage_attempts AS attempt ON attempt.task_id=run.task_id
      JOIN pipeline_plans AS plan ON plan.plan_revision_id=(
        SELECT node.plan_revision_id FROM work_nodes AS node WHERE node.node_id=attempt.node_id
      )
      JOIN work_items AS item ON item.work_item_id=plan.work_item_id
      WHERE run.status='active' AND item.state<>'coordinating'

      UNION ALL

      SELECT
        run.run_id,
        planning.work_item_id,
        run.project_id,
        NULL AS node_id,
        run.run_id AS attempt_or_run_id,
        'planning' AS stage,
        run.started_at AS run_started_at,
        item.state AS item_state
      FROM runs AS run
      JOIN work_item_planning_tasks AS planning ON planning.task_id=run.task_id
      JOIN work_items AS item ON item.work_item_id=planning.work_item_id
      WHERE run.status='active' AND item.state<>'coordinating'

      UNION ALL

      SELECT
        run.run_id,
        design.work_item_id,
        run.project_id,
        NULL AS node_id,
        run.run_id AS attempt_or_run_id,
        'designing' AS stage,
        run.started_at AS run_started_at,
        item.state AS item_state
      FROM runs AS run
      JOIN work_item_design_tasks AS design ON design.task_id=run.task_id
      JOIN work_items AS item ON item.work_item_id=design.work_item_id
      WHERE run.status='active'
        AND item.state<>'coordinating'
        AND EXISTS (
          SELECT 1 FROM pipeline_plans AS plan WHERE plan.work_item_id=design.work_item_id
        )

      ORDER BY run_started_at,run_id
    `
        )
        .all() as Row[]
    ).map(candidateFromRow);
    // A planner has no confirmed plan (and therefore no pipeline identity) yet. It
    // is intentionally capped for every work item: a runaway planner is still a runaway.

    let suspended = 0;
    let parked = 0;
    for (const candidate of candidates) {
      try {
        const stageElapsed =
          candidate.nodeId === null
            ? elapsedSeconds(candidate.runStartedAt, now)
            : stageElapsedSeconds(this.runtime.store.db, candidate.nodeId, now);
        let action: CapAction | null = null;
        if (stageCapSeconds > 0 && stageElapsed !== null && stageElapsed > stageCapSeconds) {
          action = Object.freeze({
            category: "stage_cap_exceeded",
            actor: { type: "system" as const, id: "system:stage-cap" },
            reason: `stage cap exceeded: ${candidate.stage} ran ${stageElapsed}s (cap ${stageCapSeconds}s)`,
          });
        } else if (taskCapSeconds > 0) {
          const taskElapsed = taskActiveSeconds(this.runtime.store.db, candidate.workItemId, now);
          if (taskElapsed > taskCapSeconds) {
            action = Object.freeze({
              category: "task_cap_exceeded",
              actor: { type: "system" as const, id: "system:task-cap" },
              reason: `task cap exceeded: ${taskElapsed}s agent-active (cap ${taskCapSeconds}s)`,
            });
          }
        }
        if (action === null) continue;

        const applied = this.runtime.store.transaction(() => {
          const current = this.runtime.store.db
            .prepare(
              `
            SELECT run.status,item.state,item.current_stage
            FROM runs AS run
            JOIN work_items AS item ON item.work_item_id=?
            WHERE run.run_id=?
          `
            )
            .get(candidate.workItemId, candidate.runId) as Row | undefined;
          if (current === undefined || current.status !== "active" || current.state !== candidate.state) {
            return null;
          }
          const currentStage = current.current_stage;
          if (currentStage !== null && typeof currentStage !== "string") {
            throw new Error("TASK_BOARD_DATABASE_CORRUPT:wall_clock_current_stage");
          }
          if (this.runs.suspendActiveRunInTransaction(candidate.runId, action.reason, action.actor) === null) {
            return null;
          }
          const transition = transitionWorkItemInTransaction(this.runtime.store, {
            workItemId: candidate.workItemId,
            to: "parked",
            actorType: "system",
            actorId: action.actor.id,
            now,
            currentStage: currentStage as WorkItemStage | null,
            park: { category: action.category, reason: action.reason },
          });
          this.notifications.insertNotificationAtInTransaction(
            {
              kind: "cap_parked",
              dedupeKey: `cap_parked:${candidate.workItemId}:${candidate.attemptOrRunId}`,
              projectId: candidate.projectId,
              workItemId: candidate.workItemId,
              summary: `Work item parked: ${action.reason}`,
            },
            now
          );
          return Object.freeze({ parked: transition.fromState !== "parked" });
        });
        if (applied === null) continue;
        suspended += 1;
        if (applied.parked) parked += 1;
      } catch (error) {
        console.error(`[task-board] wall-clock cap sweep failed for work item ${candidate.workItemId}`, error);
      }
    }
    return Object.freeze({ suspended, parked });
  }
}
