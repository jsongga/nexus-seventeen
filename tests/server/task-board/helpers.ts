import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AutomationPipelineStage,
  AutomationStageExecutor,
  CreateTaskRequest,
  CreateWorkItemRequest,
  GateAction,
  UpdateAutomationConfigurationRequest,
  WorkItemStage,
} from "#shared/task-board-contract";
import { WORK_ITEM_STAGES } from "#shared/task-board-contract";
import { parseGateAction } from "#shared/task-board-contract/validate";
import {
  TaskBoard,
  normalizeTaskBoardConfig,
  type TaskBoardConfig,
  type TaskBoardDependencies,
} from "#server/task-board";
import type { GitRunner, GitTextRunner } from "#server/task-board/collaborators/scope-check";

type FixtureTaskBoardDependencies = Omit<TaskBoardDependencies, "git"> & Readonly<{
  git?: GitRunner | GitTextRunner;
}>;

export const HUMAN_TOKEN = "task-board-human-token-0123456789abcdef";
export const AGENT_ONE_TOKEN = "task-board-agent-one-token-0123456789";
export const AGENT_TWO_TOKEN = "task-board-agent-two-token-0123456789";

export interface FakeCliFixture {
  readonly bin: string;
  readonly working: string;
  readonly scratch: string;
}

export async function fakeCli(root: string, command: string, source: string): Promise<FakeCliFixture> {
  const bin = join(root, "bin");
  const working = join(root, "working");
  const scratch = join(root, "scratch");
  await mkdir(bin, { recursive: true });
  await mkdir(working, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const executable = join(bin, command);
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return Object.freeze({ bin, working, scratch });
}

export async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-task-board-"));
  return join(root, "private", "task-board.sqlite");
}

export function latestParkRecord(path: string, workItemId: string): Readonly<{
  category: string;
  reason: string;
}> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { ...db.prepare(`
      SELECT category, reason
      FROM park_records
      WHERE work_item_id=?
      ORDER BY parked_at DESC, rowid DESC
      LIMIT 1
    `).get(workItemId) } as { category: string; reason: string };
  } finally {
    db.close();
  }
}

export function gateActions(path: string, workItemId: string): readonly GateAction[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.freeze(db.prepare(`
      SELECT *
      FROM gate_actions
      WHERE work_item_id=?
      ORDER BY created_at, rowid
    `).all(workItemId).map((row) => parseGateAction({
      gateActionId: row.gate_action_id,
      workItemId: row.work_item_id,
      gate: row.gate,
      actorId: row.actor_id,
      planRevisionId: row.plan_revision_id,
      verifiedSha: row.verified_sha,
      mergeSha: row.merge_sha,
      refId: row.ref_id,
      note: row.note,
      createdAt: row.created_at,
    }, "gateAction")));
  } finally {
    db.close();
  }
}

export function config(
  path: string,
  now: () => Date = () => new Date("2026-07-19T20:00:00.000Z"),
  overrides: Readonly<Pick<TaskBoardConfig, "reconcileIntervalSeconds">> | undefined = undefined,
): TaskBoardConfig {
  return normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now,
    ...overrides,
  });
}

export async function boardFixture(
  path?: string,
  now?: () => Date,
  dependencies: FixtureTaskBoardDependencies = {},
  configOverrides?: Readonly<Pick<TaskBoardConfig, "reconcileIntervalSeconds">>,
) {
  const resolvedPath = path ?? await databasePath();
  const { git, ...otherDependencies } = dependencies;
  const resolvedGit: GitRunner | undefined = git === undefined
    ? undefined
    : "bytes" in git
      ? git as GitRunner
      : Object.assign(
          (arguments_: readonly string[]) => git(arguments_),
          { bytes: (arguments_: readonly string[]) => Buffer.from(git(arguments_), "utf8") },
        );
  const resolvedDependencies: TaskBoardDependencies = Object.freeze({
    ...otherDependencies,
    ...(resolvedGit === undefined ? {} : { git: resolvedGit }),
  });
  const board = await TaskBoard.open(config(resolvedPath, now, configOverrides), resolvedDependencies);
  const project = board.createProject({ name: "Checkout reliability", description: "Keep customer checkout dependable." });
  const engineer = board.createAgent(project.projectId, {
    agentId: "engineer-one",
    role: "engineer",
    area: "checkout",
    mission: "Ship safe customer-facing checkout improvements.",
    model: "codex-mini",
    token: AGENT_ONE_TOKEN,
  });
  const manager = board.createAgent(project.projectId, {
    agentId: "manager-one",
    role: "manager",
    area: "release-review",
    mission: "Review impact and prepare work for human approval.",
    model: "claude-haiku",
    token: AGENT_TWO_TOKEN,
  });
  return { board, path: resolvedPath, project, engineer, manager };
}

export function taskRequest(overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    parentTaskId: null,
    title: "Recover interrupted checkout",
    objective: "Customers can safely retry checkout without a duplicate charge.",
    acceptanceCriteria: "Passing retry and duplicate-submit tests with a rollback note.",
    workspaceRefs: ["repo:checkout", "branch:feature/retry"],
    assignedAgentId: "engineer-one",
    assignedRole: "engineer",
    ...overrides,
  };
}

export function workItemRequest(
  overrides: Partial<CreateWorkItemRequest> & Pick<CreateWorkItemRequest, "projectTarget">,
): CreateWorkItemRequest {
  return {
    originalRequest: "Make checkout retries safe and observable.",
    priority: "normal",
    ...overrides,
  };
}

const AUTOMATION_STAGE_ORDER: readonly WorkItemStage[] = WORK_ITEM_STAGES;

export function automationStages(
  overrides: Readonly<Partial<Record<WorkItemStage, AutomationStageExecutor>>> = {},
): readonly AutomationPipelineStage[] {
  return AUTOMATION_STAGE_ORDER.map((stage) => ({
    stage,
    executor: overrides[stage]
      ?? (stage === "human_review" ? { kind: "human" as const } : { kind: "disabled" as const }),
  }));
}

export function automationConfigurationRequest(
  overrides: Partial<UpdateAutomationConfigurationRequest> = {},
): UpdateAutomationConfigurationRequest {
  return {
    version: 1,
    agentTypes: [],
    stages: automationStages(),
    ...overrides,
  };
}
