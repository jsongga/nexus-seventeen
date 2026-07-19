import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  createTaskBoardService,
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

async function fixture(longPollMs = 0): Promise<Fixture> {
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

async function createTask(item: Fixture, title: string): Promise<BoardTask> {
  const response = await request<{ task: BoardTask }>(
    item.origin,
    `/v1/projects/${item.project.projectId}/tasks`,
    "POST",
    HUMAN_TOKEN,
    201,
    {
      parentTaskId: null,
      title,
      objective: "Customers can retry checkout without a duplicate charge.",
      acceptanceCriteria: "Focused retry tests pass and the result explains customer impact.",
      workspaceRefs: ["repo:checkout", "path:services/checkout"],
      assignedAgentId: AGENT_ID,
      assignedRole: "engineer",
      expectedAgentMinutes: 45,
    },
  );
  assert.equal(response.task.status, "queued");
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
    item.launcher.outcomes.push(completedOutcome("Customers can retry without being charged twice."));
    assert.equal(await item.worker.dispatchOnce(), true);

    assert.equal(item.launcher.requests.length, 1);
    assert.equal(item.launcher.requests[0]?.wakeReason, "human_assignment");
    assert.equal(item.launcher.requests[0]?.context.taskId, task.taskId);
    assert.deepEqual(item.launcher.requests[0]?.context.workspaceRefs, task.workspaceRefs);

    const board = await snapshot(item);
    const completed = board.tasks.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.result, "Customers can retry without being charged twice.");
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
