import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConfirmPlanRevisionRequest,
  ClaimRunResult,
  CreatePlanRevisionRequest,
  PlanRevision,
  ProjectEvent,
  StageHandoff,
  StageHandoffDraft,
  WorkNode,
  WorkflowStage,
} from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";
import { SkillRegistry } from "./skills.js";

type Row = Record<string, unknown>;
const STAGES = new Set<WorkflowStage>(["research", "planning", "implementation", "testing", "verification"]);
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

function text(value: unknown, field: string, max = 8_000): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > max) {
    throw new TaskBoardError(400, "WORKFLOW_INVALID", `${field} is invalid`);
  }
  return value;
}
function list(value: unknown, field: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max) throw new TaskBoardError(400, "WORKFLOW_INVALID", `${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 4_000));
}
function json<T>(value: unknown): T { return JSON.parse(String(value)) as T; }

function planFromRow(row: Row): PlanRevision {
  return Object.freeze({
    apiVersion: "steward.task-board/v1", planRevisionId: String(row.plan_revision_id),
    workItemId: String(row.work_item_id), revision: Number(row.revision), objective: String(row.objective),
    assumptions: Object.freeze(json<string[]>(row.assumptions_json)),
    acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
    projectId: String(row.project_id), skillDigests: Object.freeze(json<Record<string, string>>(row.skill_digests_json)),
    state: row.state as PlanRevision["state"], createdBy: String(row.created_by),
    confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by),
    createdAt: String(row.created_at), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
  });
}

export interface ProjectWorkflowSnapshot {
  readonly plans: readonly PlanRevision[];
  readonly nodes: readonly WorkNode[];
  readonly handoffs: readonly StageHandoff[];
  readonly events: readonly ProjectEvent[];
}

export class TransparentWorkflow {
  constructor(
    readonly db: DatabaseSync,
    readonly skills: SkillRegistry,
    readonly now: () => Date,
    readonly transaction: <T>(operation: () => T) => T,
    readonly onEvent?: (event: ProjectEvent) => void,
  ) {}

  propose(raw: CreatePlanRevisionRequest, actor: string): ProjectWorkflowSnapshot {
    const workItemId = text(raw.workItemId, "workItemId", 128);
    const projectId = text(raw.projectId, "projectId", 128);
    const objective = text(raw.objective, "objective");
    const assumptions = list(raw.assumptions, "assumptions");
    const acceptance = list(raw.acceptanceCriteria, "acceptanceCriteria");
    if (acceptance.length === 0 || !Array.isArray(raw.nodes) || raw.nodes.length < 1 || raw.nodes.length > 128) {
      throw new TaskBoardError(400, "WORKFLOW_INVALID", "A plan needs criteria and bounded nodes");
    }
    if (!this.db.prepare("SELECT 1 FROM work_items WHERE work_item_id = ?").get(workItemId)) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    if (!this.db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId)) throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    const snapshots = this.skills.loadSync(raw.skillIds);
    const skillDigests = Object.fromEntries(snapshots.map((skill) => [skill.skillId, skill.digest]));
    const ids = new Set<string>();
    const nodes = raw.nodes.map((node, index) => {
      const nodeId = text(node.nodeId, `nodes[${index}].nodeId`, 128);
      if (!ID.test(nodeId) || ids.has(nodeId)) throw new TaskBoardError(400, "WORKFLOW_INVALID", "Node IDs must be unique identifiers");
      ids.add(nodeId);
      const stages = node.stageTemplate.map((stage: WorkflowStage) => {
        if (!STAGES.has(stage)) throw new TaskBoardError(400, "WORKFLOW_INVALID", "Node stage is invalid");
        return stage;
      });
      if (stages.length === 0 || stages.at(-1) !== "verification" || new Set(stages).size !== stages.length) {
        throw new TaskBoardError(400, "WORKFLOW_INVALID", "Every node needs unique ordered stages ending in verification");
      }
      return { nodeId, title: text(node.title, "node.title", 256), objective: text(node.objective, "node.objective"), acceptanceCriteria: list(node.acceptanceCriteria, "node.acceptanceCriteria"), dependencyNodeIds: [...node.dependencyNodeIds], stages };
    });
    for (const node of nodes) for (const dependency of node.dependencyNodeIds) if (!ids.has(dependency) || dependency === node.nodeId) throw new TaskBoardError(400, "WORKFLOW_INVALID", "Dependency is invalid");
    const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const visit = (id: string) => { if (visiting.has(id)) throw new TaskBoardError(400, "WORKFLOW_CYCLE", "Task dependencies contain a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)!.dependencyNodeIds) visit(dep); visiting.delete(id); visited.add(id); };
    for (const id of ids) visit(id);
    const createdAt = this.now().toISOString();
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state='confirmed'").get(workItemId)) {
        throw new TaskBoardError(409, "PLAN_REVISION_UNSUPPORTED", "Confirmed workflows cannot be revised in this version");
      }
      const revision = Number(this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM plan_revisions WHERE work_item_id=?").get(workItemId)?.revision);
      const planId = `plan_${randomUUID()}`;
      const storedIds = new Map(nodes.map((node) => [node.nodeId, `node_${randomUUID()}`]));
      this.db.prepare("UPDATE plan_revisions SET state='superseded' WHERE work_item_id=? AND state='proposed'").run(workItemId);
      this.db.prepare("INSERT INTO plan_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(planId, workItemId, revision, objective, JSON.stringify(assumptions), JSON.stringify(acceptance), projectId, JSON.stringify(skillDigests), "proposed", actor, null, createdAt, null);
      for (const node of nodes) {
        const storedId = storedIds.get(node.nodeId)!;
        this.db.prepare("INSERT INTO work_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(storedId, planId, projectId, node.title, node.objective, JSON.stringify(node.acceptanceCriteria), JSON.stringify(node.stages), null, "pending", 1, createdAt, createdAt);
        for (const dependency of node.dependencyNodeIds) {
          this.db.prepare("INSERT INTO work_node_dependencies VALUES(?,?)").run(storedId, storedIds.get(dependency)!);
        }
      }
      this.db.prepare(
        "UPDATE work_items SET refined_objective=?,state='waiting_for_human_review',current_stage='human_review',version=version+1,updated_at=? WHERE work_item_id=? AND ended_at IS NULL",
      ).run(objective, createdAt, workItemId);
      this.event(projectId, null, null, "plan_proposed", `Plan revision ${revision} proposed`, createdAt);
    });
    return this.snapshot(projectId);
  }

  claimContext(taskId: string): ClaimRunResult["context"]["workflow"] {
    const row = this.db.prepare(`SELECT a.stage,a.skill_digests_json,n.node_id,n.plan_revision_id
      FROM stage_attempts a JOIN work_nodes n ON n.node_id=a.node_id WHERE a.task_id=?`).get(taskId) as Row | undefined;
    if (!row) return null;
    const digests = json<Record<string, string>>(row.skill_digests_json);
    const skills = this.skills.loadSync(Object.keys(digests));
    for (const skill of skills) if (digests[skill.skillId] !== skill.digest) throw new TaskBoardError(409, "SKILL_DIGEST_CHANGED", `Skill ${skill.skillId} changed after confirmation`);
    const handoffs = (this.db.prepare(`SELECT h.payload_json FROM work_node_dependencies d JOIN stage_handoffs h ON h.node_id=d.dependency_node_id
      WHERE d.node_id=? ORDER BY h.created_at`).all(String(row.node_id)) as Row[]).map((item) => Object.freeze(json<StageHandoff>(item.payload_json)));
    return Object.freeze({
      planRevisionId: String(row.plan_revision_id), nodeId: String(row.node_id), stage: row.stage as WorkflowStage,
      skills: Object.freeze(skills), dependencyHandoffs: Object.freeze(handoffs),
    });
  }

  confirm(planId: string, request: ConfirmPlanRevisionRequest, actor: string): readonly WorkNode[] {
    if (request.expectedState !== "proposed") throw new TaskBoardError(400, "WORKFLOW_INVALID", "Expected state must be proposed");
    const now = this.now().toISOString();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id=?").get(planId) as Row | undefined;
      if (!row) throw new TaskBoardError(404, "PLAN_NOT_FOUND", "Plan was not found");
      if (row.state !== "proposed") throw new TaskBoardError(409, "PLAN_NOT_PROPOSED", "Plan is no longer proposed");
      this.db.prepare("UPDATE plan_revisions SET state='confirmed',confirmed_by=?,confirmed_at=? WHERE plan_revision_id=?").run(actor, now, planId);
      this.db.prepare(`UPDATE work_nodes SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=?
        WHERE plan_revision_id=? AND NOT EXISTS(SELECT 1 FROM work_node_dependencies d WHERE d.node_id=work_nodes.node_id)`).run(now, planId);
      const firstStage = this.db.prepare(
        "SELECT current_stage FROM work_nodes WHERE plan_revision_id=? AND state='ready' ORDER BY created_at,node_id LIMIT 1",
      ).get(planId)?.current_stage;
      this.db.prepare("UPDATE work_items SET state='processing',resolved_project_id=?,current_stage=?,version=version+1,updated_at=? WHERE work_item_id=?").run(String(row.project_id), String(firstStage), now, String(row.work_item_id));
      this.event(String(row.project_id), null, null, "plan_confirmed", `Plan revision ${row.revision} confirmed`, now);
      return this.nodes(planId).filter((node) => node.state === "ready");
    });
  }

  linkAttempt(nodeId: string, taskId: string, stage: WorkflowStage, skillDigests: Readonly<Record<string, string>>): void {
    this.transaction(() => {
      const attempt = Number(this.db.prepare("SELECT COALESCE(MAX(attempt),0)+1 AS n FROM stage_attempts WHERE node_id=? AND stage=?").get(nodeId, stage)?.n);
      this.db.prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)").run(`attempt_${randomUUID()}`, nodeId, taskId, stage, attempt, JSON.stringify(skillDigests));
      this.db.prepare("UPDATE work_nodes SET state='active',version=version+1,updated_at=? WHERE node_id=?").run(this.now().toISOString(), nodeId);
    });
  }

  settleAttempt(taskId: string, outcome: "completed" | "failed" | "interrupted", result: string, draft?: StageHandoffDraft | null): readonly WorkNode[] {
    const attempt = this.db.prepare(`SELECT a.*,n.project_id,n.plan_revision_id,n.stage_template_json,n.current_stage FROM stage_attempts a
      JOIN work_nodes n ON n.node_id=a.node_id WHERE a.task_id=?`).get(taskId) as Row | undefined;
    if (!attempt) return Object.freeze([]);
    const now = this.now().toISOString();
    return this.transaction(() => {
      const nodeId = String(attempt.node_id); const projectId = String(attempt.project_id);
      const stage = String(attempt.stage) as WorkflowStage;
      const passed = outcome === "completed";
      const supplied = draft ?? null;
      if (
        supplied !== null &&
        (passed && supplied.outcome !== "passed" || !passed && supplied.outcome === "passed")
      ) throw new TaskBoardError(400, "HANDOFF_OUTCOME_MISMATCH", "Handoff outcome contradicts the settled run");
      if (supplied !== null && new Set(supplied.artifactIds).size !== supplied.artifactIds.length) {
        throw new TaskBoardError(400, "HANDOFF_ARTIFACT_INVALID", "Handoff artifact IDs must be unique");
      }
      for (const artifactId of supplied?.artifactIds ?? []) {
        if (!this.db.prepare("SELECT 1 FROM artifacts WHERE artifact_id=? AND project_id=?").get(artifactId, projectId)) {
          throw new TaskBoardError(400, "HANDOFF_ARTIFACT_INVALID", "Handoff references an unavailable artifact");
        }
      }
      const handoff: StageHandoff = Object.freeze({
        apiVersion: "steward.task-board/v1", handoffId: `handoff_${randomUUID()}`, nodeId, taskId, stage,
        outcome: supplied?.outcome ?? (passed ? "passed" : "failed"), summary: supplied?.summary ?? result,
        evidence: supplied?.evidence ?? Object.freeze([]), artifactIds: supplied?.artifactIds ?? Object.freeze([]),
        acceptanceCriteria: supplied?.acceptanceCriteria ?? Object.freeze([]),
        blockers: supplied?.blockers ?? Object.freeze(passed ? [] : [result]),
        recommendedReturnStage: supplied?.recommendedReturnStage ?? (passed ? null : stage), createdAt: now,
      });
      this.db.prepare("INSERT OR IGNORE INTO stage_handoffs VALUES(?,?,?,?,?,?,?)").run(handoff.handoffId, nodeId, taskId, stage, handoff.outcome, JSON.stringify(handoff), now);
      if (!passed) {
        const returnStage = supplied?.recommendedReturnStage ?? null;
        const attemptNumber = Number(attempt.attempt);
        const template = json<WorkflowStage[]>(attempt.stage_template_json);
        if (returnStage !== null && template.includes(returnStage) && attemptNumber < 3) {
          this.db.prepare("UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?").run(returnStage, now, nodeId);
          this.setWorkItemStage(String(attempt.plan_revision_id), returnStage, now);
          this.event(projectId, nodeId, taskId, "stage_retry_ready", `${stage} failed; returning to ${returnStage} (attempt ${attemptNumber + 1} of 3)`, now);
          return Object.freeze(this.nodesForIds([nodeId]));
        }
        this.db.prepare("UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=?").run(now, nodeId);
        this.event(projectId, nodeId, taskId, "stage_failed", `${stage} failed: ${result.slice(0, 240)}`, now);
        return Object.freeze([]);
      }
      const template = json<WorkflowStage[]>(attempt.stage_template_json);
      const next = template[template.indexOf(stage) + 1] ?? null;
      if (next !== null) {
        this.db.prepare("UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?").run(next, now, nodeId);
        this.setWorkItemStage(String(attempt.plan_revision_id), next, now);
        this.event(projectId, nodeId, taskId, "stage_completed", `${stage} completed; ${next} is ready`, now);
        return Object.freeze(this.nodesForIds([nodeId]));
      }
      this.db.prepare("UPDATE work_nodes SET state='completed',current_stage=NULL,version=version+1,updated_at=? WHERE node_id=?").run(now, nodeId);
      this.event(projectId, nodeId, taskId, "node_completed", "Subtask completed", now);
      const newlyReady = (this.db.prepare(`SELECT n.node_id FROM work_nodes n
        WHERE n.state='pending' AND EXISTS(SELECT 1 FROM work_node_dependencies d WHERE d.node_id=n.node_id AND d.dependency_node_id=?)
        AND NOT EXISTS(SELECT 1 FROM work_node_dependencies d JOIN work_nodes dependency ON dependency.node_id=d.dependency_node_id WHERE d.node_id=n.node_id AND dependency.state<>'completed')`).all(nodeId) as Row[]).map((row) => String(row.node_id));
      for (const id of newlyReady) {
        this.db.prepare("UPDATE work_nodes SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=? WHERE node_id=?").run(now, id);
        this.event(projectId, id, null, "dependency_unblocked", "Dependencies completed", now);
      }
      if (newlyReady.length > 0) {
        const nextStage = this.db.prepare("SELECT current_stage FROM work_nodes WHERE node_id=?").get(newlyReady[0]!)?.current_stage;
        if (nextStage !== null && nextStage !== undefined) {
          this.setWorkItemStage(String(attempt.plan_revision_id), String(nextStage) as WorkflowStage, now);
        }
      }
      const planRevisionId = String(attempt.plan_revision_id);
      const unfinished = this.db.prepare(
        "SELECT 1 FROM work_nodes WHERE plan_revision_id=? AND state<>'completed' LIMIT 1",
      ).get(planRevisionId);
      if (!unfinished) {
        const plan = this.db.prepare("SELECT work_item_id,objective FROM plan_revisions WHERE plan_revision_id=?").get(planRevisionId) as Row;
        this.db.prepare(
          "UPDATE work_items SET state='completed',current_stage=NULL,ended_at=?,version=version+1,updated_at=? WHERE work_item_id=? AND ended_at IS NULL",
        ).run(now, now, String(plan.work_item_id));
        this.event(projectId, null, taskId, "workflow_completed", `Completed: ${String(plan.objective).slice(0, 240)}`, now);
      }
      return Object.freeze(this.nodesForIds(newlyReady));
    });
  }

  nodesForIds(ids: readonly string[]): WorkNode[] {
    if (ids.length === 0) return [];
    const plans = new Set((this.db.prepare(`SELECT DISTINCT plan_revision_id FROM work_nodes WHERE node_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[]).map((row) => String(row.plan_revision_id)));
    return [...plans].flatMap((plan) => this.nodes(plan)).filter((node) => ids.includes(node.nodeId));
  }

  private setWorkItemStage(planRevisionId: string, stage: WorkflowStage, updatedAt: string): void {
    this.db.prepare(`UPDATE work_items SET current_stage=?,version=version+1,updated_at=?
      WHERE work_item_id=(SELECT work_item_id FROM plan_revisions WHERE plan_revision_id=?) AND ended_at IS NULL`)
      .run(stage, updatedAt, planRevisionId);
  }

  nodes(planId: string): readonly WorkNode[] {
    const rows = this.db.prepare(`SELECT n.*, COALESCE(json_group_array(d.dependency_node_id) FILTER(WHERE d.dependency_node_id IS NOT NULL),'[]') dependencies
      FROM work_nodes n LEFT JOIN work_node_dependencies d ON d.node_id=n.node_id WHERE n.plan_revision_id=? GROUP BY n.node_id ORDER BY n.created_at,n.node_id`).all(planId) as Row[];
    return Object.freeze(rows.map((row) => Object.freeze({
      apiVersion: "steward.task-board/v1", nodeId: String(row.node_id), planRevisionId: String(row.plan_revision_id), projectId: String(row.project_id),
      title: String(row.title), objective: String(row.objective), acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
      dependencyNodeIds: Object.freeze(json<string[]>(row.dependencies)), stageTemplate: Object.freeze(json<WorkflowStage[]>(row.stage_template_json)),
      currentStage: row.current_stage as WorkflowStage | null, state: row.state as WorkNode["state"], version: Number(row.version),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    })));
  }

  snapshot(projectId: string): ProjectWorkflowSnapshot {
    const plans = (this.db.prepare("SELECT * FROM plan_revisions WHERE project_id=? ORDER BY revision DESC").all(projectId) as Row[]).map(planFromRow);
    const seenWorkItems = new Set<string>();
    const latestPlans = plans.filter((plan) => {
      if (seenWorkItems.has(plan.workItemId)) return false;
      seenWorkItems.add(plan.workItemId);
      return true;
    });
    const nodes = latestPlans.flatMap((plan) => this.nodes(plan.planRevisionId));
    const handoffs = (this.db.prepare("SELECT payload_json FROM stage_handoffs h JOIN work_nodes n ON n.node_id=h.node_id WHERE n.project_id=? ORDER BY h.created_at").all(projectId) as Row[]).map((row) => Object.freeze(json<StageHandoff>(row.payload_json)));
    const events = (this.db.prepare("SELECT * FROM project_events WHERE project_id=? ORDER BY sequence DESC LIMIT 500").all(projectId) as Row[]).map((row) => Object.freeze({ apiVersion: "steward.task-board/v1" as const, sequence: Number(row.sequence), eventId: String(row.event_id), projectId: String(row.project_id), nodeId: row.node_id === null ? null : String(row.node_id), taskId: row.task_id === null ? null : String(row.task_id), eventType: String(row.event_type), summary: String(row.summary), createdAt: String(row.created_at) }));
    return Object.freeze({ plans: Object.freeze(plans), nodes: Object.freeze(nodes), handoffs: Object.freeze(handoffs), events: Object.freeze(events) });
  }

  event(projectId: string, nodeId: string | null, taskId: string | null, type: string, summary: string, createdAt = this.now().toISOString()): void {
    const eventId = `event_${randomUUID()}`;
    this.db.prepare("INSERT INTO project_events(event_id,project_id,node_id,task_id,event_type,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(eventId, projectId, nodeId, taskId, type, summary, createdAt);
    const sequence = Number((this.db.prepare("SELECT sequence FROM project_events WHERE event_id=?").get(eventId) as Row).sequence);
    this.onEvent?.(Object.freeze({
      apiVersion: "steward.task-board/v1", sequence, eventId, projectId, nodeId, taskId,
      eventType: type, summary, createdAt,
    }));
  }
}
