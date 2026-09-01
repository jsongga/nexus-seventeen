import type { DatabaseSync } from "node:sqlite";
import { defaultGitRunner, type GitRunner, type GitTextRunner, GIT_POLICY_FLAGS } from "../../shared/git.js";
import { checkDeclaredScopePaths } from "../../shared/scope-check.js";

const MID_RUN_ASSUMPTION_PREFIX = "ASSUMPTION: ";

const runPipelineInspectionGit: GitRunner = defaultGitRunner;

type Row = Record<string, unknown>;

export interface PipelineInspection {
  readonly commits: readonly { readonly sha: string; readonly subject: string }[];
  readonly diffstat: string;
  readonly filesTouched: readonly {
    readonly path: string;
    readonly status: "added" | "modified" | "deleted";
  }[];
  readonly scopeOk: boolean;
}

interface PipelineInspectionOptions {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly declaredScope: readonly string[];
  readonly git?: GitTextRunner;
}

export function inspectPipelineBranchSync(options: PipelineInspectionOptions): PipelineInspection {
  const git = options.git ?? runPipelineInspectionGit;
  const range = `${options.baseSha}..${options.branch}`;
  const fields = git([...GIT_POLICY_FLAGS, "-C", options.repoPath, "log", "--format=%H%x00%s", "-z", range, "--"])
    .split("\0")
    .filter((field) => field.length > 0);
  if (fields.length % 2 !== 0) throw new Error("git returned an invalid commit list");
  const commits: Array<{ sha: string; subject: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    commits.push({ sha: fields[index]!, subject: fields[index + 1]! });
  }
  const diffstat = git([...GIT_POLICY_FLAGS, "-C", options.repoPath, "diff", "--stat", range, "--"]);
  const nameStatusFields = git([
    ...GIT_POLICY_FLAGS,
    "-C",
    options.repoPath,
    "diff",
    "--no-renames",
    "--name-status",
    "-z",
    range,
    "--",
  ])
    .split("\0")
    .filter((field) => field.length > 0);
  if (nameStatusFields.length % 2 !== 0) throw new Error("git returned an invalid name-status list");
  const filesTouched: Array<{ path: string; status: "added" | "modified" | "deleted" }> = [];
  for (let index = 0; index < nameStatusFields.length; index += 2) {
    const rawStatus = nameStatusFields[index];
    const path = nameStatusFields[index + 1]!;
    const status =
      rawStatus === "A"
        ? "added"
        : rawStatus === "M" || rawStatus === "T"
          ? "modified"
          : rawStatus === "D"
            ? "deleted"
            : null;
    if (status === null) throw new Error(`git returned unsupported file status ${rawStatus ?? ""}`);
    filesTouched.push({ path, status });
  }
  const scope = checkDeclaredScopePaths(
    filesTouched.map((file) => file.path),
    options.declaredScope
  );
  return Object.freeze({
    commits: Object.freeze(commits.map((commit) => Object.freeze(commit))),
    diffstat,
    filesTouched: Object.freeze(filesTouched.map((file) => Object.freeze(file))),
    scopeOk: scope.ok,
  });
}

export async function inspectPipelineBranch(options: PipelineInspectionOptions): Promise<PipelineInspection> {
  return inspectPipelineBranchSync(options);
}

export function pipelineMidRunAssumptions(db: DatabaseSync, workItemId: string): readonly string[] {
  const handoffRows = db
    .prepare(
      `
    SELECT
      handoff.payload_json,handoff.stage,
      COALESCE(
        (
          SELECT event.actor_id
          FROM task_events event
          WHERE event.task_id=handoff.task_id AND event.event_type='task_run_settled'
          ORDER BY event.sequence DESC
          LIMIT 1
        ),
        (
          SELECT event.actor_id
          FROM task_events event
          WHERE event.task_id=handoff.task_id AND event.event_type='task_created'
          ORDER BY event.sequence
          LIMIT 1
        )
      ) AS author_id
    FROM stage_handoffs handoff
    JOIN work_nodes node ON node.node_id=handoff.node_id
    JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
    WHERE plan.work_item_id=?
    ORDER BY handoff.created_at,handoff.rowid
  `
    )
    .all(workItemId) as Row[];
  const evidence = handoffRows
    .filter(
      (handoffRow) =>
        handoffRow.stage === "implementation" &&
        handoffRow.author_id !== null &&
        !String(handoffRow.author_id).startsWith("system:")
    )
    .flatMap((handoffRow) => {
      const handoff = JSON.parse(String(handoffRow.payload_json)) as { evidence?: unknown };
      return Array.isArray(handoff.evidence)
        ? handoff.evidence.filter((entry): entry is string => typeof entry === "string")
        : [];
    });
  return Object.freeze([
    ...new Set(
      evidence
        .filter((candidate) => candidate.startsWith(MID_RUN_ASSUMPTION_PREFIX))
        .map((candidate) => candidate.slice(MID_RUN_ASSUMPTION_PREFIX.length).trim())
        .filter((candidate) => candidate.length > 0)
    ),
  ]);
}
