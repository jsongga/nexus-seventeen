import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  createTaskBoardService,
  type AgentRole,
  type BoardSnapshot,
  type BoardTask,
  type HumanQuestion,
  type Project,
  type TaskBoardService,
  type TaskMessage,
} from "@cicada/steward-task-board";
import { HttpTaskBoardClient } from "../src/http-board-client.js";
import { TaskWorker } from "../src/worker.js";
import type { AgentRunOutcome } from "../src/types.js";
import { FakeLauncher, completedOutcome, tempRoot, until } from "./helpers.js";

const HUMAN_TOKEN = "worker-integration-human-token-0123456789";
const AGENT_TOKEN = "worker-integration-agent-token-0123456789";
const AGENT_ID = "integration-engineer";
const MANAGER_TOKEN = "worker-integration-manager-token-0123456789";
const MANAGER_ID = "integration-manager";
const OTHER_AGENT_TOKEN = "worker-integration-other-agent-token-0123456789";
const OTHER_AGENT_ID = "integration-other-engineer";
const OTHER_PROJECT_TOKEN = "worker-integration-other-project-token-012345";
const OTHER_PROJECT_AGENT_ID = "integration-other-project-engineer";

interface Fixture {
  readonly root: string;
  readonly service: TaskBoardService;
  readonly origin: string;
  readonly project: Project;
  readonly launcher: FakeLauncher;
  readonly worker: TaskWorker;
}

async function request<T>(
  origin: string,
  path: string,
  method: "GET" | "POST",
  token: string,
  expectedStatus: number,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

async function fixture(longPollMs = 1): Promise<Fixture> {
  const root = await tempRoot();
  const service = await createTaskBoardService({
    dbPath: join(root, "board", "task-board.sqlite"),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:integration-reviewer",
    host: "127.0.0.1",
    port: 0,
  });
  const address = await service.start();
  const { project } = await request<{ project: Project }>(
    address.url,
    "/v1/projects",
    "POST",
    HUMAN_TOKEN,
    201,
    {
      name: "Checkout reliability",
      description: "Keep customer checkout dependable while humans control production releases.",
    },
  );
  await request(
    address.url,
    `/v1/projects/${project.projectId}/agents`,
    "POST",
    HUMAN_TOKEN,
    201,
    {
      agentId: AGENT_ID,
      role: "engineer",
      area: "checkout",
      mission: "Research, plan, implement, and test safe checkout changes.",
      model: "codex-mini",
      token: AGENT_TOKEN,
    },
  );
  const launcher = new FakeLauncher();
  const worker = await TaskWorker.create({
    identity: { workerId: "integration-worker", agentId: AGENT_ID },
    statePath: join(root, "worker", "journal.json"),
    board: new HttpTaskBoardClient({ baseUrl: address.url, token: AGENT_TOKEN }),
    launcher,
    longPollMs,
  });
  return { root, service, origin: address.url, project, launcher, worker };
}

async function createTask(
  item: Fixture,
  title: string,
  objective = "Customers can retry checkout without a duplicate charge.",
): Promise<BoardTask> {
  const response = await request<{ task: BoardTask }>(
    item.origin,
    `/v1/projects/${item.project.projectId}/tasks`,
    "POST",
    HUMAN_TOKEN,
    201,
    {
      parentTaskId: null,
      title,
      objective,
      acceptanceCriteria: "Focused retry tests pass and the result explains customer impact.",
      workspaceRefs: ["repo:checkout", "path:services/checkout"],
      assignedAgentId: AGENT_ID,
      assignedRole: "engineer",
      expectedAgentMinutes: 45,
    },
  );
  assert.equal(response.task.status, "queued");
  assert.equal(response.task.expectedAgentMinutes, null, "human task input does not set the agent's estimate");
  return response.task;
}

async function createAssignedTask(
  origin: string,
  projectId: string,
  agentId: string,
  assignedRole: AgentRole,
  title: string,
): Promise<BoardTask> {
  const response = await request<{ task: BoardTask }>(
    origin,
    "/v1/projects/" + encodeURIComponent(projectId) + "/tasks",
    "POST",
    HUMAN_TOKEN,
    201,
    {
      parentTaskId: null,
      title,
      objective: "Record a completed result for deterministic area memory.",
      acceptanceCriteria: "The assigned agent completes the task with a concrete result.",
      workspaceRefs: ["repo:memory-test"],
      assignedAgentId: agentId,
      assignedRole,
      expectedAgentMinutes: 15,
    },
  );
  return response.task;
}

async function snapshot(item: Fixture): Promise<BoardSnapshot> {
  return request<BoardSnapshot>(
    item.origin,
    `/v1/projects/${item.project.projectId}/board`,
    "GET",
    HUMAN_TOKEN,
    200,
  );
}

async function close(item: Fixture): Promise<void> {
  await item.worker.close();
  await item.service.close();
}

test("real HTTP board stays model-idle without a wake and atomically completes a claimed task", async () => {
  const item = await fixture(10);
  try {
    assert.equal(await item.worker.dispatchOnce(), false);
    assert.equal(item.launcher.requests.length, 0);

    const task = await createTask(item, "Make checkout retries idempotent");
    item.launcher.outcomes.push({
      ...completedOutcome("Customers can retry without being charged twice."),
      expectedAgentMinutes: 60,
      phases: [
        {
          phaseId: null,
          title: "Implement retry guard",
          stage: "execution",
          status: "completed",
          parallelGroup: "delivery",
          orderKey: 100,
        },
        {
          phaseId: null,
          title: "Verify retry behavior",
          stage: "testing",
          status: "completed",
          parallelGroup: "delivery",
          orderKey: 200,
        },
      ],
      detail: "Implementation and focused tests completed successfully.",
    });
    assert.equal(await item.worker.dispatchOnce(), true);

    assert.equal(item.launcher.requests.length, 1);
    assert.equal(item.launcher.requests[0]?.wakeReason, "human_assignment");
    assert.equal(item.launcher.requests[0]?.context.taskId, task.taskId);
    assert.deepEqual(item.launcher.requests[0]?.context.workspaceRefs, task.workspaceRefs);

    const board = await snapshot(item);
    const completed = board.tasks.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.result, "Customers can retry without being charged twice.");
    assert.equal(completed?.expectedAgentMinutes, 60);
    assert.ok(completed?.estimateRecordedAt);
    assert.deepEqual(
      completed?.phases.filter((phase) => phase.parallelGroup === "delivery").map((phase) => ({
        title: phase.title,
        stage: phase.stage,
        status: phase.status,
      })),
      [
        { title: "Implement retry guard", stage: "execution", status: "completed" },
        { title: "Verify retry behavior", stage: "testing", status: "completed" },
      ],
    );
    assert.ok(completed?.phases.some((phase) => phase.title === "Review task" && phase.status === "completed"));
    assert.ok(completed?.startedAt);
    assert.ok(completed?.endedAt);
    const run = board.recentRuns.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.result, completed?.result);

    const { messages } = await request<{ messages: readonly TaskMessage[]; cursor: number }>(
      item.origin,
      `/v1/tasks/${task.taskId}/messages`,
      "GET",
      HUMAN_TOKEN,
      200,
    );
    assert.deepEqual(messages.map((message) => message.kind), ["progress", "proposal", "result"]);
    assert.ok(messages.every((message) => message.runId === run?.runId));
  } finally {
    await close(item);
  }
});

test("a board-accepted long task description remains runnable in bounded worker context", async () => {
  const item = await fixture();
  try {
    const objective = "x".repeat(8_000);
    const task = await createTask(item, "Handle a detailed migration", objective);
    item.launcher.outcomes.push(completedOutcome("The detailed migration task is complete."));
    assert.equal(await item.worker.dispatchOnce(), true);
    assert.equal(item.launcher.requests[0]?.context.taskId, task.taskId);
    assert.equal(item.launcher.requests[0]?.context.task.objective, objective);
  } finally {
    await close(item);
  }
});

test("worker receives persistent area memory without crossing agent or project boundaries", async () => {
  const item = await fixture();
  let originalWorkerClosed = false;
  let originalServiceClosed = false;
  let otherWorker: TaskWorker | null = null;
  let otherProjectWorker: TaskWorker | null = null;
  let restartedService: TaskBoardService | null = null;
  let restartedWorker: TaskWorker | null = null;
  try {
    const remembered = await createTask(item, "Remember checkout retry impact");
    item.launcher.outcomes.push(completedOutcome("Customers can retry without a duplicate charge."));
    assert.equal(await item.worker.dispatchOnce(), true);
    assert.deepEqual(item.launcher.requests[0]?.context.areaMemory, []);

    await request(
      item.origin,
      "/v1/projects/" + encodeURIComponent(item.project.projectId) + "/agents",
      "POST",
      HUMAN_TOKEN,
      201,
      {
        agentId: OTHER_AGENT_ID,
        role: "engineer",
        area: "checkout",
        mission: "Own separate checkout work without sharing another agent's memory.",
        model: "codex-mini",
        token: OTHER_AGENT_TOKEN,
      },
    );
    const otherAgentTask = await createAssignedTask(
      item.origin,
      item.project.projectId,
      OTHER_AGENT_ID,
      "engineer",
      "Other agent result",
    );
    const otherLauncher = new FakeLauncher();
    otherLauncher.outcomes.push(completedOutcome("This result belongs only to the other agent."));
    otherWorker = await TaskWorker.create({
      identity: { workerId: "integration-other-worker", agentId: OTHER_AGENT_ID },
      statePath: join(item.root, "other-worker", "journal.json"),
      board: new HttpTaskBoardClient({ baseUrl: item.origin, token: OTHER_AGENT_TOKEN }),
      launcher: otherLauncher,
      longPollMs: 1,
    });
    assert.equal(await otherWorker.dispatchOnce(), true);
    assert.deepEqual(otherLauncher.requests[0]?.context.areaMemory, []);
    await otherWorker.close();
    otherWorker = null;

    const { project: otherProject } = await request<{ project: Project }>(
      item.origin,
      "/v1/projects",
      "POST",
      HUMAN_TOKEN,
      201,
      {
        name: "Account recovery",
        description: "Keep recovery work isolated from checkout.",
      },
    );
    await request(
      item.origin,
      "/v1/projects/" + encodeURIComponent(otherProject.projectId) + "/agents",
      "POST",
      HUMAN_TOKEN,
      201,
      {
        agentId: OTHER_PROJECT_AGENT_ID,
        role: "engineer",
        area: "checkout",
        mission: "Own recovery work in a separate project.",
        model: "codex-mini",
        token: OTHER_PROJECT_TOKEN,
      },
    );
    const otherProjectTask = await createAssignedTask(
      item.origin,
      otherProject.projectId,
      OTHER_PROJECT_AGENT_ID,
      "engineer",
      "Other project result",
    );
    const otherProjectLauncher = new FakeLauncher();
    otherProjectLauncher.outcomes.push(completedOutcome("This result belongs only to the other project."));
    otherProjectWorker = await TaskWorker.create({
      identity: { workerId: "integration-other-project-worker", agentId: OTHER_PROJECT_AGENT_ID },
      statePath: join(item.root, "other-project-worker", "journal.json"),
      board: new HttpTaskBoardClient({ baseUrl: item.origin, token: OTHER_PROJECT_TOKEN }),
      launcher: otherProjectLauncher,
      longPollMs: 1,
    });
    assert.equal(await otherProjectWorker.dispatchOnce(), true);
    assert.deepEqual(otherProjectLauncher.requests[0]?.context.areaMemory, []);
    await otherProjectWorker.close();
    otherProjectWorker = null;

    await item.worker.close();
    originalWorkerClosed = true;
    await item.service.close();
    originalServiceClosed = true;

    restartedService = await createTaskBoardService({
      dbPath: join(item.root, "board", "task-board.sqlite"),
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:integration-reviewer",
      host: "127.0.0.1",
      port: 0,
    });
    const restartedAddress = await restartedService.start();
    const current = await createAssignedTask(
      restartedAddress.url,
      item.project.projectId,
      AGENT_ID,
      "engineer",
      "Use persistent checkout memory",
    );
    const restartedLauncher = new FakeLauncher();
    restartedLauncher.outcomes.push(completedOutcome("The prior retry result informed this task."));
    restartedWorker = await TaskWorker.create({
      identity: { workerId: "integration-restarted-worker", agentId: AGENT_ID },
      statePath: join(item.root, "restarted-worker", "journal.json"),
      board: new HttpTaskBoardClient({ baseUrl: restartedAddress.url, token: AGENT_TOKEN }),
      launcher: restartedLauncher,
      longPollMs: 1,
    });
    assert.equal(await restartedWorker.dispatchOnce(), true);

    const memory = restartedLauncher.requests[0]?.context.areaMemory;
    assert.deepEqual(memory?.map((entry) => entry.taskId), [remembered.taskId]);
    assert.equal(memory?.[0]?.title, remembered.title);
    assert.equal(memory?.[0]?.result, "Customers can retry without a duplicate charge.");
    assert.ok(memory?.[0]?.endedAt);
    assert.deepEqual(Object.keys(memory?.[0] ?? {}).sort(), ["endedAt", "result", "taskId", "title"]);
    assert.ok(memory?.every((entry) => (
      entry.taskId !== current.taskId &&
      entry.taskId !== otherAgentTask.taskId &&
      entry.taskId !== otherProjectTask.taskId
    )));
  } finally {
    await restartedWorker?.close();
    await restartedService?.close();
    await otherProjectWorker?.close();
    await otherWorker?.close();
    if (!originalWorkerClosed) await item.worker.close();
    if (!originalServiceClosed) await item.service.close();
  }
});

test("a review child receives bounded evidence from its completed engineer parent", async () => {
  const item = await fixture();
  let managerWorker: TaskWorker | null = null;
  try {
    await request(
      item.origin,
      `/v1/projects/${item.project.projectId}/agents`,
      "POST",
      HUMAN_TOKEN,
      201,
      {
        agentId: MANAGER_ID,
        role: "manager",
        area: "checkout review",
        mission: "Review completed checkout work and report whether it is ready for human approval.",
        model: "codex-mini",
        token: MANAGER_TOKEN,
      },
    );
    const parent = await createTask(item, "Make checkout retries idempotent");
    item.launcher.outcomes.push({
      ...completedOutcome("Customers can retry without being charged twice."),
      detail: "The engineer completed implementation and focused verification.",
    });
    assert.equal(await item.worker.dispatchOnce(), true);
    const review = (await snapshot(item)).tasks.find((candidate) => (
      candidate.parentTaskId === parent.taskId && candidate.kind === "manager_review"
    ));
    assert.ok(review);
    assert.equal(review.assignedAgentId, MANAGER_ID);
    assert.equal(review.status, "queued");
    const managerLauncher = new FakeLauncher();
    managerLauncher.outcomes.push(completedOutcome("The evidence is ready for human approval."));
    managerWorker = await TaskWorker.create({
      identity: { workerId: "integration-manager-worker", agentId: MANAGER_ID },
      statePath: join(item.root, "manager-worker", "journal.json"),
      board: new HttpTaskBoardClient({ baseUrl: item.origin, token: MANAGER_TOKEN }),
      launcher: managerLauncher,
      longPollMs: 1,
    });
    assert.equal(await managerWorker.dispatchOnce(), true);

    const evidence = managerLauncher.requests[0]?.context.parentEvidence;
    assert.equal(managerLauncher.requests[0]?.wakeReason, "workflow_handoff");
    assert.equal(managerLauncher.requests[0]?.context.taskId, review.taskId);
    assert.equal(managerLauncher.requests[0]?.context.task.kind, "manager_review");
    assert.equal(managerLauncher.requests[0]?.context.task.requiredRole, "manager");
    assert.equal(evidence?.taskId, parent.taskId);
    assert.equal(evidence?.status, "completed");
    assert.equal(evidence?.result, "Customers can retry without being charged twice.");
    assert.deepEqual(evidence?.workspaceRefs, parent.workspaceRefs);
    assert.deepEqual(evidence?.messages.map((message) => message.kind), ["progress", "proposal", "result"]);
    assert.ok(evidence?.messages.every((message) => message.body.length <= 2_000));
  } finally {
    await managerWorker?.close();
    await close(item);
  }
});

test("a question atomically pauses the real run and its human answer is the next bounded wake", async () => {
  const item = await fixture();
  try {
    const task = await createTask(item, "Clarify retry policy");
    const waiting: AgentRunOutcome = {
      status: "waiting_for_human",
      outputs: [
        { type: "progress", body: "Research found an unresolved fraud-policy decision." },
        { type: "human_question", question: "Should a fraud rejection disable later retries?" },
      ],
      expectedAgentMinutes: 30,
      phases: [],
      detail: "Waiting for a human policy decision.",
    };
    item.launcher.outcomes.push(waiting);
    assert.equal(await item.worker.dispatchOnce(), true);

    const paused = await snapshot(item);
    assert.equal(paused.tasks.find((candidate) => candidate.taskId === task.taskId)?.status, "blocked");
    const waitingRun = paused.recentRuns.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(waitingRun?.status, "waiting_for_human");
    assert.equal(waitingRun?.taskId, task.taskId);
    const question = paused.openQuestions[0];
    assert.ok(question);
    assert.equal(question.runId, waitingRun?.runId);

    const answer = "Yes. Stop retries after a fraud rejection and explain the next step.";
    const answered = await request<{ question: HumanQuestion }>(
      item.origin,
      `/v1/questions/${question.questionId}/answer`,
      "POST",
      HUMAN_TOKEN,
      201,
      { answer, version: question.version },
    );
    assert.equal(answered.question.answer, answer);

    item.launcher.outcomes.push(completedOutcome("Fraud rejections now stop unsafe retries."));
    assert.equal(await item.worker.dispatchOnce(), true);
    assert.equal(item.launcher.requests.length, 2);
    assert.equal(item.launcher.requests[1]?.wakeReason, "human_answer");
    assert.equal(item.launcher.requests[1]?.context.triggerQuestion?.questionId, question.questionId);
    assert.equal(item.launcher.requests[1]?.context.triggerQuestion?.answer, answer);

    const completed = await snapshot(item);
    assert.equal(completed.openQuestions.length, 0);
    assert.equal(completed.tasks.find((candidate) => candidate.taskId === task.taskId)?.status, "completed");
    assert.ok(completed.recentRuns.some((candidate) => candidate.taskId === task.taskId && candidate.status === "completed"));
  } finally {
    await close(item);
  }
});

test("a durable human interrupt reaches the active launcher and leaves the task resumable", async () => {
  const item = await fixture();
  try {
    const task = await createTask(item, "Interrupt unsafe retry work");
    const dispatch = item.worker.dispatchOnce();
    await until(() => item.launcher.handles.length === 1, "real HTTP board agent launch");

    const reason = "Stop now; a human is revising the task scope.";
    await request(
      item.origin,
      `/v1/agents/${AGENT_ID}/interrupt`,
      "POST",
      HUMAN_TOKEN,
      201,
      { reason },
      "worker-interrupt-0001",
    );
    assert.equal(await dispatch, true);
    assert.deepEqual(item.launcher.handles[0]?.interruptReasons, [reason]);

    const interrupted = await snapshot(item);
    const run = interrupted.recentRuns.find((candidate) => candidate.taskId === task.taskId);
    const blocked = interrupted.tasks.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(run?.status, "interrupted");
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.endedAt, null);
    assert.equal(blocked?.result, null);
  } finally {
    await close(item);
  }
});
