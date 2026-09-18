/** Enforces sibling, deployment, and published-interface prerequisites before decomposed work may advance. */

import type { DatabaseSync } from "node:sqlite";
import type {
  AgentRole,
  CrossRepoContext,
  PublishedInterfaceFailureReason,
  NodeStage,
  WorkItemPhase,
  WorkItemState,
} from "#shared/task-board-contract";
import { WORK_ITEM_TERMINAL_STATES, isTerminalWorkItemState } from "#shared/task-board-contract";
import { WORK_ITEM_REPOSITORY_NAME_SQL, WORK_ITEM_REPOSITORY_PATH_SQL } from "../persistence/repository-path.js";
import { PUBLISHED_INTERFACE_PATH, type PublishedInterfaceReadResult } from "./interface-context.js";

export interface DecompositionReadinessBlocker {
  readonly workItemId: string;
  readonly phase: WorkItemPhase | null;
  readonly state: WorkItemState;
  readonly deployAttested: boolean;
}

export interface MigrateInterfaceProvider {
  readonly workItemId: string;
  readonly projectId: string;
  readonly repoName: string;
  readonly repoPath: string;
  readonly sha: string;
}

export type MigrateInterfaceReadiness =
  | Readonly<{ kind: "ready"; context: CrossRepoContext }>
  | Readonly<{
      kind: "blocked";
      reason: Exclude<PublishedInterfaceFailureReason, "over_budget">;
      sha: string;
      summary: string;
    }>;

export type PublishedInterfaceReader = (
  repoPath: string,
  sha: string,
  path: typeof PUBLISHED_INTERFACE_PATH
) => PublishedInterfaceReadResult;

const FAILED_TERMINAL_WORK_ITEM_STATES = WORK_ITEM_TERMINAL_STATES.filter((state) => state !== "merged");
const FAILED_TERMINAL_WORK_ITEM_STATES_SQL = FAILED_TERMINAL_WORK_ITEM_STATES.map((state) => `'${state}'`).join(",");

export function isFailedTerminalWorkItemState(state: WorkItemState): boolean {
  return state !== "merged" && isTerminalWorkItemState(state);
}

/** Mirrors the claim-side role gate for published provider context. */
export function migrateTaskCarriesCrossRepoContext(
  nodeStage: NodeStage | string,
  assignedRole: AgentRole | string | null
): boolean {
  return nodeStage === "implementation" && assignedRole === "engineer";
}

/** The parent row and every child row form one project-scoped family. */
export function decompositionFamilyTouchesProjectSql(
  parentWorkItemIdExpression: string,
  projectIdExpression: string
): string {
  return `EXISTS(
    SELECT 1
    FROM work_items family_member
    WHERE (
      family_member.work_item_id=${parentWorkItemIdExpression}
      OR family_member.parent_work_item_id=${parentWorkItemIdExpression}
    )
      AND family_member.resolved_project_id=${projectIdExpression}
  )`;
}

/**
 * Returns the first child that prevents this child from starting. Contract
 * readiness is sibling-wide for phased parents: every non-Contract child under
 * the parent must be merged and deploy-attested, including siblings that ended
 * abandoned or dead-lettered. Unphased dependencies express merge order only,
 * so they never block child activation.
 */
export function decompositionReadinessBlocker(
  db: DatabaseSync,
  workItemId: string
): DecompositionReadinessBlocker | null {
  const owner = db
    .prepare(
      `
    SELECT owner.parent_work_item_id,owner.phase,
      EXISTS(
        SELECT 1
        FROM work_items sibling
        WHERE sibling.parent_work_item_id=owner.parent_work_item_id
          AND sibling.phase IS NOT NULL
      ) AS parent_is_phased
    FROM work_items owner
    WHERE owner.work_item_id=?
  `
    )
    .get(workItemId) as
    | Readonly<{
        parent_work_item_id: string | null;
        phase: WorkItemPhase | null;
        parent_is_phased: number;
      }>
    | undefined;
  if (owner === undefined || owner.parent_work_item_id === null) return null;
  if (owner.parent_is_phased !== 1) return null;
  const row =
    owner.phase === "contract"
      ? db
          .prepare(
            `
        SELECT sibling.work_item_id,sibling.phase,sibling.state,
          EXISTS(
            SELECT 1 FROM gate_actions attestation
            WHERE attestation.work_item_id=sibling.work_item_id
              AND attestation.gate='deploy_attest'
          ) AS deploy_attested
        FROM work_items sibling
        WHERE sibling.parent_work_item_id=?
          AND sibling.phase<>'contract'
          AND (
            sibling.state<>'merged'
            OR NOT EXISTS(
              SELECT 1 FROM gate_actions attestation
              WHERE attestation.work_item_id=sibling.work_item_id
                AND attestation.gate='deploy_attest'
            )
          )
        ORDER BY
          CASE
            WHEN sibling.state IN (${FAILED_TERMINAL_WORK_ITEM_STATES_SQL}) THEN 0
            WHEN sibling.state<>'merged' THEN 1
            ELSE 2
          END,
          sibling.child_ordinal,
          sibling.work_item_id
        LIMIT 1
      `
          )
          .get(owner.parent_work_item_id)
      : db
          .prepare(
            `
        SELECT predecessor.work_item_id,predecessor.phase,predecessor.state,0 AS deploy_attested
        FROM work_item_dependencies dependency
        JOIN work_items predecessor
          ON predecessor.work_item_id=dependency.depends_on_work_item_id
        WHERE dependency.work_item_id=? AND predecessor.state<>'merged'
        ORDER BY predecessor.child_ordinal,predecessor.work_item_id
        LIMIT 1
      `
          )
          .get(workItemId);
  if (row === undefined) return null;
  const blocker = row as Readonly<{
    work_item_id: string;
    phase: WorkItemPhase | null;
    state: WorkItemState;
    deploy_attested: number;
  }>;
  return Object.freeze({
    workItemId: blocker.work_item_id,
    phase: blocker.phase,
    state: blocker.state,
    deployAttested: blocker.deploy_attested === 1,
  });
}

/** Resolves the newest durable Expand merge used by a Migrate child. */
export function migrateInterfaceProvider(db: DatabaseSync, workItemId: string): MigrateInterfaceProvider | null {
  const provider = db
    .prepare(
      `
    SELECT work_item.work_item_id,work_item.state,
      work_item.resolved_project_id AS project_id,
      ${WORK_ITEM_REPOSITORY_NAME_SQL} AS repository_name,
      ${WORK_ITEM_REPOSITORY_PATH_SQL} AS repository_path,
      (
        SELECT action.merge_sha
        FROM gate_actions action
        WHERE action.work_item_id=work_item.work_item_id
          AND action.gate='final_approve'
          AND action.merge_sha IS NOT NULL
        ORDER BY action.created_at DESC,action.rowid DESC
        LIMIT 1
      ) AS merge_sha
    FROM work_item_dependencies dependency
    JOIN work_items owner ON owner.work_item_id=dependency.work_item_id AND owner.phase='migrate'
    JOIN work_items work_item
      ON work_item.work_item_id=dependency.depends_on_work_item_id
      AND work_item.phase='expand'
    WHERE dependency.work_item_id=?
    ORDER BY work_item.child_ordinal,work_item.work_item_id
    LIMIT 1
  `
    )
    .get(workItemId) as
    | Readonly<{
        work_item_id: string;
        state: WorkItemState;
        project_id: string;
        repository_name: string;
        repository_path: string;
        merge_sha: string | null;
      }>
    | undefined;
  if (provider === undefined || provider.state !== "merged" || provider.merge_sha === null) return null;
  return Object.freeze({
    workItemId: provider.work_item_id,
    projectId: provider.project_id,
    repoName: provider.repository_name,
    repoPath: provider.repository_path,
    sha: provider.merge_sha,
  });
}

export function publishedInterfaceBlockSummary(
  result: Exclude<PublishedInterfaceReadResult, { kind: "present" }>,
  sha: string
): string {
  if (result.reason === "invalid_markdown" && result.detail === "invalid_utf8") {
    return `blocked: provider docs/interface.md contains invalid UTF-8 at ${sha}; cancel the parent to abandon the decomposition`;
  }
  return publishedInterfaceReasonSummary(result.reason, sha);
}

export function publishedInterfaceFailureLabel(
  result: Exclude<PublishedInterfaceReadResult, { kind: "present" }>
): string {
  if (result.reason === "invalid_markdown") {
    return result.detail === "invalid_utf8" ? "invalid UTF-8" : "prohibited characters";
  }
  return result.reason;
}

export function publishedInterfaceReasonSummary(
  reason: PublishedInterfaceFailureReason,
  sha: string,
  assembledBytes?: number,
  budgetBytes?: number
): string {
  switch (reason) {
    case "absent":
      return `blocked: provider published no docs/interface.md at ${sha}; cancel the parent to abandon the decomposition`;
    case "too_large":
      return `blocked: provider docs/interface.md exceeds 64 KiB at ${sha}; cancel the parent to abandon the decomposition`;
    case "not_file":
      return `blocked: provider docs/interface.md is not a file at ${sha}; cancel the parent to abandon the decomposition`;
    case "invalid_markdown":
      return `blocked: provider docs/interface.md contains prohibited characters at ${sha}; cancel the parent to abandon the decomposition`;
    case "empty":
      return `blocked: provider docs/interface.md is empty at ${sha}; cancel the parent to abandon the decomposition`;
    case "read_error":
      return `blocked: provider repository unreadable at ${sha} — retrying`;
    case "over_budget":
      if (assembledBytes === undefined || budgetBytes === undefined) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:migrate_context_budget_missing");
      }
      return `blocked: assembled context ${Math.ceil(assembledBytes / 1_024)} KiB exceeds ${Math.floor(budgetBytes / 1_024)} KiB budget`;
  }
}

/** Evaluates the interface-specific portion of Migrate decomposition readiness. */
export function migrateInterfaceReadiness(
  db: DatabaseSync,
  workItemId: string,
  read: PublishedInterfaceReader
): MigrateInterfaceReadiness | null {
  const provider = migrateInterfaceProvider(db, workItemId);
  if (provider === null) return null;
  let published: PublishedInterfaceReadResult;
  try {
    published = read(provider.repoPath, provider.sha, PUBLISHED_INTERFACE_PATH);
  } catch {
    published = Object.freeze({ kind: "blocked", reason: "read_error" });
  }
  if (published.kind !== "present") {
    return Object.freeze({
      kind: "blocked",
      reason: published.reason,
      sha: provider.sha,
      summary: publishedInterfaceBlockSummary(published, provider.sha),
    });
  }
  return Object.freeze({
    kind: "ready",
    context: Object.freeze({
      providerProjectId: provider.projectId,
      providerWorkItemId: provider.workItemId,
      providerRepoName: provider.repoName,
      interfacePath: PUBLISHED_INTERFACE_PATH,
      sha: provider.sha,
      markdown: published.markdown,
    }),
  });
}
