import type { DatabaseSync } from "node:sqlite";
import type { WorkItemPhase, WorkItemState } from "#shared/task-board-contract";

export interface DecompositionReadinessBlocker {
  readonly workItemId: string;
  readonly phase: WorkItemPhase | null;
  readonly state: WorkItemState;
  readonly deployAttested: boolean;
}

/** The parent row and every child row form one project-scoped family. */
export function decompositionFamilyTouchesProjectSql(
  parentWorkItemIdExpression: string,
  projectIdExpression: string,
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
  workItemId: string,
): DecompositionReadinessBlocker | null {
  const owner = db.prepare(`
    SELECT owner.parent_work_item_id,owner.phase,
      EXISTS(
        SELECT 1
        FROM work_items sibling
        WHERE sibling.parent_work_item_id=owner.parent_work_item_id
          AND sibling.phase IS NOT NULL
      ) AS parent_is_phased
    FROM work_items owner
    WHERE owner.work_item_id=?
  `).get(workItemId) as Readonly<{
    parent_work_item_id: string | null;
    phase: WorkItemPhase | null;
    parent_is_phased: number;
  }> | undefined;
  if (owner === undefined || owner.parent_work_item_id === null) return null;
  if (owner.parent_is_phased !== 1) return null;
  const row = owner.phase === "contract"
    ? db.prepare(`
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
        ORDER BY sibling.child_ordinal,sibling.work_item_id
        LIMIT 1
      `).get(owner.parent_work_item_id)
    : db.prepare(`
        SELECT predecessor.work_item_id,predecessor.phase,predecessor.state,0 AS deploy_attested
        FROM work_item_dependencies dependency
        JOIN work_items predecessor
          ON predecessor.work_item_id=dependency.depends_on_work_item_id
        WHERE dependency.work_item_id=? AND predecessor.state<>'merged'
        ORDER BY predecessor.child_ordinal,predecessor.work_item_id
        LIMIT 1
      `).get(workItemId);
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
