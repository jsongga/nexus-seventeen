/** Withdraws or parks final approvals when their pipeline base branch advances or rewrites underneath them. */

import type { Row } from "../persistence/rows.js";
import { WORK_ITEM_REPOSITORY_PATH_SQL } from "../persistence/repository-path.js";
import { exactIsoTimestamp } from "../persistence/timestamps.js";
import type { GitTextRunner } from "../../shared/git.js";
import type { TaskBoardRuntime } from "./board-runtime.js";
import { inspectPipelineBaseAdvance } from "./pipeline-merge.js";
import { ProjectsCollaborator, runWorkflowGit } from "./projects.js";

interface BaseBranchCandidate {
  readonly workItemId: string;
  readonly version: number;
  readonly pipelineBranch: string;
  readonly baseSha: string;
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
    typeof row.repository_path !== "string"
  ) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:base_branch_poll_candidate");
  }
  return Object.freeze({
    workItemId: row.work_item_id,
    version: row.version,
    pipelineBranch: row.pipeline_branch,
    baseSha: row.base_sha,
    repoPath: row.repository_path,
  });
}

export class BaseBranchPollCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly projects: ProjectsCollaborator,
    private readonly git: GitTextRunner = runWorkflowGit
  ) {}

  sweepBaseBranch(now: string): BaseBranchSweepResult {
    if (!exactIsoTimestamp(now)) throw new Error("TASK_BOARD_CLOCK_INVALID");
    const rows = this.runtime.store.db
      .prepare(
        `
      SELECT
        work_item.work_item_id,
        work_item.version,
        work_item.pipeline_branch,
        work_item.base_sha,
        ${WORK_ITEM_REPOSITORY_PATH_SQL} AS repository_path
      FROM work_items work_item
      LEFT JOIN projects project ON project.project_id=work_item.resolved_project_id
      WHERE work_item.state='final_approval' AND work_item.pipeline_branch IS NOT NULL
      ORDER BY work_item.created_at,work_item.work_item_id
    `
      )
      .all() as Row[];
    let withdrawn = 0;
    let diverged = 0;
    for (const row of rows) {
      const workItemId = typeof row.work_item_id === "string" ? row.work_item_id : "unknown";
      try {
        const candidate = candidateFromRow(row);
        const target = inspectPipelineBaseAdvance({
          repoPath: candidate.repoPath,
          branch: candidate.pipelineBranch,
          baseSha: candidate.baseSha,
          git: this.git,
        });
        if (target.kind === "repo_busy" || target.kind === "unchanged") continue;

        if (target.kind === "advanced") {
          const note = `base branch advanced to ${target.head}; rebase onto it and re-verify`;
          const applied = this.projects.withdrawFinalApprovalForBaseAdvance({
            workItemId: candidate.workItemId,
            expectedVersion: candidate.version,
            expectedBaseSha: candidate.baseSha,
            head: target.head,
            note,
            now,
          });
          if (applied) withdrawn += 1;
          continue;
        }

        const applied = this.projects.parkFinalApprovalForBaseDivergence({
          workItemId: candidate.workItemId,
          expectedVersion: candidate.version,
          expectedBaseSha: candidate.baseSha,
          head: target.head,
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
