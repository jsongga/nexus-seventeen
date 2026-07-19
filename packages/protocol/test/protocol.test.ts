import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ProtocolValidationError,
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_UI_API_VERSION,
  parseAgentTaskProjection,
  parseDurableOutboxEvent,
  parseHumanCommandEnvelope,
  parseHumanCommandReceipt,
  parseLeaseRenewalRequest,
  parseLeaseRenewalResult,
  parseManagerReviewPermitConsumeReceipt,
  parseManagerReviewPermitConsumeRequest,
  parseProgressEvent,
  parseRegisteredAgentProjection,
  parseRuntimeCommandEnvelope,
  parseRuntimeCommandPollRequest,
  parseRuntimeCommandPollResult,
  parseRuntimeEventBatch,
  parseRuntimeEventBatchReceipt,
  parseSupervisorRegistration,
  parseSupervisorRegistrationRequest,
  parseSupervisorRegistrationResult,
  parseUiBootstrap,
  parseUiEventEnvelope,
  parseUiSnapshot,
} from "../src/index.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const registration = () => ({
  apiVersion: STEWARD_RUNTIME_API_VERSION,
  workspaceId: "workspace-one",
  agentId: "agent-one",
  laneId: "lane-engineer-one",
  runtimeInstanceId: "runtime-abc",
  expectedRuntimeEpoch: 3,
  displayName: "Engineer one",
  role: "engineer",
  capabilities: [...ROLE_CAPABILITIES.engineer],
  provider: { name: "codex", model: "codex-mini" },
  softwareVersion: "1.2.0",
  checkpointRef: "checkpoint-41",
});

const task = () => ({
  taskId: "task-one",
  workspaceId: "workspace-one",
  agentId: "agent-one",
  laneId: "lane-engineer-one",
  subject: { type: "development" },
  title: "Improve account recovery",
  objective: "Users can recover an account after losing a device.",
  status: "queued",
  expectedAgentMinutes: 45,
  expectedCompletedAt: "2026-07-18T19:45:00Z",
  startedAt: null,
  endedAt: null,
});

const EVIDENCE_DIGEST = `sha256:${"a".repeat(64)}`;
const REVIEW_REQUEST_DIGEST = `sha256:${"b".repeat(64)}`;

const managerReviewTask = () => ({
  ...task(),
  taskId: "task-review-one",
  agentId: "agent-manager-one",
  laneId: "lane-manager-one",
  subject: {
    type: "manager_review",
    sourceTaskId: "task-one",
    evidenceId: "evidence-one",
    evidenceDigest: EVIDENCE_DIGEST,
  },
  title: "Review account recovery evidence",
  objective: "Determine whether the evidence is ready for human review.",
});

const permitConsumeRequest = () => ({
  apiVersion: STEWARD_RUNTIME_API_VERSION,
  operationId: "review-operation-one",
  workspaceId: "workspace-one",
  reviewTaskId: "task-review-one",
  sourceTaskId: "task-one",
  evidenceId: "evidence-one",
  evidenceDigest: EVIDENCE_DIGEST,
  managerAgentId: "agent-manager-one",
  managerLaneId: "lane-manager-one",
  runtimeInstanceId: "runtime-manager-one",
  runtimeEpoch: 4,
  reviewRequestDigest: REVIEW_REQUEST_DIGEST,
});

const permitConsumeReceipt = () => ({
  apiVersion: STEWARD_RUNTIME_API_VERSION,
  state: "accepted",
  permitId: "permit-one",
  operationId: "review-operation-one",
  workspaceId: "workspace-one",
  reviewTaskId: "task-review-one",
  sourceTaskId: "task-one",
  evidenceId: "evidence-one",
  evidenceDigest: EVIDENCE_DIGEST,
  managerAgentId: "agent-manager-one",
  managerLaneId: "lane-manager-one",
  managerRuntimeInstanceId: "runtime-manager-one",
  managerRuntimeEpoch: 4,
  reviewRequestDigest: REVIEW_REQUEST_DIGEST,
  authorizedAt: "2026-07-18T19:34:22.000Z",
  workspaceSequence: 43,
});

const outboxEvent = (localSequence = 1) => ({
  apiVersion: STEWARD_RUNTIME_API_VERSION,
  eventId: `event-${localSequence}`,
  workspaceId: "workspace-one",
  agentId: "agent-one",
  laneId: "lane-engineer-one",
  runtimeInstanceId: "runtime-abc",
  localSequence,
  runtimeEpoch: 3,
  occurredAt: "2026-07-18T19:01:02.123Z",
  payload: {
    type: "progress",
    taskId: "task-one",
    phase: "test",
    iteration: 2,
    journal: "Recovery succeeds and the regression suite remains green.",
    outcome: "passed",
  },
});

const runtimeCommand = (serverSequence = 1) => ({
  apiVersion: STEWARD_RUNTIME_API_VERSION,
  commandId: `command-${serverSequence}`,
  workspaceId: "workspace-one",
  agentId: "agent-one",
  laneId: "lane-engineer-one",
  serverSequence,
  expectedRuntimeEpoch: 3,
  issuedAt: "2026-07-18T19:00:00Z",
  payload: {
    type: "assign_task",
    task: task(),
  },
});

const recoveryRuntimeCommand = () => ({
  apiVersion: STEWARD_RUNTIME_API_VERSION,
  commandId: "command-recover-one",
  workspaceId: "workspace-one",
  agentId: "agent-manager-one",
  laneId: "lane-manager-one",
  serverSequence: 3,
  expectedRuntimeEpoch: 4,
  issuedAt: "2026-07-18T19:30:00Z",
  payload: {
    type: "recover_task",
    task: {
      ...managerReviewTask(),
      status: "running",
      startedAt: "2026-07-18T19:15:00Z",
    },
  },
});

const agent = () => ({
  workspaceId: "workspace-one",
  agentId: "agent-one",
  laneId: "lane-engineer-one",
  runtimeInstanceId: "runtime-abc",
  runtimeEpoch: 3,
  displayName: "Engineer one",
  role: "engineer",
  capabilities: [...ROLE_CAPABILITIES.engineer],
  provider: { name: "codex", model: "codex-mini" },
  softwareVersion: "1.2.0",
  checkpointRef: "checkpoint-41",
  registeredAt: "2026-07-18T18:00:00Z",
  lastSeenAt: "2026-07-18T19:01:02Z",
  leaseExpiresAt: "2026-07-18T19:02:00Z",
  currentAction: {
    taskId: "task-one",
    summary: "Running account recovery tests",
    startedAt: "2026-07-18T19:00:00Z",
  },
  connectionState: "online",
  controlState: "active",
  controlVersion: 8,
  queue: ["task-two"],
});

const snapshot = () => ({
  apiVersion: STEWARD_UI_API_VERSION,
  workspaceId: "workspace-one",
  generatedAt: "2026-07-18T19:01:03Z",
  sequence: 42,
  paused: false,
  controlVersion: 8,
  agents: [agent()],
  tasks: [task()],
  progress: [
    {
      taskId: "task-one",
      phase: "research",
      iteration: 1,
      journal: "Mapped the recovery flow and its user-visible failure modes.",
      occurredAt: "2026-07-18T19:01:02Z",
    },
  ],
});

const assertValidationError = (action: () => unknown): void => {
  assert.throws(action, ProtocolValidationError);
};

describe("supervisor identity and leases", () => {
  test("registration round-trips and does not retain mutable input arrays", () => {
    const input = registration();
    const parsed = parseSupervisorRegistrationRequest(clone(input));

    assert.deepEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.provider), true);
    assert.equal(Object.isFrozen(parsed.capabilities), true);

    input.capabilities.pop();
    assert.equal(parsed.capabilities.length, 4);
  });

  test("registration distinguishes the caller's CAS expectation from the issued epoch", () => {
    const firstClaim = { ...registration(), expectedRuntimeEpoch: null };
    assert.deepEqual(parseSupervisorRegistrationRequest(clone(firstClaim)), firstClaim);

    const accepted = { ...registration(), runtimeEpoch: 4 } as Record<string, unknown>;
    delete accepted.expectedRuntimeEpoch;
    assert.deepEqual(parseSupervisorRegistration(clone(accepted)), accepted);
    assertValidationError(() =>
      parseSupervisorRegistrationRequest({ ...registration(), expectedRuntimeEpoch: 0 }),
    );
    assertValidationError(() =>
      parseSupervisorRegistration({ ...accepted, expectedRuntimeEpoch: 3 }),
    );
  });

  test("registration rejects unknown fields, blank IDs, unsafe epochs, and role drift", () => {
    assertValidationError(() =>
      parseSupervisorRegistrationRequest({ ...registration(), unexpected: true }),
    );
    assertValidationError(() =>
      parseSupervisorRegistrationRequest({ ...registration(), agentId: "   " }),
    );
    assertValidationError(() =>
      parseSupervisorRegistrationRequest({
        ...registration(),
        expectedRuntimeEpoch: Number.MAX_SAFE_INTEGER + 1,
      }),
    );
    assertValidationError(() =>
      parseSupervisorRegistrationRequest({
        ...registration(),
        capabilities: ["research", "plan"],
      }),
    );
  });

  test("registration and lease results require forward lease time", () => {
    const result = {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: "workspace-one",
      agentId: "agent-one",
      laneId: "lane-engineer-one",
      runtimeInstanceId: "runtime-abc",
      runtimeEpoch: 3,
      leaseId: "lease-3",
      leaseGrantedAt: "2026-07-18T19:00:00Z",
      leaseExpiresAt: "2026-07-18T19:01:00Z",
      lastAcceptedLocalSequence: 8,
      controlVersion: 4,
    };
    assert.deepEqual(parseSupervisorRegistrationResult(clone(result)), result);
    assertValidationError(() =>
      parseSupervisorRegistrationResult({
        ...result,
        leaseExpiresAt: result.leaseGrantedAt,
      }),
    );

    const renewal = {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: "workspace-one",
      agentId: "agent-one",
      laneId: "lane-engineer-one",
      runtimeInstanceId: "runtime-abc",
      runtimeEpoch: 3,
      leaseId: "lease-3",
      lastDurableEventSequence: 9,
      sentAt: "2026-07-18T19:00:30Z",
    };
    assert.deepEqual(parseLeaseRenewalRequest(clone(renewal)), renewal);

    const renewalResult = {
      ...result,
      acceptedThroughLocalSequence: 9,
    } as Record<string, unknown>;
    delete renewalResult.lastAcceptedLocalSequence;
    assert.deepEqual(parseLeaseRenewalResult(clone(renewalResult)), renewalResult);
  });
});

describe("tasks and progress", () => {
  test("task timing accepts quarter-hour estimates and exact lifecycle times", () => {
    const parsed = parseAgentTaskProjection(clone(task()));
    assert.deepEqual(parsed, task());
    assert.equal(Object.isFrozen(parsed.subject), true);
    const completed = {
      ...task(),
      status: "completed",
      startedAt: "2026-07-18T19:00:00Z",
      endedAt: "2026-07-18T19:34:22Z",
    };
    assert.deepEqual(parseAgentTaskProjection(clone(completed)), completed);
  });

  test("tasks explicitly bind development or immutable manager-review evidence", () => {
    const parsed = parseAgentTaskProjection(clone(managerReviewTask()));
    assert.deepEqual(parsed, managerReviewTask());
    assert.equal(Object.isFrozen(parsed.subject), true);

    const withoutSubject = clone(task()) as Record<string, unknown>;
    delete withoutSubject.subject;
    assertValidationError(() => parseAgentTaskProjection(withoutSubject));
    assertValidationError(() =>
      parseAgentTaskProjection({
        ...task(),
        subject: { type: "development", evidenceId: "evidence-one" },
      }),
    );
    assertValidationError(() =>
      parseAgentTaskProjection({
        ...managerReviewTask(),
        subject: {
          ...managerReviewTask().subject,
          evidenceDigest: `sha256:${"A".repeat(64)}`,
        },
      }),
    );
    assertValidationError(() =>
      parseAgentTaskProjection({
        ...managerReviewTask(),
        subject: {
          ...managerReviewTask().subject,
          evidenceId: "evidence with spaces",
        },
      }),
    );
    assertValidationError(() =>
      parseAgentTaskProjection({ ...task(), subject: { type: "deployment" } }),
    );
  });

  test("task timing rejects non-quarter deadlines, non-interval durations, and incoherent status", () => {
    assertValidationError(() =>
      parseAgentTaskProjection({ ...task(), expectedAgentMinutes: 44 }),
    );
    assertValidationError(() =>
      parseAgentTaskProjection({
        ...task(),
        expectedAgentMinutes: 7 * 24 * 60 + 15,
      }),
    );
    assertValidationError(() =>
      parseAgentTaskProjection({
        ...task(),
        expectedCompletedAt: "2026-07-18T19:44:00Z",
      }),
    );
    assertValidationError(() =>
      parseAgentTaskProjection({
        ...task(),
        status: "running",
        startedAt: null,
      }),
    );
    assertValidationError(() =>
      parseAgentTaskProjection({
        ...task(),
        expectedCompletedAt: "2026-02-30T19:45:00Z",
      }),
    );
  });

  test("progress models Research, Plan, Execute, and Test outcomes", () => {
    const research = {
      taskId: "task-one",
      phase: "research",
      iteration: 1,
      journal: "Confirmed device loss is the highest-impact recovery gap.",
      occurredAt: "2026-07-18T19:00:00Z",
    };
    assert.deepEqual(parseProgressEvent(clone(research)), research);
    const failedTest = {
      ...research,
      phase: "test",
      journal: "The expired-token case still fails; another loop is required.",
      outcome: "failed",
    };
    assert.deepEqual(parseProgressEvent(clone(failedTest)), failedTest);
  });

  test("progress rejects empty journals and invalid phase/outcome combinations", () => {
    const base = {
      taskId: "task-one",
      phase: "research",
      iteration: 1,
      journal: "Found the user-visible failure.",
      occurredAt: "2026-07-18T19:00:00Z",
    };
    assertValidationError(() => parseProgressEvent({ ...base, journal: "  " }));
    assertValidationError(() =>
      parseProgressEvent({ ...base, outcome: "passed" }),
    );
    assertValidationError(() =>
      parseProgressEvent({ ...base, phase: "test" }),
    );
    assertValidationError(() =>
      parseProgressEvent({ ...base, phase: "ship" }),
    );
  });
});

describe("durable runtime transport", () => {
  test("outbox events and ordered batches round-trip as frozen copies", () => {
    assert.deepEqual(parseDurableOutboxEvent(clone(outboxEvent())), outboxEvent());
    const input = {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: "workspace-one",
      agentId: "agent-one",
      laneId: "lane-engineer-one",
      runtimeInstanceId: "runtime-abc",
      runtimeEpoch: 3,
      events: [outboxEvent(1), outboxEvent(2)],
    };
    const parsed = parseRuntimeEventBatch(clone(input));
    assert.deepEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed.events), true);
    assert.equal(Object.isFrozen(parsed.events[0]?.payload), true);

    for (const payload of [
      {
        type: "hold_acknowledged",
        commandId: "command-hold-1",
        taskId: "task-one",
      },
      {
        type: "hold_settled",
        commandId: "command-hold-1",
        taskId: "task-one",
        checkpointRef: "checkpoint-hold-1",
      },
    ] as const) {
      const event = { ...outboxEvent(), payload };
      assert.deepEqual(parseDurableOutboxEvent(clone(event)), event);
    }
  });

  test("batches reject stale identity, nonmonotonic sequences, and unsafe values", () => {
    const base = {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: "workspace-one",
      agentId: "agent-one",
      laneId: "lane-engineer-one",
      runtimeInstanceId: "runtime-abc",
      runtimeEpoch: 3,
    };
    assertValidationError(() =>
      parseDurableOutboxEvent({ ...outboxEvent(), localSequence: 0 }),
    );
    assertValidationError(() =>
      parseRuntimeEventBatch({
        ...base,
        events: [outboxEvent(2), outboxEvent(1)],
      }),
    );
    assertValidationError(() =>
      parseRuntimeEventBatch({
        ...base,
        events: [{ ...outboxEvent(), runtimeEpoch: 2 }],
      }),
    );
    assertValidationError(() =>
      parseRuntimeEventBatch({
        ...base,
        events: Array.from({ length: 101 }, (_, index) =>
          outboxEvent(index + 1),
        ),
      }),
    );
  });

  test("batch receipts and poll requests expose durable cursors", () => {
    const receipt = {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: "workspace-one",
      agentId: "agent-one",
      laneId: "lane-engineer-one",
      runtimeInstanceId: "runtime-abc",
      runtimeEpoch: 3,
      acceptedThroughLocalSequence: 12,
      controlVersion: 8,
    };
    assert.deepEqual(parseRuntimeEventBatchReceipt(clone(receipt)), receipt);
    const request = {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: "workspace-one",
      agentId: "agent-one",
      laneId: "lane-engineer-one",
      runtimeInstanceId: "runtime-abc",
      runtimeEpoch: 3,
      afterServerSequence: 10,
    };
    assert.deepEqual(parseRuntimeCommandPollRequest(clone(request)), request);
  });

  test("commands are epoch-fenced, identity-bound, and sequence ordered", () => {
    assert.deepEqual(
      parseRuntimeCommandEnvelope(clone(runtimeCommand())),
      runtimeCommand(),
    );
    assertValidationError(() =>
      parseRuntimeCommandEnvelope({
        ...runtimeCommand(),
        payload: {
          type: "assign_task",
          task: { ...task(), laneId: "other-lane" },
        },
      }),
    );
    const poll = {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: "workspace-one",
      agentId: "agent-one",
      laneId: "lane-engineer-one",
      runtimeInstanceId: "runtime-abc",
      runtimeEpoch: 3,
      latestServerSequence: 2,
      commands: [runtimeCommand(1), runtimeCommand(2)],
    };
    assert.deepEqual(parseRuntimeCommandPollResult(clone(poll)), poll);
    assertValidationError(() =>
      parseRuntimeCommandPollResult({
        ...poll,
        commands: [
          { ...runtimeCommand(1), expectedRuntimeEpoch: 2 },
        ],
      }),
    );
    assertValidationError(() =>
      parseRuntimeCommandPollResult({
        ...poll,
        commands: [runtimeCommand(2), runtimeCommand(1)],
      }),
    );
  });

  test("replacement runtimes only recover already-running manager-review tasks", () => {
    const input = recoveryRuntimeCommand();
    const parsed = parseRuntimeCommandEnvelope(clone(input));
    assert.deepEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed.payload), true);
    assert.equal(
      parsed.payload.type === "recover_task" &&
        Object.isFrozen(parsed.payload.task),
      true,
    );

    assertValidationError(() =>
      parseRuntimeCommandEnvelope({
        ...input,
        payload: {
          ...input.payload,
          task: {
            ...input.payload.task,
            subject: { type: "development" },
          },
        },
      }),
    );

    for (const taskState of [
      { status: "queued", startedAt: null, endedAt: null },
      {
        status: "paused",
        startedAt: "2026-07-18T19:15:00Z",
        endedAt: null,
      },
      {
        status: "completed",
        startedAt: "2026-07-18T19:15:00Z",
        endedAt: "2026-07-18T19:29:00Z",
      },
      {
        status: "failed",
        startedAt: "2026-07-18T19:15:00Z",
        endedAt: "2026-07-18T19:29:00Z",
      },
    ]) {
      assertValidationError(() =>
        parseRuntimeCommandEnvelope({
          ...input,
          payload: {
            ...input.payload,
            task: { ...input.payload.task, ...taskState },
          },
        }),
      );
    }

    assertValidationError(() =>
      parseRuntimeCommandEnvelope({
        ...input,
        payload: { ...input.payload, unexpected: true },
      }),
    );
    assertValidationError(() =>
      parseRuntimeCommandEnvelope({
        ...input,
        agentId: "other-manager",
      }),
    );
  });
});

describe("manager-review permit consumption", () => {
  test("requests bind one review task, evidence artifact, manager runtime, and review payload", () => {
    const input = permitConsumeRequest();
    const parsed = parseManagerReviewPermitConsumeRequest(clone(input));
    assert.deepEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed), true);

    assertValidationError(() =>
      parseManagerReviewPermitConsumeRequest({ ...input, extra: true }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeRequest({
        ...input,
        apiVersion: STEWARD_UI_API_VERSION,
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeRequest({
        ...input,
        operationId: " unsafe operation ",
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeRequest({
        ...input,
        runtimeEpoch: Number.MAX_SAFE_INTEGER + 1,
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeRequest({
        ...input,
        runtimeEpoch: 0,
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeRequest({
        ...input,
        evidenceDigest: `sha256:${"A".repeat(64)}`,
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeRequest({
        ...input,
        reviewRequestDigest: `sha256:${"b".repeat(63)}`,
      }),
    );
  });

  test("receipts preserve the authoritative atomic decision and canonical ordering point", () => {
    const input = permitConsumeReceipt();
    const parsed = parseManagerReviewPermitConsumeReceipt(clone(input));
    assert.deepEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed), true);
    assert.deepEqual(
      parseManagerReviewPermitConsumeReceipt({
        ...input,
        state: "duplicate",
      }),
      { ...input, state: "duplicate" },
    );

    assertValidationError(() =>
      parseManagerReviewPermitConsumeReceipt({ ...input, state: "rejected" }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeReceipt({
        ...input,
        permitId: "permit with spaces",
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeReceipt({
        ...input,
        managerRuntimeEpoch: 0,
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeReceipt({
        ...input,
        workspaceSequence: 0,
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeReceipt({
        ...input,
        authorizedAt: "2026-07-18T19:34:22Z",
      }),
    );
    assertValidationError(() =>
      parseManagerReviewPermitConsumeReceipt({
        ...input,
        reviewRequestDigest: `sha256:${"B".repeat(64)}`,
      }),
    );
  });
});

describe("authoritative UI transport", () => {
  test("agent and snapshot projections preserve heartbeat, action, queue, and control state", () => {
    assert.deepEqual(parseRegisteredAgentProjection(clone(agent())), agent());
    const parsed = parseUiSnapshot(clone(snapshot()));
    assert.deepEqual(parsed, snapshot());
    assert.equal(Object.isFrozen(parsed.agents), true);
    assert.equal(Object.isFrozen(parsed.agents[0]?.queue), true);
    assert.equal(Object.isFrozen(parsed.tasks), true);
    assert.equal(Object.isFrozen(parsed.progress), true);
  });

  test("bootstrap carries safe endpoints, identity, permissions, and an aligned cursor", () => {
    const input = {
      apiVersion: STEWARD_UI_API_VERSION,
      sessionId: "session-one",
      userId: "user-one",
      permissions: ["agents:read", "agents:control"],
      features: ["runtime-discovery"],
      snapshot: snapshot(),
      eventStream: {
        href: "/v1/ui/events?workspace=workspace-one",
        afterSequence: 42,
        retentionStartsAtSequence: 1,
        heartbeatIntervalMs: 15_000,
      },
      commandEndpoint: "/v1/ui/commands",
    };
    const parsed = parseUiBootstrap(clone(input));
    assert.deepEqual(parsed, input);
    assert.equal(Object.isFrozen(parsed.permissions), true);
    assert.equal(Object.isFrozen(parsed.eventStream), true);

    assertValidationError(() =>
      parseUiBootstrap({ ...input, commandEndpoint: "https://evil.test/send" }),
    );
    assertValidationError(() =>
      parseUiBootstrap({
        ...input,
        eventStream: { ...input.eventStream, afterSequence: 41 },
      }),
    );
  });

  test("sequenced UI events carry event and optional command causation IDs", () => {
    const input = {
      apiVersion: STEWARD_UI_API_VERSION,
      eventId: "ui-event-43",
      workspaceId: "workspace-one",
      sequence: 43,
      occurredAt: "2026-07-18T19:01:04Z",
      causationClientCommandId: "client-command-8",
      payload: { type: "task_upserted", task: task() },
    };
    assert.deepEqual(parseUiEventEnvelope(clone(input)), input);
    assertValidationError(() =>
      parseUiEventEnvelope({
        ...input,
        payload: {
          type: "task_upserted",
          task: { ...task(), workspaceId: "other-workspace" },
        },
      }),
    );

    const progressInput = {
      ...input,
      payload: {
        type: "progress_recorded",
        progress: snapshot().progress[0],
        task: task(),
      },
    };
    assert.deepEqual(parseUiEventEnvelope(clone(progressInput)), progressInput);
    assertValidationError(() =>
      parseUiEventEnvelope({
        ...progressInput,
        payload: {
          ...progressInput.payload,
          progress: { ...progressInput.payload.progress, taskId: "other-task" },
        },
      }),
    );
  });
});

describe("human control commands", () => {
  test("queue commands carry idempotency, CAS, and agent-only estimates", () => {
    const input = {
      apiVersion: STEWARD_UI_API_VERSION,
      clientCommandId: "client-command-8",
      workspaceId: "workspace-one",
      expectedControlVersion: 8,
      issuedAt: "2026-07-18T19:02:00Z",
      payload: {
        type: "queue_work",
        agentId: "agent-one",
        laneId: "lane-engineer-one",
        title: "Improve account recovery",
        objective: "Users can recover an account after losing a device.",
        expectedAgentMinutes: 45,
        expectedCompletedAt: "2026-07-18T19:45:00Z",
      },
    };
    const parsed = parseHumanCommandEnvelope(clone(input));
    assert.deepEqual(parsed, {
      ...input,
      payload: { ...input.payload, subject: { type: "development" } },
    });
    assert.equal(Object.isFrozen(parsed.payload), true);
    assertValidationError(() =>
      parseHumanCommandEnvelope({
        ...input,
        expectedControlVersion: Number.MAX_SAFE_INTEGER + 1,
      }),
    );
  });

  test("queue commands accept explicit manager-review bindings", () => {
    const input = {
      apiVersion: STEWARD_UI_API_VERSION,
      clientCommandId: "client-command-review",
      workspaceId: "workspace-one",
      expectedControlVersion: 8,
      issuedAt: "2026-07-18T19:02:00Z",
      payload: {
        type: "queue_work",
        agentId: "agent-manager-one",
        laneId: "lane-manager-one",
        subject: managerReviewTask().subject,
        title: "Review account recovery evidence",
        objective: "Determine whether the evidence is ready for human review.",
        expectedAgentMinutes: 15,
        expectedCompletedAt: "2026-07-18T19:15:00Z",
      },
    };
    assert.deepEqual(parseHumanCommandEnvelope(clone(input)), input);
    assertValidationError(() =>
      parseHumanCommandEnvelope({
        ...input,
        payload: {
          ...input.payload,
          subject: {
            ...input.payload.subject,
            evidenceDigest: `sha256:${"a".repeat(65)}`,
          },
        },
      }),
    );
  });

  test("receipts distinguish accepted, duplicate, and strict rejection outcomes", () => {
    const accepted = {
      state: "accepted",
      clientCommandId: "client-command-8",
      workspaceId: "workspace-one",
      acceptedAt: "2026-07-18T19:02:01Z",
      currentControlVersion: 9,
      intentEventSequence: 43,
    };
    assert.deepEqual(parseHumanCommandReceipt(clone(accepted)), accepted);
    assert.deepEqual(
      parseHumanCommandReceipt({ ...accepted, state: "duplicate" }),
      { ...accepted, state: "duplicate" },
    );
    const rejected = {
      state: "rejected",
      clientCommandId: "client-command-8",
      workspaceId: "workspace-one",
      rejectedAt: "2026-07-18T19:02:01Z",
      currentControlVersion: 9,
      code: "VERSION_CONFLICT",
      reason: "The lane changed after this screen was loaded.",
    };
    assert.deepEqual(parseHumanCommandReceipt(clone(rejected)), rejected);
    assertValidationError(() =>
      parseHumanCommandReceipt({ ...rejected, code: "RETRY_LATER" }),
    );
    assertValidationError(() =>
      parseHumanCommandReceipt({ ...rejected, acceptedAt: rejected.rejectedAt }),
    );
  });
});
