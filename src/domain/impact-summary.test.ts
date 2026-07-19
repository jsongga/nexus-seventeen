import { describe, expect, it } from 'vitest';

import { ApprovalPolicyEngine, canDeployProduction } from './approval-policy';
import { advanceEngineeringLoop, startEngineeringLoop } from './engineering-loop';
import {
  agentLaneId,
  agentRunId,
  createEngineeringRunControlState,
  interruptAgentRun,
  runControlSignalId,
} from './human-run-control';
import {
  IMPACT_OBSERVER,
  IMPACT_OBSERVER_CONTRACT,
  authorizeImpactSummaryGeneration,
  boundImpactObserverInput,
  createImpactSummarySlot,
  failImpactSummaryGeneration,
  impactGenerationRequestId,
  impactObserverRunId,
  impactSummarySlotId,
  publishImpactSummaryRevision,
  requestImpactSummaryGeneration,
  validateImpactSummary,
} from './impact-summary';
import type {
  ImpactModelProvenance,
  ImpactSourceEvent,
  ImpactSummarySlot,
} from './impact-summary';
import {
  SEED_AGENTS,
  SEED_PRODUCTION_CHECK_TASK,
  SEED_RELEASE,
} from './seed';
import { approvalId, isoDateTime } from './types';
import type { AgentActor, EngineeringLoop, ServiceActor } from './types';

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

function value<Value>(
  decision:
    | { readonly allowed: true; readonly value: Value }
    | { readonly allowed: false; readonly code: string; readonly reason: string },
): Value {
  if (!decision.allowed) {
    throw new Error(`${decision.code}: ${decision.reason}`);
  }
  return decision.value;
}

const ORCHESTRATION_WORKER: ServiceActor = {
  kind: 'service',
  id: 'orchestration-worker',
  name: 'Orchestration worker',
};

const ECONOMY_MODEL = Object.freeze({
  provider: 'openai',
  modelId: 'codex-economy',
  modelTier: 'economy',
  promptVersion: 'impact-v2',
} satisfies ImpactModelProvenance);

const FIRST_SUMMARY = Object.freeze({
  outcome: 'Checkout recovery now has a predictable path.',
  userImpact: 'Customers can retry after a timeout with less risk of a duplicate charge.',
  status: 'in_progress',
  nextMilestone: 'Verify the recovery behavior across the full checkout flow.',
});

function sourceEvent(
  sequence: number,
  kind: ImpactSourceEvent['kind'] = 'progress_recorded',
): ImpactSourceEvent {
  return {
    sequence,
    kind,
    occurredAt: isoDateTime(`2026-07-18T23:0${sequence}:00.000Z`),
  };
}

function emptyImpactSlot(): ImpactSummarySlot {
  return createImpactSummarySlot({
    id: impactSummarySlotId('impact-slot-checkout-recovery'),
    agentLaneId: agentLaneId('lane-checkout-impact'),
    workItemId: SEED_RELEASE.workItemId,
  });
}

function requestImpact(
  slot: ImpactSummarySlot,
  sequence: number,
  requestOrdinal = sequence,
): ImpactSummarySlot {
  return value(
    requestImpactSummaryGeneration({
      slot,
      requestId: impactGenerationRequestId(`impact-request-${requestOrdinal}`),
      event: sourceEvent(sequence),
      requestedAt: isoDateTime(`2026-07-18T23:0${sequence}:10.000Z`),
    }),
  );
}

function authorizeImpact(
  slot: ImpactSummarySlot,
  requestOrdinal: number,
  runOrdinal = requestOrdinal,
): ImpactSummarySlot {
  return value(
    authorizeImpactSummaryGeneration({
      slot,
      actor: IMPACT_OBSERVER,
      requestId: impactGenerationRequestId(`impact-request-${requestOrdinal}`),
      runId: impactObserverRunId(`impact-run-${runOrdinal}`),
      baseRevision: slot.currentRevision?.revision ?? 0,
      model: ECONOMY_MODEL,
      authorizedAt: isoDateTime(`2026-07-18T23:0${runOrdinal}:20.000Z`),
    }),
  );
}

function publishImpact(
  slot: ImpactSummarySlot,
  requestOrdinal: number,
  runOrdinal = requestOrdinal,
  summary: unknown = FIRST_SUMMARY,
): ImpactSummarySlot {
  return value(
    publishImpactSummaryRevision({
      slot,
      actor: IMPACT_OBSERVER,
      requestId: impactGenerationRequestId(`impact-request-${requestOrdinal}`),
      runId: impactObserverRunId(`impact-run-${runOrdinal}`),
      baseRevision: slot.currentRevision?.revision ?? 0,
      summary,
      generatedAt: isoDateTime(`2026-07-18T23:0${runOrdinal}:30.000Z`),
    }),
  );
}

function slotWithFreshRevision(): ImpactSummarySlot {
  return publishImpact(authorizeImpact(requestImpact(emptyImpactSlot(), 1), 1), 1);
}

function researchLoop(): EngineeringLoop {
  return value(
    startEngineeringLoop({
      projectId: SEED_RELEASE.projectId,
      workItemId: SEED_RELEASE.workItemId,
      actor: ENGINEER,
      progress: {
        summary: 'Researching how payment recovery affects checkout completion.',
        recordedAt: isoDateTime('2026-07-18T22:00:00.000Z'),
      },
    }),
  );
}

describe('economy impact observer', () => {
  it('has a bounded, presentation-only contract with no authority', () => {
    expect(IMPACT_OBSERVER_CONTRACT).toMatchObject({
      authority: 'presentation_only',
      modelTier: 'economy',
      canMutateWorkflow: false,
      productionAuthority: false,
      maxOutputTokens: 160,
    });
    expect(IMPACT_OBSERVER_CONTRACT.maxOutputTokens).toBeLessThanOrEqual(200);
    expect(IMPACT_OBSERVER_CONTRACT.capabilities).toEqual([]);
  });

  it('sees only bounded, recent progress summaries', () => {
    const longSummary = 'A'.repeat(400);
    const bounded = value(
      boundImpactObserverInput({
        taskTitle: 'Recover interrupted payment confirmations',
        desiredOutcome: 'Customers can retry safely without being charged twice.',
        progress: Array.from({ length: 12 }, (_, index) => ({
          sequence: index + 1,
          summary: `${index + 1}: ${longSummary}`,
          recordedAt: isoDateTime(
            `2026-07-18T22:${String(index).padStart(2, '0')}:00.000Z`,
          ),
        })),
      }),
    );

    expect(bounded.progress).toHaveLength(IMPACT_OBSERVER_CONTRACT.maxProgressEntries);
    expect(bounded.progress.map((entry) => entry.sequence)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(
      bounded.progress.every(
        (entry) =>
          entry.summary.length <= IMPACT_OBSERVER_CONTRACT.maxProgressSummaryCharacters,
      ),
    ).toBe(true);
    expect(bounded.omittedProgressCount).toBe(4);
  });

  it('requires task context and validates every structured result field', () => {
    const missingContext = boundImpactObserverInput({
      taskTitle: ' ',
      desiredOutcome: 'Customers can retry safely.',
      progress: [],
    });
    expect(missingContext).toMatchObject({
      allowed: false,
      code: 'IMPACT_TASK_CONTEXT_REQUIRED',
    });

    const valid = validateImpactSummary({
      outcome: 'Checkout retries are being made safe and predictable.',
      userImpact: 'Customers will be less likely to see duplicate charges after a timeout.',
      status: 'in_progress',
      nextMilestone: 'Confirm the recovery behavior with the full test set.',
    });
    expect(valid).toMatchObject({
      allowed: true,
      value: {
        status: 'in_progress',
      },
    });

    for (const invalid of [
      null,
      {},
      {
        outcome: '',
        userImpact: 'Customers can retry safely.',
        status: 'in_progress',
        nextMilestone: 'Run the acceptance checks.',
      },
      {
        outcome: 'Retries are safer.',
        userImpact: 'Customers can retry safely.',
        status: 'editing_files',
        nextMilestone: 'Run the acceptance checks.',
      },
    ]) {
      expect(validateImpactSummary(invalid)).toMatchObject({
        allowed: false,
        code: 'IMPACT_SUMMARY_INVALID',
      });
    }
  });

  it('cannot advance loops, approve production, interrupt agents, or deploy', () => {
    const loop = researchLoop();
    const advance = advanceEngineeringLoop({
      loop,
      actor: IMPACT_OBSERVER,
      to: 'plan',
      progress: {
        summary: 'A presentation observer must not mutate delivery state.',
        recordedAt: isoDateTime('2026-07-18T22:01:00.000Z'),
      },
    });
    expect(advance).toMatchObject({ allowed: false, code: 'ROLE_MISMATCH' });
    expect(loop.stage).toBe('research');

    const approval = new ApprovalPolicyEngine().approve({
      approvalId: approvalId('observer-approval'),
      release: SEED_RELEASE,
      productionCheckTask: SEED_PRODUCTION_CHECK_TASK,
      actor: IMPACT_OBSERVER,
      approvedAt: isoDateTime('2026-07-18T22:02:00.000Z'),
    });
    expect(approval).toMatchObject({
      allowed: false,
      code: 'HUMAN_APPROVER_REQUIRED',
    });

    const interrupt = interruptAgentRun({
      control: createEngineeringRunControlState(agentRunId('observer-target'), loop),
      actor: IMPACT_OBSERVER,
      signalId: runControlSignalId('observer-interrupt'),
      interruptedAt: isoDateTime('2026-07-18T22:02:00.000Z'),
    });
    expect(interrupt).toMatchObject({
      allowed: false,
      code: 'HUMAN_RUN_CONTROL_REQUIRED',
    });

    expect(canDeployProduction(IMPACT_OBSERVER)).toMatchObject({
      allowed: false,
      code: 'DEPLOYMENT_BROKER_REQUIRED',
    });
  });
});

describe('revisioned event-driven impact summaries', () => {
  it('deduplicates delivered events and coalesces queued events into one request', () => {
    const empty = emptyImpactSlot();
    const requested = requestImpact(empty, 1);
    const coalesced = requestImpact(requested, 2, 2);

    expect(empty).toMatchObject({
      revisions: [],
      latestSourceEventSequence: 0,
      freshness: 'empty',
    });
    expect(coalesced).toMatchObject({
      latestSourceEventSequence: 2,
      freshness: 'empty',
      activeRequest: {
        id: impactGenerationRequestId('impact-request-1'),
        state: 'queued',
        baseRevision: 0,
        firstSourceEventSequence: 1,
        sourceEventSequence: 2,
        coalescedEventCount: 1,
      },
    });

    const duplicate = value(
      requestImpactSummaryGeneration({
        slot: coalesced,
        requestId: impactGenerationRequestId('duplicate-request'),
        event: sourceEvent(2),
        requestedAt: isoDateTime('2026-07-18T23:02:11.000Z'),
      }),
    );
    const older = value(
      requestImpactSummaryGeneration({
        slot: duplicate,
        requestId: impactGenerationRequestId('older-request'),
        event: sourceEvent(1),
        requestedAt: isoDateTime('2026-07-18T23:02:12.000Z'),
      }),
    );

    expect(duplicate).toBe(coalesced);
    expect(older).toBe(coalesced);
  });

  it('rejects malformed event triggers without opening a generation request', () => {
    const slot = emptyImpactSlot();
    const invalidSequence = requestImpactSummaryGeneration({
      slot,
      requestId: impactGenerationRequestId('invalid-sequence'),
      event: {
        sequence: 0,
        kind: 'progress_recorded',
        occurredAt: isoDateTime('2026-07-18T23:01:00.000Z'),
      },
      requestedAt: isoDateTime('2026-07-18T23:01:01.000Z'),
    });
    const invalidObservationTime = requestImpactSummaryGeneration({
      slot,
      requestId: impactGenerationRequestId('invalid-observation-time'),
      event: sourceEvent(1),
      requestedAt: isoDateTime('2026-07-18T23:00:59.000Z'),
    });

    expect(invalidSequence).toMatchObject({
      allowed: false,
      code: 'IMPACT_SOURCE_EVENT_INVALID',
    });
    expect(invalidObservationTime).toMatchObject({
      allowed: false,
      code: 'IMPACT_SOURCE_EVENT_INVALID',
    });
    expect(slot.activeRequest).toBeUndefined();
  });

  it('authorizes only the exact no-tools observer request and economy-model run', () => {
    const queued = requestImpact(emptyImpactSlot(), 1);
    const common = {
      slot: queued,
      requestId: impactGenerationRequestId('impact-request-1'),
      runId: impactObserverRunId('impact-run-1'),
      baseRevision: 0,
      model: ECONOMY_MODEL,
      authorizedAt: isoDateTime('2026-07-18T23:01:20.000Z'),
    };

    expect(
      authorizeImpactSummaryGeneration({
        ...common,
        actor: ORCHESTRATION_WORKER,
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_OBSERVER_REQUIRED' });
    expect(
      authorizeImpactSummaryGeneration({
        ...common,
        actor: IMPACT_OBSERVER,
        requestId: impactGenerationRequestId('wrong-request'),
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_GENERATION_LINK_MISMATCH' });
    expect(
      authorizeImpactSummaryGeneration({
        ...common,
        actor: IMPACT_OBSERVER,
        model: {
          ...ECONOMY_MODEL,
          modelTier: 'frontier',
        } as unknown as ImpactModelProvenance,
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_MODEL_PROVENANCE_INVALID' });

    const running = value(
      authorizeImpactSummaryGeneration({ ...common, actor: IMPACT_OBSERVER }),
    );
    expect(running.activeRequest).toMatchObject({
      state: 'running',
      authorization: {
        requestId: impactGenerationRequestId('impact-request-1'),
        runId: impactObserverRunId('impact-run-1'),
        sourceEventSequence: 1,
        baseRevision: 0,
        authorizedActorId: 'impact-observer',
        authority: 'presentation_only',
        capabilities: [],
        toolsAllowed: false,
        canMutateWorkflow: false,
        model: ECONOMY_MODEL,
      },
    });

    const publishCommon = {
      slot: running,
      requestId: impactGenerationRequestId('impact-request-1'),
      runId: impactObserverRunId('impact-run-1'),
      baseRevision: 0,
      summary: FIRST_SUMMARY,
      generatedAt: isoDateTime('2026-07-18T23:01:30.000Z'),
    };
    expect(
      publishImpactSummaryRevision({
        ...publishCommon,
        actor: ORCHESTRATION_WORKER,
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_OBSERVER_REQUIRED' });
    expect(
      publishImpactSummaryRevision({
        ...publishCommon,
        actor: IMPACT_OBSERVER,
        runId: impactObserverRunId('wrong-run'),
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_GENERATION_LINK_MISMATCH' });
    expect(
      publishImpactSummaryRevision({
        ...publishCommon,
        actor: IMPACT_OBSERVER,
        baseRevision: 1,
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_BASE_REVISION_CONFLICT' });
  });

  it('keeps immutable revision history, current revision, source freshness, and provenance', () => {
    const revisionOne = slotWithFreshRevision();
    expect(revisionOne).toMatchObject({
      freshness: 'fresh',
      latestSourceEventSequence: 1,
      activeRequest: undefined,
      currentRevision: {
        revision: 1,
        sourceEventSequence: 1,
        generationRequestId: impactGenerationRequestId('impact-request-1'),
        observerRunId: impactObserverRunId('impact-run-1'),
        model: ECONOMY_MODEL,
        summary: FIRST_SUMMARY,
      },
    });
    expect(revisionOne.revisions).toHaveLength(1);
    expect(revisionOne.attempts).toEqual([
      expect.objectContaining({
        requestId: impactGenerationRequestId('impact-request-1'),
        runId: impactObserverRunId('impact-run-1'),
        outcome: 'published',
      }),
    ]);

    const stale = requestImpact(revisionOne, 2);
    expect(stale.freshness).toBe('stale');
    expect(stale.currentRevision).toEqual(revisionOne.currentRevision);

    const secondSummary = {
      outcome: 'Checkout recovery has passed its acceptance checks.',
      userImpact: 'Customers can safely recover a timed-out payment without starting over.',
      status: 'ready_for_review',
      nextMilestone: 'Have the manager review the verified customer outcome.',
    };
    const revisionTwo = publishImpact(
      authorizeImpact(stale, 2),
      2,
      2,
      secondSummary,
    );

    expect(revisionTwo.freshness).toBe('fresh');
    expect(revisionTwo.currentRevision).toMatchObject({
      revision: 2,
      sourceEventSequence: 2,
      model: ECONOMY_MODEL,
      summary: secondSummary,
    });
    expect(revisionTwo.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(revisionTwo.revisions[0]).toEqual(revisionOne.currentRevision);
    expect(Object.isFrozen(revisionTwo.revisions)).toBe(true);
    expect(Object.isFrozen(revisionTwo.currentRevision?.summary)).toBe(true);
  });

  it('retains one coalesced follow-up when events arrive during a run', () => {
    const running = authorizeImpact(requestImpact(emptyImpactSlot(), 1), 1);
    const withFollowUp = requestImpact(requestImpact(running, 2, 2), 3, 3);

    expect(withFollowUp.activeRequest).toMatchObject({
      id: impactGenerationRequestId('impact-request-1'),
      state: 'running',
      sourceEventSequence: 1,
    });
    expect(withFollowUp.coalescedFollowUp).toEqual({
      requestId: impactGenerationRequestId('impact-request-2'),
      firstSourceEventSequence: 2,
      sourceEventSequence: 3,
      sourceEventAt: isoDateTime('2026-07-18T23:03:00.000Z'),
      requestedAt: isoDateTime('2026-07-18T23:02:10.000Z'),
      coalescedEventCount: 1,
    });

    const firstPublished = publishImpact(withFollowUp, 1);
    expect(firstPublished).toMatchObject({
      latestSourceEventSequence: 3,
      freshness: 'stale',
      currentRevision: { revision: 1, sourceEventSequence: 1 },
      activeRequest: {
        id: impactGenerationRequestId('impact-request-2'),
        state: 'queued',
        baseRevision: 1,
        firstSourceEventSequence: 2,
        sourceEventSequence: 3,
        coalescedEventCount: 1,
      },
    });
    expect(firstPublished.coalescedFollowUp).toBeUndefined();

    const caughtUp = publishImpact(
      authorizeImpact(firstPublished, 2, 4),
      2,
      4,
    );
    expect(caughtUp.currentRevision).toMatchObject({
      revision: 2,
      sourceEventSequence: 3,
    });
    expect(caughtUp.freshness).toBe('fresh');
    expect(caughtUp.activeRequest).toBeUndefined();
  });

  it('keeps the last good revision visible on failure and permits a bounded retry', () => {
    const good = slotWithFreshRevision();
    const running = authorizeImpact(requestImpact(good, 2), 2);
    const failed = value(
      failImpactSummaryGeneration({
        slot: running,
        actor: IMPACT_OBSERVER,
        requestId: impactGenerationRequestId('impact-request-2'),
        runId: impactObserverRunId('impact-run-2'),
        baseRevision: 1,
        message: ' Economy provider timed out. ',
        failedAt: isoDateTime('2026-07-18T23:02:30.000Z'),
      }),
    );

    expect(failed.currentRevision).toEqual(good.currentRevision);
    expect(failed.revisions).toEqual(good.revisions);
    expect(failed).toMatchObject({
      freshness: 'error',
      activeRequest: undefined,
      lastGenerationError: {
        requestId: impactGenerationRequestId('impact-request-2'),
        runId: impactObserverRunId('impact-run-2'),
        sourceEventSequence: 2,
        baseRevision: 1,
        model: ECONOMY_MODEL,
        message: 'Economy provider timed out.',
      },
    });
    expect(failed.attempts.at(-1)).toMatchObject({
      requestId: impactGenerationRequestId('impact-request-2'),
      runId: impactObserverRunId('impact-run-2'),
      outcome: 'failed',
    });

    const retryQueued = value(
      requestImpactSummaryGeneration({
        slot: failed,
        requestId: impactGenerationRequestId('impact-request-3'),
        event: sourceEvent(2),
        requestedAt: isoDateTime('2026-07-18T23:03:10.000Z'),
      }),
    );
    expect(retryQueued).toMatchObject({
      freshness: 'error',
      activeRequest: {
        id: impactGenerationRequestId('impact-request-3'),
        state: 'queued',
        baseRevision: 1,
        sourceEventSequence: 2,
      },
    });

    const recovered = publishImpact(
      authorizeImpact(retryQueued, 3, 4),
      3,
      4,
    );
    expect(recovered.freshness).toBe('fresh');
    expect(recovered.currentRevision?.revision).toBe(2);
    expect(recovered.lastGenerationError).toBeUndefined();
  });

  it('never reuses generation request or observer-run ids after publish or failure', () => {
    const published = slotWithFreshRevision();
    expect(
      requestImpactSummaryGeneration({
        slot: published,
        requestId: impactGenerationRequestId('impact-request-1'),
        event: sourceEvent(2),
        requestedAt: isoDateTime('2026-07-18T23:02:10.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_GENERATION_ID_REUSED' });

    const queuedAfterPublish = requestImpact(published, 2, 2);
    expect(
      authorizeImpactSummaryGeneration({
        slot: queuedAfterPublish,
        actor: IMPACT_OBSERVER,
        requestId: impactGenerationRequestId('impact-request-2'),
        runId: impactObserverRunId('impact-run-1'),
        baseRevision: 1,
        model: ECONOMY_MODEL,
        authorizedAt: isoDateTime('2026-07-18T23:02:20.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_GENERATION_ID_REUSED' });

    const failed = value(
      failImpactSummaryGeneration({
        slot: authorizeImpact(queuedAfterPublish, 2),
        actor: IMPACT_OBSERVER,
        requestId: impactGenerationRequestId('impact-request-2'),
        runId: impactObserverRunId('impact-run-2'),
        baseRevision: 1,
        message: 'The observer timed out.',
        failedAt: isoDateTime('2026-07-18T23:02:30.000Z'),
      }),
    );
    expect(
      requestImpactSummaryGeneration({
        slot: failed,
        requestId: impactGenerationRequestId('impact-request-2'),
        event: sourceEvent(2),
        requestedAt: isoDateTime('2026-07-18T23:03:10.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_GENERATION_ID_REUSED' });

    const retry = value(
      requestImpactSummaryGeneration({
        slot: failed,
        requestId: impactGenerationRequestId('impact-request-3'),
        event: sourceEvent(2),
        requestedAt: isoDateTime('2026-07-18T23:03:10.000Z'),
      }),
    );
    expect(
      authorizeImpactSummaryGeneration({
        slot: retry,
        actor: IMPACT_OBSERVER,
        requestId: impactGenerationRequestId('impact-request-3'),
        runId: impactObserverRunId('impact-run-2'),
        baseRevision: 1,
        model: ECONOMY_MODEL,
        authorizedAt: isoDateTime('2026-07-18T23:03:20.000Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'IMPACT_GENERATION_ID_REUSED' });
  });

  it('promotes an event received during a failed run without losing the last good result', () => {
    const good = slotWithFreshRevision();
    const running = authorizeImpact(requestImpact(good, 2), 2);
    const newerEvent = requestImpact(running, 3, 3);
    const failed = value(
      failImpactSummaryGeneration({
        slot: newerEvent,
        actor: IMPACT_OBSERVER,
        requestId: impactGenerationRequestId('impact-request-2'),
        runId: impactObserverRunId('impact-run-2'),
        baseRevision: 1,
        message: 'The response did not match the summary schema.',
        failedAt: isoDateTime('2026-07-18T23:03:30.000Z'),
      }),
    );

    expect(failed.currentRevision).toEqual(good.currentRevision);
    expect(failed.freshness).toBe('error');
    expect(failed.activeRequest).toMatchObject({
      id: impactGenerationRequestId('impact-request-3'),
      state: 'queued',
      baseRevision: 1,
      sourceEventSequence: 3,
    });
    expect(failed.coalescedFollowUp).toBeUndefined();
  });
});
