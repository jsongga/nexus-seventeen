import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_RUNTIME_FEATURES_HEADER,
  STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
  STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER,
  STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
  STEWARD_UI_API_VERSION,
  parseManagerReviewPermitConsumeReceipt,
} from '#shared/protocol';
import { createControlPlane, type ControlPlaneService } from '#server/control-plane';

const WORKSPACE_ID = 'workspace-alpha';
const ENGINEER_AGENT_ID = 'agent-engineer';
const ENGINEER_LANE_ID = 'lane-engineer';
const MANAGER_AGENT_ID = 'agent-manager';
const MANAGER_LANE_ID = 'lane-manager';
const ENGINEER_TOKEN = 'engineer-runtime-token-123456';
const MANAGER_TOKEN = 'manager-runtime-token-123456';
const HUMAN_TOKEN = 'human-control-token-123456';
const OBSERVER_TOKEN = 'observer-read-token-123456';
const PERMIT_TOKEN = 'manager-review-permit-token-123456';
const EVIDENCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const REVIEW_DIGEST = `sha256:${'b'.repeat(64)}`;
const ENGINEER_CHALLENGE = `rgc_${'e'.repeat(43)}`;
const MANAGER_CHALLENGE = `rgc_${'m'.repeat(43)}`;

const cleanup: Array<{ directory: string; service: ControlPlaneService }> = [];

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.service.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function requestJson(
  baseUrl: string,
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function registration(
  role: 'engineer' | 'manager',
  runtimeInstanceId: string,
  expectedRuntimeEpoch: number | null,
) {
  const manager = role === 'manager';
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: WORKSPACE_ID,
    agentId: manager ? MANAGER_AGENT_ID : ENGINEER_AGENT_ID,
    laneId: manager ? MANAGER_LANE_ID : ENGINEER_LANE_ID,
    runtimeInstanceId,
    expectedRuntimeEpoch,
    displayName: manager ? 'Review manager' : 'Engineer',
    role,
    capabilities: ROLE_CAPABILITIES[role],
    provider: { name: 'codex', model: manager ? 'gpt-5.4-mini' : 'gpt-5.4' },
    softwareVersion: '0.1.0',
    checkpointRef: null,
  };
}

function runtimeEvent(
  identity: {
    agentId: string;
    laneId: string;
    runtimeInstanceId: string;
    runtimeEpoch: number;
  },
  localSequence: number,
  occurredAt: string,
  payload: Record<string, unknown>,
) {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    eventId: `event-${identity.laneId}-${identity.runtimeEpoch}-${localSequence}`,
    workspaceId: WORKSPACE_ID,
    ...identity,
    localSequence,
    occurredAt,
    payload,
  };
}

async function postRuntimeEvents(
  baseUrl: string,
  token: string,
  identity: {
    agentId: string;
    laneId: string;
    runtimeInstanceId: string;
    runtimeEpoch: number;
  },
  events: readonly ReturnType<typeof runtimeEvent>[],
) {
  const result = await requestJson(baseUrl, '/v1/runtime/events', token, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: WORKSPACE_ID,
    ...identity,
    events,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function postHumanCommand(
  baseUrl: string,
  clientCommandId: string,
  expectedControlVersion: number,
  payload: Record<string, unknown>,
) {
  const result = await requestJson(baseUrl, '/v1/ui/commands', HUMAN_TOKEN, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId,
    workspaceId: WORKSPACE_ID,
    expectedControlVersion,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function createReadyFixture(options: { typedTasks?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'steward-review-permit-'));
  let now = new Date('2026-07-18T20:00:10.000Z');
  const pendingClockValues: Date[] = [];
  const service = await createControlPlane({
    workspaceId: WORKSPACE_ID,
    storePath: join(directory, 'events.jsonl'),
    workloadIdentities: [
      {
        workspaceId: WORKSPACE_ID,
        agentId: ENGINEER_AGENT_ID,
        laneId: ENGINEER_LANE_ID,
        role: 'engineer',
        token: ENGINEER_TOKEN,
      },
      {
        workspaceId: WORKSPACE_ID,
        agentId: MANAGER_AGENT_ID,
        laneId: MANAGER_LANE_ID,
        role: 'manager',
        token: MANAGER_TOKEN,
      },
    ],
    humanToken: HUMAN_TOKEN,
    observerReadToken: OBSERVER_TOKEN,
    managerReviewPermitToken: PERMIT_TOKEN,
    leaseMs: 60_000,
    now: () => new Date(pendingClockValues.shift() ?? now),
  });
  cleanup.push({ directory, service });
  const { url } = await service.start();

  let managerProof = '';
  for (const [token, body, challenge] of [
    [ENGINEER_TOKEN, registration('engineer', 'runtime-engineer-1', null), ENGINEER_CHALLENGE],
    [MANAGER_TOKEN, registration('manager', 'runtime-manager-1', null), MANAGER_CHALLENGE],
  ] as const) {
    const result = await requestJson(url, '/v1/runtime/register', token, body, {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: challenge,
      ...(options.typedTasks === false
        ? {}
        : { [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE }),
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    if (token === MANAGER_TOKEN) {
      managerProof = result.response.headers.get(STEWARD_RUNTIME_GENERATION_PROOF_HEADER) ?? '';
    }
  }
  assert.match(managerProof, /^rgp_[A-Za-z0-9_-]{43}$/u);

  await postHumanCommand(url, 'source-work', 0, {
    type: 'queue_work',
    agentId: ENGINEER_AGENT_ID,
    laneId: ENGINEER_LANE_ID,
    title: 'Ship the accessible task controls',
    objective: 'Complete the research, plan, execute, and passing test loop.',
    expectedAgentMinutes: 15,
    expectedCompletedAt: '2026-07-18T20:15:00.000Z',
  });
  const sourceTaskId = 'task_source-work';
  const engineerIdentity = {
    agentId: ENGINEER_AGENT_ID,
    laneId: ENGINEER_LANE_ID,
    runtimeInstanceId: 'runtime-engineer-1',
    runtimeEpoch: 1,
  };
  const phases = [
    { type: 'progress', taskId: sourceTaskId, phase: 'research', iteration: 1, journal: 'Inspected the user flow and constraints.' },
    { type: 'progress', taskId: sourceTaskId, phase: 'plan', iteration: 1, journal: 'Recorded the smallest safe delivery plan.' },
    { type: 'progress', taskId: sourceTaskId, phase: 'execute', iteration: 1, journal: 'Implemented the requested behavior.' },
    { type: 'progress', taskId: sourceTaskId, phase: 'test', iteration: 1, journal: 'All scoped checks passed.', outcome: 'passed' },
    { type: 'task_completed', taskId: sourceTaskId, result: 'Users can now control tasks accessibly.', checkpointRef: null },
  ];
  await postRuntimeEvents(
    url,
    ENGINEER_TOKEN,
    engineerIdentity,
    phases.map((payload, index) =>
      runtimeEvent(
        engineerIdentity,
        index + 1,
        `2026-07-18T20:00:0${index + 1}.000Z`,
        payload,
      ),
    ),
  );

  await postHumanCommand(url, 'assign-review', 1, {
    type: 'queue_work',
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    subject: {
      type: 'manager_review',
      sourceTaskId,
      evidenceId: 'evidence-alpha',
      evidenceDigest: EVIDENCE_DIGEST,
    },
    title: 'Review the passing delivery evidence',
    objective: 'Check the immutable result and identify remaining user risk.',
    expectedAgentMinutes: 15,
    expectedCompletedAt: '2026-07-18T20:15:00.000Z',
  });
  const reviewTaskId = 'task_assign-review';
  const managerIdentity = {
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    runtimeInstanceId: 'runtime-manager-1',
    runtimeEpoch: 1,
  };
  await postRuntimeEvents(url, MANAGER_TOKEN, managerIdentity, [
    runtimeEvent(managerIdentity, 1, '2026-07-18T20:00:11.000Z', {
      type: 'heartbeat',
      currentAction: {
        taskId: reviewTaskId,
        summary: 'Checking the assigned immutable evidence and user impact.',
        startedAt: '2026-07-18T20:00:11.000Z',
      },
      checkpointRef: null,
    }),
  ]);
  now = new Date('2026-07-18T20:00:12.000Z');

  return {
    url,
    service,
    sourceTaskId,
    reviewTaskId,
    managerProof,
    setNow(value: string) {
      now = new Date(value);
    },
    setNowSequence(...values: string[]) {
      pendingClockValues.push(...values.map((value) => new Date(value)));
    },
  };
}

function permitRequest(
  sourceTaskId: string,
  reviewTaskId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    operationId: 'review-operation-alpha',
    workspaceId: WORKSPACE_ID,
    reviewTaskId,
    sourceTaskId,
    evidenceId: 'evidence-alpha',
    evidenceDigest: EVIDENCE_DIGEST,
    managerAgentId: MANAGER_AGENT_ID,
    managerLaneId: MANAGER_LANE_ID,
    runtimeInstanceId: 'runtime-manager-1',
    runtimeEpoch: 1,
    reviewRequestDigest: REVIEW_DIGEST,
    ...overrides,
  };
}

test('one-use review permits are task-bound, ordered with controls, and recover across replacement', async () => {
  const fixture = await createReadyFixture();
  const request = permitRequest(fixture.sourceTaskId, fixture.reviewTaskId);

  const prooflessRegistrationReplay = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-1', null),
    { [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE },
  );
  assert.equal(prooflessRegistrationReplay.response.status, 200);
  assert.equal(
    prooflessRegistrationReplay.response.headers.get(
      STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
    ),
    null,
  );

  const changedChallengeReplay = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-1', null),
    {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${'w'.repeat(43)}`,
      [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
    },
  );
  assert.equal(changedChallengeReplay.response.status, 409);
  assert.equal(
    (changedChallengeReplay.body.error as { code: string }).code,
    'RUNTIME_PROOF_CHALLENGE_CONFLICT',
  );
  assert.equal(
    changedChallengeReplay.response.headers.get(
      STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
    ),
    null,
  );

  const exactRegistrationReplay = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-1', null),
    {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: MANAGER_CHALLENGE,
      [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
    },
  );
  assert.equal(exactRegistrationReplay.response.status, 200);
  assert.equal(
    exactRegistrationReplay.response.headers.get(
      STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
    ),
    fixture.managerProof,
  );

  const tokenOnlyReplacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-attacker', 1),
    {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${'x'.repeat(43)}`,
      [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
    },
  );
  assert.equal(tokenOnlyReplacement.response.status, 409);
  assert.equal(
    (tokenOnlyReplacement.body.error as { code: string }).code,
    'RUNTIME_REPLACEMENT_PROOF_REQUIRED',
  );

  const spoofedCurrentGeneration = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    { ...request, operationId: 'review-operation-spoofed-generation' },
    { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: `rgp_${'x'.repeat(43)}` },
  );
  assert.equal(spoofedCurrentGeneration.response.status, 409);
  assert.equal(
    (spoofedCurrentGeneration.body.error as { code: string }).code,
    'RUNTIME_GENERATION_PROOF_REJECTED',
  );

  for (const wrongToken of [OBSERVER_TOKEN, HUMAN_TOKEN, MANAGER_TOKEN]) {
    const denied = await requestJson(
      fixture.url,
      '/v1/internal/manager-review-permits/consume',
      wrongToken,
      request,
      { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof },
    );
    assert.equal(denied.response.status, 401);
    assert.equal((denied.body.error as { code: string }).code, 'UNAUTHORIZED');
  }

  const wrongBinding = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    permitRequest(fixture.sourceTaskId, fixture.reviewTaskId, {
      operationId: 'review-operation-wrong-evidence',
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
    }),
    { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof },
  );
  assert.equal(wrongBinding.response.status, 409);
  assert.equal(
    (wrongBinding.body.error as { code: string }).code,
    'REVIEW_TASK_SUBJECT_CONFLICT',
  );

  const consumed = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    request,
    { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof },
  );
  assert.equal(consumed.response.status, 200, JSON.stringify(consumed.body));
  const receipt = parseManagerReviewPermitConsumeReceipt(consumed.body);
  assert.equal(receipt.state, 'accepted');
  assert.equal(receipt.authorizedAt, '2026-07-18T20:00:12.000Z');
  assert.equal(receipt.managerRuntimeInstanceId, 'runtime-manager-1');
  assert.equal(receipt.managerRuntimeEpoch, 1);
  assert.equal(fixture.service.projection.requireTask(fixture.reviewTaskId).status, 'completed');
  assert.equal(fixture.service.projection.requireLane(MANAGER_LANE_ID).currentAction, null);
  assert.equal(fixture.service.projection.reviewPermitsByEvidence.get('evidence-alpha')?.permitId, receipt.permitId);
  assert.equal(fixture.service.store.records.at(-1)?.kind, 'manager.review_permit_consumed');

  const changedReuse = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    { ...request, reviewRequestDigest: `sha256:${'d'.repeat(64)}` },
  );
  assert.equal(changedReuse.response.status, 409);
  assert.equal(
    (changedReuse.body.error as { code: string }).code,
    'REVIEW_PERMIT_IDEMPOTENCY_CONFLICT',
  );

  fixture.setNow('2026-07-18T20:00:13.000Z');
  const replacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-2', 1),
    {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${'r'.repeat(43)}`,
      [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof,
      [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
    },
  );
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));
  assert.equal(replacement.body.runtimeEpoch, 2);
  const replacementProof =
    replacement.response.headers.get(STEWARD_RUNTIME_GENERATION_PROOF_HEADER) ?? '';
  assert.match(replacementProof, /^rgp_[A-Za-z0-9_-]{43}$/u);

  const staleProcessLeapfrog = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-stale-leapfrog', 2),
    {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${'t'.repeat(43)}`,
      [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof,
      [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
    },
  );
  assert.equal(staleProcessLeapfrog.response.status, 409);
  assert.equal(
    (staleProcessLeapfrog.body.error as { code: string }).code,
    'RUNTIME_REPLACEMENT_PROOF_REQUIRED',
  );

  const staleProofForCurrentGeneration = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    permitRequest(fixture.sourceTaskId, fixture.reviewTaskId, {
      operationId: 'review-operation-stale-proof',
      runtimeInstanceId: 'runtime-manager-2',
      runtimeEpoch: 2,
    }),
    { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof },
  );
  assert.equal(staleProofForCurrentGeneration.response.status, 409);
  assert.equal(
    (staleProofForCurrentGeneration.body.error as { code: string }).code,
    'RUNTIME_GENERATION_PROOF_REJECTED',
  );

  const recovered = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    { ...request, runtimeInstanceId: 'runtime-manager-2', runtimeEpoch: 2 },
  );
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
  const recoveredReceipt = parseManagerReviewPermitConsumeReceipt(recovered.body);
  assert.equal(recoveredReceipt.state, 'duplicate');
  assert.equal(recoveredReceipt.permitId, receipt.permitId);
  assert.equal(recoveredReceipt.authorizedAt, receipt.authorizedAt);
  assert.equal(recoveredReceipt.workspaceSequence, receipt.workspaceSequence);
  assert.equal(recoveredReceipt.managerRuntimeInstanceId, 'runtime-manager-1');
  assert.equal(recoveredReceipt.managerRuntimeEpoch, 1);

  const secondOperation = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    permitRequest(fixture.sourceTaskId, fixture.reviewTaskId, {
      operationId: 'review-operation-second',
      runtimeInstanceId: 'runtime-manager-2',
      runtimeEpoch: 2,
    }),
    { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: replacementProof },
  );
  assert.equal(secondOperation.response.status, 409);
  assert.equal(
    (secondOperation.body.error as { code: string }).code,
    'REVIEW_TASK_ALREADY_PERMITTED',
  );

  await postHumanCommand(fixture.url, 'assign-review-two', 2, {
    type: 'queue_work',
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    subject: {
      type: 'manager_review',
      sourceTaskId: fixture.sourceTaskId,
      evidenceId: 'evidence-beta',
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
    },
    title: 'Review the second evidence projection',
    objective: 'Check this exact evidence before any human production decision.',
    expectedAgentMinutes: 15,
    expectedCompletedAt: '2026-07-18T20:15:00.000Z',
  });
  const reviewTaskTwo = 'task_assign-review-two';
  const replacementIdentity = {
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    runtimeInstanceId: 'runtime-manager-2',
    runtimeEpoch: 2,
  };
  fixture.setNow('2026-07-18T20:00:14.000Z');
  await postRuntimeEvents(fixture.url, MANAGER_TOKEN, replacementIdentity, [
    runtimeEvent(replacementIdentity, 2, '2026-07-18T20:00:14.000Z', {
      type: 'heartbeat',
      currentAction: {
        taskId: reviewTaskTwo,
        summary: 'Reviewing the second assigned evidence item.',
        startedAt: '2026-07-18T20:00:14.000Z',
      },
      checkpointRef: null,
    }),
  ]);
  await postHumanCommand(fixture.url, 'interrupt-manager', 3, {
    type: 'request_interrupt',
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    reason: 'Human requested a closer look before the decision is recorded.',
  });
  const afterInterrupt = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    permitRequest(fixture.sourceTaskId, reviewTaskTwo, {
      operationId: 'review-operation-after-interrupt',
      evidenceId: 'evidence-beta',
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      runtimeInstanceId: 'runtime-manager-2',
      runtimeEpoch: 2,
    }),
    { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: replacementProof },
  );
  assert.equal(afterInterrupt.response.status, 409);
  assert.equal(
    (afterInterrupt.body.error as { code: string }).code,
    'MANAGER_RUNTIME_NOT_ACTIVE',
  );
  assert.equal(fixture.service.projection.requireTask(reviewTaskTwo).status, 'running');
});

test('review assignments fail closed on role, source, and duplicate evidence conflicts', async () => {
  const fixture = await createReadyFixture();

  const developmentForManager = await requestJson(fixture.url, '/v1/ui/commands', HUMAN_TOKEN, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'manager-development',
    workspaceId: WORKSPACE_ID,
    expectedControlVersion: 2,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: MANAGER_AGENT_ID,
      laneId: MANAGER_LANE_ID,
      title: 'Unsafe modifying work',
      objective: 'This must not enter a manager lane.',
      expectedAgentMinutes: 15,
      expectedCompletedAt: '2026-07-18T20:15:00.000Z',
    },
  });
  assert.equal(developmentForManager.response.status, 409);
  assert.equal(
    (developmentForManager.body.error as { code: string }).code,
    'TASK_ROLE_CONFLICT',
  );

  const reviewForEngineer = await requestJson(fixture.url, '/v1/ui/commands', HUMAN_TOKEN, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'engineer-review',
    workspaceId: WORKSPACE_ID,
    expectedControlVersion: 2,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: ENGINEER_AGENT_ID,
      laneId: ENGINEER_LANE_ID,
      subject: {
        type: 'manager_review',
        sourceTaskId: fixture.sourceTaskId,
        evidenceId: 'evidence-other',
        evidenceDigest: `sha256:${'f'.repeat(64)}`,
      },
      title: 'Self-review attempt',
      objective: 'This must be rejected by fixed-role assignment policy.',
      expectedAgentMinutes: 15,
      expectedCompletedAt: '2026-07-18T20:15:00.000Z',
    },
  });
  assert.equal(reviewForEngineer.response.status, 409);
  assert.equal(
    (reviewForEngineer.body.error as { code: string }).code,
    'REVIEW_TASK_ROLE_CONFLICT',
  );

  const duplicateAssignment = await requestJson(fixture.url, '/v1/ui/commands', HUMAN_TOKEN, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'duplicate-review-assignment',
    workspaceId: WORKSPACE_ID,
    expectedControlVersion: 2,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: MANAGER_AGENT_ID,
      laneId: MANAGER_LANE_ID,
      subject: {
        type: 'manager_review',
        sourceTaskId: fixture.sourceTaskId,
        evidenceId: 'evidence-alpha',
        evidenceDigest: EVIDENCE_DIGEST,
      },
      title: 'Duplicate evidence assignment',
      objective: 'This exact evidence already has a non-failed assignment.',
      expectedAgentMinutes: 15,
      expectedCompletedAt: '2026-07-18T20:15:00.000Z',
    },
  });
  assert.equal(duplicateAssignment.response.status, 409);
  assert.equal(
    (duplicateAssignment.body.error as { code: string }).code,
    'REVIEW_ASSIGNMENT_EXISTS',
  );
});

test('permit authorization commits the exact timestamp used for the lease boundary check', async () => {
  const fixture = await createReadyFixture();
  fixture.setNowSequence(
    '2026-07-18T20:01:10.000Z',
    '2026-07-18T20:01:10.001Z',
  );
  const consumed = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    permitRequest(fixture.sourceTaskId, fixture.reviewTaskId, {
      operationId: 'review-operation-lease-boundary',
    }),
    { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof },
  );
  assert.equal(consumed.response.status, 200, JSON.stringify(consumed.body));
  const receipt = parseManagerReviewPermitConsumeReceipt(consumed.body);
  assert.equal(receipt.authorizedAt, '2026-07-18T20:01:10.000Z');
  assert.equal(
    fixture.service.store.records.at(-1)?.occurredAt,
    '2026-07-18T20:01:10.000Z',
  );
});

test('a replacement manager is reissued an unpermitted running review task', async () => {
  const fixture = await createReadyFixture();
  fixture.setNow('2026-07-18T20:00:12.000Z');
  const replacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-recovery', 1),
    {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${'s'.repeat(43)}`,
      [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof,
      [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
    },
  );
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));
  assert.equal(replacement.body.runtimeEpoch, 2);
  assert.equal(fixture.service.projection.requireTask(fixture.reviewTaskId).status, 'running');
  assert.equal(fixture.service.projection.requireLane(MANAGER_LANE_ID).currentAction, null);

  const commands = await requestJson(
    fixture.url,
    `/v1/runtime/commands?workspaceId=${WORKSPACE_ID}&agentId=${MANAGER_AGENT_ID}` +
      `&laneId=${MANAGER_LANE_ID}&runtimeInstanceId=runtime-manager-recovery&runtimeEpoch=2&after=0`,
    MANAGER_TOKEN,
    undefined,
    { [STEWARD_RUNTIME_FEATURES_HEADER]: STEWARD_RUNTIME_TYPED_TASKS_FEATURE },
  );
  assert.equal(commands.response.status, 200, JSON.stringify(commands.body));
  const assigned = (commands.body.commands as Array<{
    expectedRuntimeEpoch: number;
    payload: { type: string; task?: { taskId?: string } };
  }>).find(
    (command) =>
      command.expectedRuntimeEpoch === 2 &&
      command.payload.type === 'recover_task' &&
      command.payload.task?.taskId === fixture.reviewTaskId,
  );
  assert.ok(assigned, 'replacement epoch must receive the running unpermitted review task');

  const replacementIdentity = {
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    runtimeInstanceId: 'runtime-manager-recovery',
    runtimeEpoch: 2,
  };
  fixture.setNow('2026-07-18T20:00:13.000Z');
  await postRuntimeEvents(fixture.url, MANAGER_TOKEN, replacementIdentity, [
    runtimeEvent(replacementIdentity, 2, '2026-07-18T20:00:13.000Z', {
      type: 'heartbeat',
      currentAction: {
        taskId: fixture.reviewTaskId,
        summary: 'Resuming the exact assigned evidence review after replacement.',
        startedAt: '2026-07-18T20:00:13.000Z',
      },
      checkpointRef: null,
    }),
  ]);
  const consumed = await requestJson(
    fixture.url,
    '/v1/internal/manager-review-permits/consume',
    PERMIT_TOKEN,
    permitRequest(fixture.sourceTaskId, fixture.reviewTaskId, {
      runtimeInstanceId: 'runtime-manager-recovery',
      runtimeEpoch: 2,
    }),
    {
      [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]:
        replacement.response.headers.get(STEWARD_RUNTIME_GENERATION_PROOF_HEADER) ?? '',
    },
  );
  assert.equal(consumed.response.status, 200, JSON.stringify(consumed.body));
  const receipt = parseManagerReviewPermitConsumeReceipt(consumed.body);
  assert.equal(receipt.state, 'accepted');
  assert.equal(receipt.managerRuntimeInstanceId, 'runtime-manager-recovery');
  assert.equal(receipt.managerRuntimeEpoch, 2);
});

test('legacy v1 polls receive only old command variants and subject-free task bodies', async () => {
  const fixture = await createReadyFixture({ typedTasks: false });
  await postHumanCommand(fixture.url, 'legacy-queued-review', 2, {
    type: 'queue_work',
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    subject: {
      type: 'manager_review',
      sourceTaskId: fixture.sourceTaskId,
      evidenceId: 'evidence-legacy-queued',
      evidenceDigest: `sha256:${'9'.repeat(64)}`,
    },
    title: 'Review queued evidence after the active item',
    objective: 'Keep this assignment queued while the first review remains active.',
    expectedAgentMinutes: 15,
    expectedCompletedAt: '2026-07-18T20:15:00.000Z',
  });

  const replacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    MANAGER_TOKEN,
    registration('manager', 'runtime-manager-legacy-v1', 1),
    {
      [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${'l'.repeat(43)}`,
      [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: fixture.managerProof,
    },
  );
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));

  const polled = await requestJson(
    fixture.url,
    `/v1/runtime/commands?workspaceId=${WORKSPACE_ID}&agentId=${MANAGER_AGENT_ID}` +
      `&laneId=${MANAGER_LANE_ID}&runtimeInstanceId=runtime-manager-legacy-v1&runtimeEpoch=2&after=0`,
    MANAGER_TOKEN,
  );
  assert.equal(polled.response.status, 200, JSON.stringify(polled.body));
  const commands = polled.body.commands as Array<Record<string, unknown>>;
  assert.equal(commands.length, 1);
  const payload = commands[0]!.payload as { type?: unknown; task?: Record<string, unknown> };
  assert.equal(payload.type, 'assign_task');
  assert.ok(payload.task);
  assert.equal(Object.hasOwn(payload.task, 'subject'), false);
  assert.equal(
    commands.some((command) =>
      (command.payload as { type?: unknown }).type === 'recover_task'),
    false,
  );
});
