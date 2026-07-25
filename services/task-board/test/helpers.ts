import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AutomationPipelineStage,
  AutomationStageExecutor,
  CreateTaskRequest,
  CreateWorkItemRequest,
  UpdateAutomationConfigurationRequest,
  WorkItemStage,
} from "@cicada/steward-task-board-contract";
import { TaskBoard, normalizeTaskBoardConfig, type TaskBoardConfig } from "../src/index.js";

export const HUMAN_TOKEN = "task-board-human-token-0123456789abcdef";
export const AGENT_ONE_TOKEN = "task-board-agent-one-token-0123456789";
export const AGENT_TWO_TOKEN = "task-board-agent-two-token-0123456789";

export async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-task-board-"));
  return join(root, "private", "task-board.sqlite");
}

export function config(path: string, now: () => Date = () => new Date("2026-07-19T20:00:00.000Z")): TaskBoardConfig {
  return normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now,
  });
}

export async function boardFixture(path?: string, now?: () => Date) {
  const resolvedPath = path ?? await databasePath();
  const board = await TaskBoard.open(config(resolvedPath, now));
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

export function workItemRequest(overrides: Partial<CreateWorkItemRequest> = {}): CreateWorkItemRequest {
  return {
    originalRequest: "Make checkout retries safe and observable.",
    priority: "normal",
    projectTarget: { mode: "auto" },
    ...overrides,
  };
}

const AUTOMATION_STAGE_ORDER: readonly WorkItemStage[] = [
  "refinement",
  "project_resolution",
  "research",
  "planning",
  "implementation",
  "testing",
  "verification",
  "human_review",
  "deployment",
];

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
