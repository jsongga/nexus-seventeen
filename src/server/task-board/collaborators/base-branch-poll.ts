import type { Row } from "../persistence/rows.js";
import { exactIsoTimestamp } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { GitRunner } from "./scope-check.js";
import type { NotificationsCollaborator } from "./notifications.js";
import {
  inspectPipelineMergeTarget,
  isPipelineBaseAncestor,
} from "./merge-executor.js";
import { ProjectsCollaborator, runWorkflowGit } from "./projects.js";

interface BaseBranchCandidate {
  readonly workItemId: string;
  readonly version: number;
  readonly pipelineBranch: string;
  readonly baseSha: string;
  readonly projectId: string;
  readonly repoPath: string;
}

export interface BaseBranchSweepResult {
  readonly withdrawn: number;
  readonly diverged: number;
}

function candidateFromRow(row: Row): BaseBranchCandidate {
  if (
    typeof row.work_item_id !== "string" ||
    typeof row.version !== "number" ||
    typeof row.pipeline_branch !== "string" ||
    typeof row.base_sha !== "string" ||
    typeof row.project_id !== "string" ||
    typeof row.repo_path !== "string"
  ) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:base_branch_poll_candidate");
  }
  return Object.freeze({
    workItemId: row.work_item_id,
    version: row.version,
    pipelineBranch: row.pipeline_branch,
    baseSha: row.base_sha,
    projectId: row.project_id,
    repoPath: row.repo_path,
  });
}

export class BaseBranchPollCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly projects: ProjectsCollaborator,
    private readonly notifications: NotificationsCollaborator,
    private readonly git: GitRunner = runWorkflowGit,
  ) {}

  sweepBaseBranch(now: string): BaseBranchSweepResult {
    if (!exactIsoTimestamp(now)) throw new Error("TASK_BOARD_CLOCK_INVALID");
    const rows = this.runtime.store.db.prepare(`
      SELECT
        item.work_item_id,
        item.version,
        item.pipeline_branch,
        item.base_sha,
        item.resolved_project_id AS project_id,
        project.description AS repo_path
      FROM work_items item
      LEFT JOIN projects project ON project.project_id=item.resolved_project_id
      WHERE item.state='final_approval' AND item.pipeline_branch IS NOT NULL
      ORDER BY item.created_at,item.work_item_id
    `).all() as Row[];
    let withdrawn = 0;
    let diverged = 0;
    for (const row of rows) {
      const workItemId = typeof row.work_item_id === "string" ? row.work_item_id : "unknown";
      try {
        const candidate = candidateFromRow(row);
        const target = inspectPipelineMergeTarget({
          repoPath: candidate.repoPath,
          branch: candidate.pipelineBranch,
          git: this.git,
        });
        if (target.kind === "repo_busy" || target.head === candidate.baseSha) continue;

        if (isPipelineBaseAncestor({
          repoPath: candidate.repoPath,
          baseSha: candidate.baseSha,
          target: target.head,
          git: this.git,
        })) {
          const note = `base branch advanced to ${target.head}; rebase onto it and re-verify`;
          const applied = this.projects.withdrawFinalApprovalForBaseAdvance({
            workItemId: candidate.workItemId,
            expectedVersion: candidate.version,
            expectedBaseSha: candidate.baseSha,
            head: target.head,
            note,
          }, () => {
            this.notifications.insertNotificationAtInTransaction({
              kind: "final_approval_withdrawn",
              dedupeKey: `final_approval_withdrawn:${candidate.workItemId}:${target.head}`,
              projectId: candidate.projectId,
              workItemId: candidate.workItemId,
              summary: `Final approval withdrawn: base branch advanced to ${target.head.slice(0, 10)}`,
            }, now);
          });
          if (applied) withdrawn += 1;
          continue;
        }

        const applied = this.projects.parkFinalApprovalForBaseDivergence({
          workItemId: candidate.workItemId,
          expectedVersion: candidate.version,
          expectedBaseSha: candidate.baseSha,
          reason: `base branch history rewritten (was ${candidate.baseSha}, now ${target.head})`,
          now,
        });
        if (applied) diverged += 1;
      } catch (error) {
        console.error(`[task-board] base-branch sweep failed for work item ${workItemId}`, error);
      }
    }
    return Object.freeze({ withdrawn, diverged });
  }
}
