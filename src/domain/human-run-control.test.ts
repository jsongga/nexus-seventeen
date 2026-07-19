import { describe, expect, it } from 'vitest';

import { advanceEngineeringLoop, startEngineeringLoop } from './engineering-loop';
import { agentExpectedMinutes, type AgentExpectedMinutes } from './agent-task';
import {
  acknowledgeAgentRunInterruption,
  agentLaneId,
  agentRunId,
  canAgentRun,
  completeAgentRunAttempt,
  createEngineeringRunControlState,
  createHumanRunControlState,
  queueAgentWork,
  queuedWorkId,
  reconcileAgentRunStillRunning,
  replaceAgentRunAttempt,
  requestAgentRunInterruption,
  resumeAgentRun,
  runControlSignalId,
  settleAgentRunInterruption,
  startAgentRunAttempt,
} from './human-run-control';
import { hasCapability } from './roles';
import { SEED_AGENTS, SEED_HUMAN, SEED_RELEASE } from './seed';
import { isoDateTime } from './types';
import type {
  AgentActor,
  EngineeringLoop,
  HumanActor,
  HumanRunControlState,
  InterruptionOutcome,
  PolicyDecision,
  Principal,
  ServiceActor,
} from './index';

const ENGINEER_PROFILE = SEED_AGENTS.find((agent) => agent.role === 'engineer');
if (!ENGINEER_PROFILE) {
  throw new Error('Seed data must include an engineer.');
}

const ENGINEER: AgentActor = {
  kind: 'agent',
  id: ENGINEER_PROFILE.id,
  name: ENGINEER_PROFILE.name,
  role: 'engineer',
};

const WORKER: ServiceActor = {
  kind: 'service',
  id: 'orchestration-worker',
  name: 'Orchestration worker',
};

const OBSERVER: ServiceActor = {
  kind: 'service',
  id: 'impact-observer',
  name: 'Impact observer',
};

const UNAUTHENTICATED_HUMAN: HumanActor = {
  ...SEED_HUMAN,
  authenticated: false,
};

const LANE_ID = agentLaneId('lane-checkout-engineer');
const RUN_ID = agentRunId('run-142');
const NATURAL_COMPLETION_EVIDENCE =
  'Provider terminal event evt-natural-142 reported a successful natural exit.';

function value<Value>(decision: PolicyDecision<Value>): Value {
  if (!decision.allowed) {
    throw new Error(`${decision.code}: ${decision.reason}`);
  }
  return decision.value;
}

function executingLoop(): EngineeringLoop {
  let loop = value(
    startEngineeringLoop({
      projectId: SEED_RELEASE.projectId,
      workItemId: SEED_RELEASE.workItemId,
      actor: ENGINEER,
      progress: {
        summary: 'Researching how retry behavior affects checkout completion.',
        recordedAt: isoDateTime('2026-07-18T21:00:00.000Z'),
      },
    }),
  );
  loop = value(
    advanceEngineeringLoop({
      loop,
      actor: ENGINEER,
      to: 'plan',
      progress: {
        summary: 'Planned an idempotent confirmation path and its acceptance checks.',
        recordedAt: isoDateTime('2026-07-18T21:01:00.000Z'),
      },
    }),
  );
  return value(
    advanceEngineeringLoop({
      loop,
      actor: ENGINEER,
      to: 'execute',
      progress: {
        summary: 'Implementing the confirmation path in the development environment.',
        recordedAt: isoDateTime('2026-07-18T21:02:00.000Z'),
      },
    }),
  );
}

function initialControl(loop = executingLoop()): HumanRunControlState {
  return createEngineeringRunControlState(RUN_ID, loop, LANE_ID);
}

function queue(
  control: HumanRunControlState,
  ordinal: number,
  actor: Principal = SEED_HUMAN,
  queuedAt = ordinal === 1
    ? isoDateTime('2026-07-18T21:03:00.000Z')
    : isoDateTime('2026-07-18T21:04:00.000Z'),
): PolicyDecision<HumanRunControlState> {
  return queueAgentWork({
    control,
    actor,
    workId: queuedWorkId(`queued-${ordinal}`),
    signalId: runControlSignalId(`signal-queue-${ordinal}`),
    title: ordinal === 1 ? 'Explain the recovery state' : 'Add a customer-facing retry notice',
    desiredOutcome:
      ordinal === 1
        ? 'Support can tell whether a payment is safely recovering.'
        : 'Customers understand that retrying will not create another charge.',
    expectedAgentMinutes: agentExpectedMinutes(30),
    queuedAt,
  });
}

function request(
  control: HumanRunControlState,
  actor: Principal = SEED_HUMAN,
): PolicyDecision<HumanRunControlState> {
  return requestAgentRunInterruption({
    control,
    actor,
    signalId: runControlSignalId('signal-interrupt-request'),
    requestedAt: isoDateTime('2026-07-18T21:05:00.000Z'),
    reason: 'A human needs to clarify the expected customer message.',
  });
}

function acknowledge(
  control: HumanRunControlState,
  actor: Principal = WORKER,
): PolicyDecision<HumanRunControlState> {
  return acknowledgeAgentRunInterruption({
    control,
    actor,
    runId: RUN_ID,
    signalId: runControlSignalId('signal-interrupt-ack'),
    acknowledgedAt: isoDateTime('2026-07-18T21:05:10.000Z'),
  });
}

function settle(
  control: HumanRunControlState,
  outcome: InterruptionOutcome = 'interrupted',
  actor: Principal = WORKER,
): PolicyDecision<HumanRunControlState> {
  return settleAgentRunInterruption({
    control,
    actor,
    runId: RUN_ID,
    signalId: runControlSignalId(`signal-interrupt-${outcome}`),
    outcome,
    settledAt: isoDateTime('2026-07-18T21:05:20.000Z'),
  });
}

function settledInterruption(
  outcome: InterruptionOutcome = 'interrupted',
): HumanRunControlState {
  return value(settle(value(acknowledge(value(request(initialControl())))), outcome));
}

function resume(
  control: HumanRunControlState,
  actor: Principal = SEED_HUMAN,
): PolicyDecision<HumanRunControlState> {
  return resumeAgentRun({
    control,
    actor,
    signalId: runControlSignalId('signal-resume'),
    resumedAt: isoDateTime('2026-07-18T21:06:00.000Z'),
  });
}

describe('human agent run control', () => {
  it('grants queue, interrupt, and resume capabilities only to the human role', () => {
    for (const capability of [
      'agent.work.queue',
      'agent.run.interrupt',
      'agent.run.resume',
    ] as const) {
      expect(hasCapability('human_approver', capability)).toBe(true);
      for (const agent of ['manager', 'engineer', 'verifier'] as const) {
        expect(hasCapability(agent, capability)).toBe(false);
      }
    }
  });

  it('binds queued work to a stable lane and accepts it while the lane is idle', () => {
    const idle = createHumanRunControlState({
      laneId: LANE_ID,
      agentId: ENGINEER.id,
    });
    const queued = value(queue(idle, 1));

    expect(queued.status).toBe('idle');
    expect(queued.activeRunId).toBeUndefined();
    expect(queued.queue[0]).toMatchObject({
      laneId: LANE_ID,
      agentId: ENGINEER.id,
      position: 1,
      expectedAgentMinutes: 30,
    });
    expect(queued.queue[0]).not.toHaveProperty('runId');
    expect(queued.signals[0]?.runId).toBeUndefined();
    expect(queued.signals[0]?.expectedAgentMinutes).toBe(30);

    const started = value(
      startAgentRunAttempt({
        control: queued,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId('signal-start'),
        startedAt: isoDateTime('2026-07-18T21:03:30.000Z'),
      }),
    );
    expect(started.status).toBe('running');
    expect(started.activeRunId).toBe(RUN_ID);
    expect(started.queue).toEqual(queued.queue);
  });

  it('keeps lane work in FIFO order through interruption states', () => {
    const original = initialControl();
    let control = value(queue(original, 1));
    control = value(request(control));
    control = value(queue(control, 2, SEED_HUMAN, isoDateTime('2026-07-18T21:05:05.000Z')));

    expect(control.status).toBe('interrupt_requested');
    expect(control.queue.map((item) => item.position)).toEqual([1, 2]);
    expect(control.queue.map((item) => item.id)).toEqual([
      queuedWorkId('queued-1'),
      queuedWorkId('queued-2'),
    ]);
    expect(control.queue.every((item) => item.laneId === LANE_ID)).toBe(true);
    expect(original.queue).toEqual([]);
  });

  it('keeps explicit next-up work ahead of backlog without reordering either bucket', () => {
    let control = value(queue(initialControl(), 1));
    control = value(
      queueAgentWork({
        control,
        actor: SEED_HUMAN,
        workId: queuedWorkId('queued-next-1'),
        signalId: runControlSignalId('signal-next-1'),
        title: 'First next-up result',
        desiredOutcome: 'The first urgent human outcome is handled first.',
        expectedAgentMinutes: agentExpectedMinutes(15),
        priority: 'next',
        queuedAt: isoDateTime('2026-07-18T21:04:00.000Z'),
      }),
    );
    control = value(
      queueAgentWork({
        control,
        actor: SEED_HUMAN,
        workId: queuedWorkId('queued-next-2'),
        signalId: runControlSignalId('signal-next-2'),
        title: 'Second next-up result',
        desiredOutcome: 'The second urgent outcome stays behind the first.',
        expectedAgentMinutes: agentExpectedMinutes(30),
        priority: 'next',
        queuedAt: isoDateTime('2026-07-18T21:04:30.000Z'),
      }),
    );

    expect(control.queue.map((item) => [item.id, item.priority, item.position])).toEqual([
      [queuedWorkId('queued-next-1'), 'next', 1],
      [queuedWorkId('queued-next-2'), 'next', 2],
      [queuedWorkId('queued-1'), 'backlog', 3],
    ]);
  });

  it('validates queued work and makes an exact queue replay idempotent', () => {
    const control = initialControl();
    const noTitle = queueAgentWork({
      control,
      actor: SEED_HUMAN,
      workId: queuedWorkId('queued-no-title'),
      signalId: runControlSignalId('signal-no-title'),
      title: '   ',
      desiredOutcome: 'Users can understand the result.',
      expectedAgentMinutes: agentExpectedMinutes(30),
      queuedAt: isoDateTime('2026-07-18T21:03:00.000Z'),
    });
    expect(noTitle).toMatchObject({ allowed: false, code: 'QUEUE_ITEM_TITLE_REQUIRED' });

    const noOutcome = queueAgentWork({
      control,
      actor: SEED_HUMAN,
      workId: queuedWorkId('queued-no-outcome'),
      signalId: runControlSignalId('signal-no-outcome'),
      title: 'Clarify the recovery message',
      desiredOutcome: ' ',
      expectedAgentMinutes: agentExpectedMinutes(30),
      queuedAt: isoDateTime('2026-07-18T21:03:00.000Z'),
    });
    expect(noOutcome).toMatchObject({ allowed: false, code: 'QUEUE_ITEM_OUTCOME_REQUIRED' });

    const invalidEstimate = queueAgentWork({
      control,
      actor: SEED_HUMAN,
      workId: queuedWorkId('queued-bad-estimate'),
      signalId: runControlSignalId('signal-bad-estimate'),
      title: 'Clarify the recovery message',
      desiredOutcome: 'Customers can understand when recovery completes.',
      expectedAgentMinutes: 20 as AgentExpectedMinutes,
      queuedAt: isoDateTime('2026-07-18T21:03:00.000Z'),
    });
    expect(invalidEstimate).toMatchObject({
      allowed: false,
      code: 'AGENT_ESTIMATE_INTERVAL_REQUIRED',
    });

    const queued = value(queue(control, 1));
    const replayed = value(queue(queued, 1));
    expect(replayed).toEqual(queued);
    expect(replayed.queue).toHaveLength(1);
    expect(replayed.signals).toHaveLength(1);

    const changedEstimateReplay = queueAgentWork({
      control: queued,
      actor: SEED_HUMAN,
      workId: queuedWorkId('queued-1'),
      signalId: runControlSignalId('signal-queue-1'),
      title: 'Explain the recovery state',
      desiredOutcome: 'Support can tell whether a payment is safely recovering.',
      expectedAgentMinutes: agentExpectedMinutes(45),
      queuedAt: isoDateTime('2026-07-18T21:03:00.000Z'),
    });
    expect(changedEstimateReplay).toMatchObject({
      allowed: false,
      code: 'RUN_CONTROL_REPLAY_CONFLICT',
    });

    const conflictingWorkId = queueAgentWork({
      control: queued,
      actor: SEED_HUMAN,
      workId: queuedWorkId('queued-1'),
      signalId: runControlSignalId('different-signal'),
      title: 'A different request',
      desiredOutcome: 'A conflicting work id is rejected.',
      expectedAgentMinutes: agentExpectedMinutes(45),
      queuedAt: isoDateTime('2026-07-18T21:04:00.000Z'),
    });
    expect(conflictingWorkId).toMatchObject({
      allowed: false,
      code: 'RUN_CONTROL_REPLAY_CONFLICT',
    });
  });

  it('enforces human-only queue, request, and resume boundaries', () => {
    const control = initialControl();
    const interrupted = settledInterruption();

    for (const actor of [ENGINEER, WORKER, UNAUTHENTICATED_HUMAN] satisfies Principal[]) {
      const expectedCode =
        actor.kind === 'human'
          ? 'HUMAN_AUTHENTICATION_REQUIRED'
          : 'HUMAN_RUN_CONTROL_REQUIRED';
      const decisions = [queue(control, 1, actor), request(control, actor), resume(interrupted, actor)];

      for (const decision of decisions) {
        expect(decision).toMatchObject({ allowed: false, code: expectedCode });
      }
    }
  });

  it('enforces orchestration-worker-only provider and run-attempt transitions', () => {
    const requested = value(request(initialControl()));
    const acknowledged = value(acknowledge(requested));
    const idle = createHumanRunControlState({ laneId: LANE_ID, agentId: ENGINEER.id });

    for (const actor of [SEED_HUMAN, ENGINEER, OBSERVER] satisfies Principal[]) {
      expect(acknowledge(requested, actor)).toMatchObject({
        allowed: false,
        code: 'ORCHESTRATION_WORKER_REQUIRED',
      });
      expect(settle(acknowledged, 'interrupted', actor)).toMatchObject({
        allowed: false,
        code: 'ORCHESTRATION_WORKER_REQUIRED',
      });
      expect(
        startAgentRunAttempt({
          control: idle,
          actor,
          runId: RUN_ID,
          signalId: runControlSignalId('unauthorized-start'),
          startedAt: isoDateTime('2026-07-18T21:06:00.000Z'),
        }),
      ).toMatchObject({ allowed: false, code: 'ORCHESTRATION_WORKER_REQUIRED' });
    }
  });

  it('does not claim interruption until request, acknowledgement, and settlement complete', () => {
    const loop = executingLoop();
    const withQueue = value(queue(initialControl(loop), 1));
    const requested = value(request(withQueue));

    expect(requested.status).toBe('interrupt_requested');
    expect(requested.queue).toEqual(withQueue.queue);
    expect(requested.evidence).toEqual(withQueue.evidence);
    expect(requested.loopCheckpoint).toEqual({
      stage: 'execute',
      iteration: 1,
      status: 'active',
    });
    expect(requested.interruption).toMatchObject({
      runId: RUN_ID,
      requestedBy: SEED_HUMAN.id,
      reason: 'A human needs to clarify the expected customer message.',
    });
    expect(requested.interruption?.outcome).toBeUndefined();
    expect(canAgentRun(requested, ENGINEER)).toMatchObject({
      allowed: false,
      code: 'RUN_INTERRUPTED',
    });

    const acknowledged = value(acknowledge(requested));
    expect(acknowledged.status).toBe('interrupt_acknowledged');
    expect(acknowledged.interruption?.acknowledgedAt).toBe(
      isoDateTime('2026-07-18T21:05:10.000Z'),
    );
    expect(resume(acknowledged)).toMatchObject({ allowed: false, code: 'RUN_NOT_INTERRUPTED' });

    const interrupted = value(settle(acknowledged));
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.interruption).toMatchObject({
      outcome: 'interrupted',
      settledAt: isoDateTime('2026-07-18T21:05:20.000Z'),
    });

    const resumed = value(resume(interrupted));
    expect(resumed.status).toBe('running');
    expect(resumed.queue).toEqual(interrupted.queue);
    expect(resumed.evidence).toEqual(interrupted.evidence);
    expect(resumed.loopCheckpoint).toEqual(interrupted.loopCheckpoint);
    expect(resumed.interruption).toMatchObject({
      outcome: 'interrupted',
      resumedBy: SEED_HUMAN.id,
      resumedAt: isoDateTime('2026-07-18T21:06:00.000Z'),
    });
    expect(canAgentRun(resumed, ENGINEER)).toEqual({ allowed: true, value: true });
  });

  it.each([
    ['refused', 'interrupt_refused', false],
    ['unknown', 'interrupt_unknown', false],
  ] as const)('records a provider %s outcome without claiming the run stopped', (outcome, status, mayRun) => {
    const settled = settledInterruption(outcome);
    expect(settled.status).toBe(status);
    expect(settled.interruption?.outcome).toBe(outcome);
    expect(resume(settled)).toMatchObject({ allowed: false, code: 'RUN_NOT_INTERRUPTED' });
    expect(canAgentRun(settled, ENGINEER).allowed).toBe(mayRun);

    const retried = requestAgentRunInterruption({
      control: settled,
      actor: SEED_HUMAN,
      signalId: runControlSignalId(`signal-retry-${outcome}`),
      requestedAt: isoDateTime('2026-07-18T21:05:30.000Z'),
    });
    expect(retried).toMatchObject({
      allowed: true,
      value: { status: 'interrupt_requested' },
    });
  });

  it('settles an unacknowledged timeout as unknown without inventing worker acknowledgement', () => {
    const requested = value(request(initialControl()));
    const unknown = value(
      settleAgentRunInterruption({
        control: requested,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId('signal-interrupt-timeout'),
        outcome: 'unknown',
        settledAt: isoDateTime('2026-07-18T21:05:20.000Z'),
        detail: 'No worker acknowledgement arrived before the control deadline.',
      }),
    );

    expect(unknown.status).toBe('interrupt_unknown');
    expect(unknown.interruption).toMatchObject({
      outcome: 'unknown',
      outcomeDetail: 'No worker acknowledgement arrived before the control deadline.',
    });
    expect(unknown.interruption).not.toHaveProperty('acknowledgementSignalId');
    expect(unknown.interruption).not.toHaveProperty('acknowledgedAt');
    expect(canAgentRun(unknown, ENGINEER)).toMatchObject({
      allowed: false,
      code: 'RUN_INTERRUPTED',
    });
  });

  it.each([
    ['interrupt_requested', false, '2026-07-18T21:05:05.000Z'],
    ['interrupt_acknowledged', true, '2026-07-18T21:05:15.000Z'],
  ] as const)(
    'records natural completion from %s as winning the cancellation race',
    (priorStatus, withAcknowledgement, completedAt) => {
      const queued = value(queue(initialControl(), 1));
      const requested = value(request(queued));
      const racing = withAcknowledgement ? value(acknowledge(requested)) : requested;
      expect(racing.status).toBe(priorStatus);

      const completionInput = {
        control: racing,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId(`race-complete-${priorStatus}`),
        completedAt: isoDateTime(completedAt),
        providerEvidence: `${NATURAL_COMPLETION_EVIDENCE} ${priorStatus}`,
      } as const;
      const completed = value(completeAgentRunAttempt(completionInput));

      expect(completed.status).toBe('idle');
      expect(completed.activeRunId).toBeUndefined();
      expect(completed.interruption).toBeUndefined();
      expect(completed.queue).toEqual(racing.queue);
      expect(completed.evidence).toEqual(racing.evidence);
      expect(completed.loopCheckpoint).toEqual(racing.loopCheckpoint);
      expect(completed.lastCompletion).toMatchObject({
        runId: RUN_ID,
        priorControlStatus: priorStatus,
        relationToInterruption: 'before_cancellation',
        providerEvidence: `${NATURAL_COMPLETION_EVIDENCE} ${priorStatus}`,
      });
      expect(completed.signals.at(-1)).toMatchObject({
        action: 'run_completed',
        completionFromStatus: priorStatus,
        completionRelation: 'before_cancellation',
      });

      const signalCount = completed.signals.length;
      const replayed = value(
        completeAgentRunAttempt({ ...completionInput, control: completed }),
      );
      expect(replayed).toEqual(completed);
      expect(replayed.signals).toHaveLength(signalCount);
      expect(
        completeAgentRunAttempt({
          ...completionInput,
          control: completed,
          providerEvidence: 'A different terminal event cannot reuse this signal id.',
        }),
      ).toMatchObject({ allowed: false, code: 'RUN_CONTROL_REPLAY_CONFLICT' });
    },
  );

  it.each([
    ['refused', 'interrupt_refused'],
    ['unknown', 'interrupt_unknown'],
  ] as const)(
    'records natural completion after a %s cancellation outcome without calling it interrupted',
    (outcome, priorStatus) => {
      const control = settledInterruption(outcome);
      const completed = value(
        completeAgentRunAttempt({
          control,
          actor: WORKER,
          runId: RUN_ID,
          signalId: runControlSignalId(`complete-after-${outcome}`),
          completedAt: isoDateTime('2026-07-18T21:05:30.000Z'),
          providerEvidence: `${NATURAL_COMPLETION_EVIDENCE} ${outcome}`,
        }),
      );

      expect(completed.status).toBe('idle');
      expect(completed.lastCompletion).toMatchObject({
        priorControlStatus: priorStatus,
        relationToInterruption: 'after_cancellation_attempt',
      });
      expect(completed.signals.at(-1)).toMatchObject({
        action: 'run_completed',
        completionRelation: 'after_cancellation_attempt',
      });
      expect(completed.signals.at(-1)?.interruptionOutcome).toBeUndefined();
    },
  );

  it.each(['refused', 'unknown'] as const)(
    'lets the worker reconcile a provider-%s run as alive without human resume',
    (outcome) => {
      const settled = settledInterruption(outcome);
      const reconciliationInput = {
        control: settled,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId(`reconcile-${outcome}`),
        reconciledAt: isoDateTime('2026-07-18T21:05:30.000Z'),
        providerEvidence: `Provider process process-142 answered liveness probe ${outcome}.`,
      } as const;
      const reconciled = value(reconcileAgentRunStillRunning(reconciliationInput));

      expect(reconciled.status).toBe('running');
      expect(reconciled.activeRunId).toBe(RUN_ID);
      expect(reconciled.interruption).toMatchObject({
        outcome,
        reconciliationSignalId: runControlSignalId(`reconcile-${outcome}`),
        reconciliationEvidence: `Provider process process-142 answered liveness probe ${outcome}.`,
      });
      expect(canAgentRun(reconciled, ENGINEER)).toEqual({ allowed: true, value: true });

      const replayed = value(
        reconcileAgentRunStillRunning({ ...reconciliationInput, control: reconciled }),
      );
      expect(replayed).toEqual(reconciled);
      expect(
        reconcileAgentRunStillRunning({
          ...reconciliationInput,
          control: reconciled,
          providerEvidence: 'A different process answered the later probe.',
        }),
      ).toMatchObject({ allowed: false, code: 'RUN_CONTROL_REPLAY_CONFLICT' });
    },
  );

  it('rejects unproven, unauthorized, wrong-run, and terminal reconciliation', () => {
    const unknown = settledInterruption('unknown');
    const baseInput = {
      control: unknown,
      actor: WORKER,
      runId: RUN_ID,
      signalId: runControlSignalId('reconcile-invalid'),
      reconciledAt: isoDateTime('2026-07-18T21:05:30.000Z'),
      providerEvidence: 'Provider process process-142 answered a signed liveness probe.',
    } as const;

    expect(
      reconcileAgentRunStillRunning({ ...baseInput, providerEvidence: '   ' }),
    ).toMatchObject({
      allowed: false,
      code: 'RUN_RECONCILIATION_EVIDENCE_REQUIRED',
    });
    for (const actor of [SEED_HUMAN, ENGINEER, OBSERVER] satisfies Principal[]) {
      expect(reconcileAgentRunStillRunning({ ...baseInput, actor })).toMatchObject({
        allowed: false,
        code: 'ORCHESTRATION_WORKER_REQUIRED',
      });
    }
    expect(
      reconcileAgentRunStillRunning({ ...baseInput, runId: agentRunId('stale-run') }),
    ).toMatchObject({ allowed: false, code: 'RUN_ATTEMPT_MISMATCH' });

    const interrupted = settledInterruption('interrupted');
    expect(
      reconcileAgentRunStillRunning({ ...baseInput, control: interrupted }),
    ).toMatchObject({ allowed: false, code: 'INVALID_RUN_CONTROL_TRANSITION' });
  });

  it('requires worker authority, matching run identity, and evidence for race completion', () => {
    const requested = value(request(initialControl()));
    const baseInput = {
      control: requested,
      actor: WORKER,
      runId: RUN_ID,
      signalId: runControlSignalId('race-complete-validation'),
      completedAt: isoDateTime('2026-07-18T21:05:05.000Z'),
      providerEvidence: NATURAL_COMPLETION_EVIDENCE,
    } as const;

    for (const actor of [SEED_HUMAN, ENGINEER, OBSERVER] satisfies Principal[]) {
      expect(completeAgentRunAttempt({ ...baseInput, actor })).toMatchObject({
        allowed: false,
        code: 'ORCHESTRATION_WORKER_REQUIRED',
      });
    }
    expect(
      completeAgentRunAttempt({ ...baseInput, runId: agentRunId('stale-run') }),
    ).toMatchObject({ allowed: false, code: 'RUN_ATTEMPT_MISMATCH' });
    expect(
      completeAgentRunAttempt({ ...baseInput, providerEvidence: '  ' }),
    ).toMatchObject({ allowed: false, code: 'RUN_COMPLETION_EVIDENCE_REQUIRED' });

    const interrupted = settledInterruption('interrupted');
    expect(completeAgentRunAttempt({ ...baseInput, control: interrupted })).toMatchObject({
      allowed: false,
      code: 'INVALID_RUN_CONTROL_TRANSITION',
    });
  });

  it('makes exact transition replays idempotent, even after later transitions', () => {
    const original = initialControl();
    const requested = value(request(original));
    const requestSignalCount = requested.signals.length;
    expect(value(request(requested))).toEqual(requested);
    expect(value(request(requested)).signals).toHaveLength(requestSignalCount);

    const acknowledged = value(acknowledge(requested));
    expect(value(acknowledge(acknowledged))).toEqual(acknowledged);

    const interrupted = value(settle(acknowledged));
    expect(value(settle(interrupted))).toEqual(interrupted);

    const resumed = value(resume(interrupted));
    expect(value(resume(resumed))).toEqual(resumed);

    // A delayed retry of the original request is recognized by signal identity
    // and does not rewind the already-resumed lifecycle.
    expect(value(request(resumed))).toEqual(resumed);
  });

  it('rejects signal-id reuse with changed payload', () => {
    const requested = value(request(initialControl()));
    const conflicting = requestAgentRunInterruption({
      control: requested,
      actor: SEED_HUMAN,
      signalId: runControlSignalId('signal-interrupt-request'),
      requestedAt: isoDateTime('2026-07-18T21:05:00.000Z'),
      reason: 'A different reason must not overwrite the first request.',
    });

    expect(conflicting).toMatchObject({
      allowed: false,
      code: 'RUN_CONTROL_REPLAY_CONFLICT',
    });
    expect(requested.interruption?.reason).toBe(
      'A human needs to clarify the expected customer message.',
    );
  });

  it('validates lifecycle transitions, active-run identity, and monotonic timestamps', () => {
    const control = initialControl();
    expect(acknowledge(control)).toMatchObject({
      allowed: false,
      code: 'INVALID_RUN_CONTROL_TRANSITION',
    });

    const requested = value(request(control));
    expect(settle(requested)).toMatchObject({
      allowed: false,
      code: 'INVALID_RUN_CONTROL_TRANSITION',
    });
    expect(
      acknowledgeAgentRunInterruption({
        control: requested,
        actor: WORKER,
        runId: agentRunId('stale-run'),
        signalId: runControlSignalId('stale-ack'),
        acknowledgedAt: isoDateTime('2026-07-18T21:05:10.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'RUN_ATTEMPT_MISMATCH' });
    expect(
      acknowledgeAgentRunInterruption({
        control: requested,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId('early-ack'),
        acknowledgedAt: isoDateTime('2026-07-18T21:04:59.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'INVALID_RUN_CONTROL_TIMESTAMP' });

    const acknowledged = value(acknowledge(requested));
    expect(
      settleAgentRunInterruption({
        control: acknowledged,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId('invalid-time'),
        outcome: 'interrupted',
        settledAt: isoDateTime('not-a-date'),
      }),
    ).toMatchObject({ allowed: false, code: 'INVALID_RUN_CONTROL_TIMESTAMP' });

    const timestamped = createHumanRunControlState({
      laneId: LANE_ID,
      agentId: ENGINEER.id,
      activeRunId: RUN_ID,
      activeRunStartedAt: isoDateTime('2026-07-18T21:00:00.000Z'),
    });
    expect(
      queue(timestamped, 1, SEED_HUMAN, isoDateTime('2026-07-18T20:59:59.000Z')),
    ).toMatchObject({ allowed: false, code: 'INVALID_RUN_CONTROL_TIMESTAMP' });
  });

  it('preserves queue, evidence, and checkpoint when the worker replaces a run attempt', () => {
    const queued = value(queue(initialControl(), 1));
    const nextRunId = agentRunId('run-143');
    const replaced = value(
      replaceAgentRunAttempt({
        control: queued,
        actor: WORKER,
        previousRunId: RUN_ID,
        nextRunId,
        signalId: runControlSignalId('signal-replace'),
        replacedAt: isoDateTime('2026-07-18T21:04:30.000Z'),
        note: 'The prior provider session ended and a fresh attempt took over.',
      }),
    );

    expect(replaced.laneId).toBe(LANE_ID);
    expect(replaced.activeRunId).toBe(nextRunId);
    expect(replaced.status).toBe('running');
    expect(replaced.queue).toEqual(queued.queue);
    expect(replaced.queue[0]?.laneId).toBe(LANE_ID);
    expect(replaced.evidence).toEqual(queued.evidence);
    expect(replaced.loopCheckpoint).toEqual(queued.loopCheckpoint);
    expect(replaced.interruption).toBeUndefined();
    expect(value(queue(replaced, 1))).toEqual(replaced);

    const replayed = value(
      replaceAgentRunAttempt({
        control: replaced,
        actor: WORKER,
        previousRunId: RUN_ID,
        nextRunId,
        signalId: runControlSignalId('signal-replace'),
        replacedAt: isoDateTime('2026-07-18T21:04:30.000Z'),
        note: 'The prior provider session ended and a fresh attempt took over.',
      }),
    );
    expect(replayed).toEqual(replaced);

    expect(
      replaceAgentRunAttempt({
        control: replaced,
        actor: WORKER,
        previousRunId: nextRunId,
        nextRunId: RUN_ID,
        signalId: runControlSignalId('signal-reuse-replaced-attempt'),
        replacedAt: isoDateTime('2026-07-18T21:04:31.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'RUN_ATTEMPT_REUSED' });
  });

  it('preserves queued work when an attempt completes and a later attempt starts', () => {
    const queued = value(queue(initialControl(), 1));
    const completed = value(
      completeAgentRunAttempt({
        control: queued,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId('signal-complete'),
        completedAt: isoDateTime('2026-07-18T21:04:30.000Z'),
        providerEvidence: NATURAL_COMPLETION_EVIDENCE,
      }),
    );

    expect(completed.status).toBe('idle');
    expect(completed.activeRunId).toBeUndefined();
    expect(completed.queue).toEqual(queued.queue);
    expect(completed.evidence).toEqual(queued.evidence);
    expect(completed.lastCompletion).toMatchObject({
      priorControlStatus: 'running',
      relationToInterruption: 'without_interruption',
      providerEvidence: NATURAL_COMPLETION_EVIDENCE,
    });
    expect(canAgentRun(completed, ENGINEER)).toMatchObject({
      allowed: false,
      code: 'RUN_NOT_ACTIVE',
    });
    expect(
      value(
        completeAgentRunAttempt({
          control: completed,
          actor: WORKER,
          runId: RUN_ID,
          signalId: runControlSignalId('signal-complete'),
          completedAt: isoDateTime('2026-07-18T21:04:30.000Z'),
          providerEvidence: NATURAL_COMPLETION_EVIDENCE,
        }),
      ),
    ).toEqual(completed);

    expect(
      startAgentRunAttempt({
        control: completed,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId('signal-reuse-completed-attempt'),
        startedAt: isoDateTime('2026-07-18T21:04:31.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'RUN_ATTEMPT_REUSED' });

    const queuedWhileIdle = value(
      queue(completed, 2, SEED_HUMAN, isoDateTime('2026-07-18T21:05:00.000Z')),
    );
    const nextRunId = agentRunId('run-143');
    const started = value(
      startAgentRunAttempt({
        control: queuedWhileIdle,
        actor: WORKER,
        runId: nextRunId,
        signalId: runControlSignalId('signal-start-next'),
        startedAt: isoDateTime('2026-07-18T21:05:30.000Z'),
      }),
    );

    expect(started.activeRunId).toBe(nextRunId);
    expect(started.queue.map((item) => item.id)).toEqual([
      queuedWorkId('queued-1'),
      queuedWorkId('queued-2'),
    ]);
    expect(started.evidence).toEqual(queued.evidence);
    expect(started.loopCheckpoint).toEqual(queued.loopCheckpoint);
    expect(
      completeAgentRunAttempt({
        control: started,
        actor: WORKER,
        runId: RUN_ID,
        signalId: runControlSignalId('signal-stale-completion'),
        completedAt: isoDateTime('2026-07-18T21:06:00.000Z'),
        providerEvidence: NATURAL_COMPLETION_EVIDENCE,
      }),
    ).toMatchObject({ allowed: false, code: 'RUN_ATTEMPT_MISMATCH' });
  });

  it('blocks run replacement while an interruption is pending or human-held', () => {
    const requested = value(request(initialControl()));
    expect(
      replaceAgentRunAttempt({
        control: requested,
        actor: WORKER,
        previousRunId: RUN_ID,
        nextRunId: agentRunId('run-143'),
        signalId: runControlSignalId('replace-pending'),
        replacedAt: isoDateTime('2026-07-18T21:05:10.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'INVALID_RUN_CONTROL_TRANSITION' });
    const interrupted = value(settle(value(acknowledge(requested))));
    expect(
      replaceAgentRunAttempt({
        control: interrupted,
        actor: WORKER,
        previousRunId: RUN_ID,
        nextRunId: agentRunId('run-143'),
        signalId: runControlSignalId('replace-settled-hold'),
        replacedAt: isoDateTime('2026-07-18T21:05:30.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'INVALID_RUN_CONTROL_TRANSITION' });
  });
});
