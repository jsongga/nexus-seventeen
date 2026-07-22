import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ShieldAlert, X } from 'lucide-react';
import { AgentQueueModal } from './components/AgentQueueModal';
import { ApprovalDrawer } from './components/ApprovalDrawer';
import { AppShell, type ViewKey } from './components/AppShell';
import { RunInspector } from './components/RunInspector';
import {
  NewMissionModal,
  type NewMissionInput,
  ProductionApprovalModal,
  RequestChangesModal,
} from './components/DecisionModals';
import {
  initialApprovals,
  initialAudit,
  initialMissions,
  initialRuns,
  demoAgents,
  type ApprovalItem,
  type AuditItem,
  type DemoMission,
  type DemoRun,
  type ImpactSummary,
} from './data/demo';
import {
  ApprovalPolicyEngine,
  DEPLOYMENT_BROKER,
  IMPACT_OBSERVER,
  SEED_HUMAN,
  SEED_PRODUCTION_CHECK_TASK,
  SEED_RELEASE,
  acknowledgeAgentRunInterruption,
  agentExpectedMinutes,
  agentId,
  agentLaneId,
  agentRunId,
  agentTaskId,
  approvalId,
  authorizeImpactSummaryGeneration,
  createHumanRunControlState,
  createImpactSummarySlot,
  contentDigest,
  failImpactSummaryGeneration,
  gitCommitSha,
  impactGenerationRequestId,
  impactObserverRunId,
  impactSummarySlotId,
  isoDateTime,
  publishImpactSummaryRevision,
  pauseAgentTask,
  queueAgentWork as queueDomainWork,
  queuedWorkId,
  requestImpactSummaryGeneration,
  requestAgentRunInterruption,
  resumeAgentRun as resumeDomainRun,
  resumeAgentTask,
  runControlSignalId,
  settleAgentRunInterruption,
  startAgentTask,
  workItemId,
  type HumanRunControlState,
  type AgentTask,
  type ImpactModelProvenance,
  type ImpactSummarySlot,
} from './domain';
import { ApprovalsView } from './views/ApprovalsView';
import { AuditView, type AuditActorFilter } from './views/AuditView';
import { MissionsView, type MissionFilter } from './views/MissionsView';
import { OverviewView } from './views/OverviewView';
import { RoutingView } from './views/RoutingView';
import { RunsView } from './views/RunsView';
import { TeamView } from './views/TeamView';
import { cn } from './components/ui';
import {
  DEMO_STORAGE_KEY,
  PERSISTED_DEMO_STATE_VERSION,
  parsePersistedDemoState,
  type PersistedDemoState,
  type StoredDemoRun,
} from './demo-persistence';

interface ToastState {
  message: string;
  detail?: string;
  tone: 'success' | 'error';
}

type ImpactCopyPatch = Partial<
  Pick<
    ImpactSummary,
    'outcome' | 'userImpact' | 'plainStatus' | 'nextMilestone' | 'confidence'
  >
>;

interface PendingImpactRefresh {
  patch: ImpactCopyPatch;
  changeSummary: string;
  sourceRefs: string[];
  eventCount: number;
}

const DEMO_ORCHESTRATION_WORKER = Object.freeze({
  kind: 'service' as const,
  id: 'orchestration-worker' as const,
  name: 'Orchestration worker',
});

let fallbackIdSequence = 0;

function uniqueDemoId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  fallbackIdSequence += 1;
  return `${prefix}-${Date.now()}-${fallbackIdSequence}`;
}

function impactModel(summary: ImpactSummary): ImpactModelProvenance {
  return {
    provider: summary.model.toLowerCase().includes('claude') ? 'anthropic' : 'openai',
    modelId: summary.model.replace(/\s+observer$/i, '').trim(),
    modelTier: 'economy',
    promptVersion: 'impact-v2',
  };
}

function impactStatusForRun(run: StoredDemoRun) {
  if (run.controlState === 'interrupted' || run.controlState === 'interrupt_unknown') {
    return 'blocked' as const;
  }
  if (run.loopPhase === 'manager_review') return 'ready_for_review' as const;
  if (run.status === 'waiting') return 'queued' as const;
  return 'in_progress' as const;
}

function createSeedImpactSlots(): Record<string, ImpactSummarySlot> {
  return Object.fromEntries(
    initialRuns.map((run, runIndex) => {
      let slot = createImpactSummarySlot({
        id: impactSummarySlotId(`slot-${run.agentLaneId}`),
        agentLaneId: agentLaneId(run.agentLaneId),
        workItemId: workItemId(run.workItemId),
      });

      for (let revision = 1; revision <= run.impactSummary.revision; revision += 1) {
        const minute = runIndex * 8 + revision;
        const sourceEventSequence =
          run.impactSummary.sourceThroughSequence - run.impactSummary.revision + revision;
        const requestId = impactGenerationRequestId(
          `seed-${run.id.toLowerCase()}-request-${revision}`,
        );
        const observerRunId = impactObserverRunId(
          `seed-${run.id.toLowerCase()}-observer-${revision}`,
        );
        const requested = requestImpactSummaryGeneration({
          slot,
          requestId,
          event: {
            sequence: sourceEventSequence,
            kind: 'progress_recorded',
            occurredAt: isoDateTime(
              `2026-07-18T20:${String(minute).padStart(2, '0')}:00.000Z`,
            ),
          },
          requestedAt: isoDateTime(
            `2026-07-18T20:${String(minute).padStart(2, '0')}:10.000Z`,
          ),
        });
        if (!requested.allowed) throw new Error(requested.reason);
        const authorized = authorizeImpactSummaryGeneration({
          slot: requested.value,
          actor: IMPACT_OBSERVER,
          requestId,
          runId: observerRunId,
          baseRevision: revision - 1,
          model: impactModel(run.impactSummary),
          authorizedAt: isoDateTime(
            `2026-07-18T20:${String(minute).padStart(2, '0')}:20.000Z`,
          ),
        });
        if (!authorized.allowed) throw new Error(authorized.reason);
        const published = publishImpactSummaryRevision({
          slot: authorized.value,
          actor: IMPACT_OBSERVER,
          requestId,
          runId: observerRunId,
          baseRevision: revision - 1,
          summary: {
            outcome: run.impactSummary.outcome,
            userImpact: run.impactSummary.userImpact,
            status: impactStatusForRun(run),
            nextMilestone: run.impactSummary.nextMilestone,
          },
          generatedAt: isoDateTime(
            `2026-07-18T20:${String(minute).padStart(2, '0')}:30.000Z`,
          ),
        });
        if (!published.allowed) throw new Error(published.reason);
        slot = published.value;
      }

      return [run.agentLaneId, slot] as const;
    }),
  );
}

function createSeedRunControls(): Record<string, HumanRunControlState> {
  return Object.fromEntries(
    initialRuns.map((run, runIndex) => {
      const profile = demoAgents.find((agent) => agent.name === run.agent);
      const taskStart =
        run.agentLaneId === 'lane-patch'
          ? '2026-07-18T23:04:00.000Z'
          : run.agentLaneId === 'lane-vale'
            ? '2026-07-18T23:11:00.000Z'
            : '2026-07-18T23:15:00.000Z';
      let control = createHumanRunControlState({
        laneId: agentLaneId(run.agentLaneId),
        agentId: agentId(profile?.id ?? `demo-agent-${runIndex + 1}`),
        ...(run.status === 'waiting'
          ? {}
          : {
              activeRunId: agentRunId(run.id),
              activeRunStartedAt: isoDateTime(taskStart),
            }),
      });

      for (const [queueIndex, item] of run.queue.entries()) {
        const queued = queueDomainWork({
          control,
          actor: SEED_HUMAN,
          workId: queuedWorkId(item.id),
          signalId: runControlSignalId(`seed-${run.agentLaneId}-queue-${queueIndex + 1}`),
          title: item.title,
          desiredOutcome: item.desiredOutcome,
          expectedAgentMinutes: item.expectedAgentMinutes,
          priority: item.position,
          queuedAt: isoDateTime(
            `2026-07-18T23:${String(6 + runIndex * 5 + queueIndex).padStart(2, '0')}:00.000Z`,
          ),
        });
        if (queued.allowed) control = queued.value;
      }

      return [run.agentLaneId, control] as const;
    }),
  );
}

function createSeedAgentTasks(): Record<string, AgentTask> {
  const seeds = [
    {
      laneId: 'lane-patch',
      taskId: 'task-stw-471-engineering',
      startedAt: '2026-07-18T23:04:00.000Z',
      expectedAgentMinutes: 45,
    },
    {
      laneId: 'lane-vale',
      taskId: 'task-stw-479-manager-review',
      startedAt: '2026-07-18T23:11:00.000Z',
      expectedAgentMinutes: 30,
    },
    {
      laneId: 'lane-gauge',
      taskId: 'task-stw-479-verification',
      startedAt: '2026-07-18T23:15:00.000Z',
      expectedAgentMinutes: 30,
    },
  ] as const;

  return Object.fromEntries(
    seeds.map((seed) => {
      const run = initialRuns.find((candidate) => candidate.agentLaneId === seed.laneId);
      const profile = run
        ? demoAgents.find((agent) => agent.name === run.agent)
        : undefined;
      if (!run || !profile) throw new Error(`Missing seed data for ${seed.laneId}.`);
      const task = startAgentTask({
        id: agentTaskId(seed.taskId),
        laneId: agentLaneId(seed.laneId),
        agentId: agentId(profile.id),
        workItemId: workItemId(run.workItemId),
        title: run.activity,
        expectedAgentMinutes: agentExpectedMinutes(seed.expectedAgentMinutes),
        startedAt: isoDateTime(seed.startedAt),
      });
      if (!task.allowed) throw new Error(task.reason);
      return [seed.laneId, task.value] as const;
    }),
  );
}

function splitInitialRuns(): Pick<
  PersistedDemoState,
  'runs' | 'runControls' | 'agentTasks' | 'impactSlots'
> {
  return {
    runs: initialRuns.map(({ queue: _queue, ...run }) => run),
    runControls: createSeedRunControls(),
    agentTasks: createSeedAgentTasks(),
    impactSlots: createSeedImpactSlots(),
  };
}

function projectControlState(
  run: StoredDemoRun,
  control: HumanRunControlState | undefined,
): StoredDemoRun {
  if (!control) return run;
  if (control.status === 'idle') {
    return {
      ...run,
      id: String(control.lastCompletion?.runId ?? run.id),
      controlState: 'idle',
      status: 'waiting',
      activity: 'No active provider run',
      detail: control.lastCompletion
        ? 'The last attempt completed naturally · stable queue and checkpoint preserved'
        : 'The stable agent lane is ready for queued work',
      lastHeartbeat: control.lastCompletion ? 'completed' : 'lane idle',
      currentAction: {
        label: 'No active run attempt',
        detail: 'Steward is preserving this lane, its queue, evidence, and engineering checkpoint without implying a provider process is working.',
        kind: 'analysis',
        tool: 'Steward scheduler',
        elapsed: 'Idle',
      },
    };
  }
  const interruption = control.status === 'running' ? undefined : control.interruption;
  const interruptionDetail =
    interruption?.outcomeDetail ??
    (control.status === 'interrupt_requested'
      ? 'The control plane requested cancellation and is waiting for worker acknowledgement. It is not yet claiming the process stopped.'
      : control.status === 'interrupt_acknowledged'
        ? 'The worker acknowledged cancellation and is settling the active process. Steward still has not marked it stopped.'
        : undefined);

  return {
    ...run,
    id: String(control.activeRunId ?? run.id),
    controlState: control.status,
    interruptRequestedAt: interruption?.requestedAt ? 'just now' : undefined,
    interruptAcknowledgedAt: interruption?.acknowledgedAt ? 'just now' : undefined,
    interruptedAt:
      interruption?.outcome === 'interrupted' && interruption.settledAt
        ? 'just now'
        : undefined,
    interruptionReason: interruption?.reason,
    interruptionDetail,
  };
}

function projectRuns(state: PersistedDemoState): DemoRun[] {
  return state.runs.map((storedRun) => {
    const control = state.runControls[storedRun.agentLaneId];
    const run = projectControlState(storedRun, control);
    return {
      ...run,
      agentTask: state.agentTasks[storedRun.agentLaneId],
      queue:
        control?.queue.map((item) => ({
          id: String(item.id),
          laneId: String(item.laneId),
          title: item.title,
          desiredOutcome: item.desiredOutcome,
          expectedAgentMinutes: item.expectedAgentMinutes,
          position: item.priority,
          queuedAt: new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date(item.queuedAt)),
          queuedBy:
            item.queuedBy === SEED_HUMAN.id ? SEED_HUMAN.name : String(item.queuedBy),
        })) ?? [],
    };
  });
}

function readDemoState(): PersistedDemoState {
  const initialExecution = splitInitialRuns();
  const fallback: PersistedDemoState = {
    schemaVersion: PERSISTED_DEMO_STATE_VERSION,
    approvals: initialApprovals,
    missions: initialMissions,
    ...initialExecution,
    audit: initialAudit,
    paused: false,
  };
  return parsePersistedDemoState(
    window.localStorage.getItem(DEMO_STORAGE_KEY),
    fallback,
  );
}

function nowLabel() {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());
}

function releaseCandidateFromDisplayedEvidence(approval: ApprovalItem) {
  if (!approval.release) {
    throw new Error('Production approval is missing its release evidence.');
  }

  return Object.freeze({
    ...SEED_RELEASE,
    digests: Object.freeze({
      commit: gitCommitSha(approval.release.commit),
      artifact: contentDigest(approval.release.artifactDigest as `sha256:${string}`),
      build: contentDigest(approval.release.buildDigest as `sha256:${string}`),
      tests: contentDigest(approval.release.testsDigest as `sha256:${string}`),
      configuration: contentDigest(approval.release.configDigest as `sha256:${string}`),
      migrations: contentDigest(approval.release.migrationsDigest as `sha256:${string}`),
    }),
  });
}

export function App() {
  const [state, setState] = useState<PersistedDemoState>(readDemoState);
  const [currentView, setCurrentView] = useState<ViewKey>('overview');
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [queueLaneId, setQueueLaneId] = useState<string | null>(null);
  const [productionApproval, setProductionApproval] = useState<ApprovalItem | null>(null);
  const [changesApproval, setChangesApproval] = useState<ApprovalItem | null>(null);
  const [newMissionOpen, setNewMissionOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [missionFilter, setMissionFilter] = useState<MissionFilter>('all');
  const [missionRiskFilter, setMissionRiskFilter] = useState<DemoMission['risk'] | 'all'>('all');
  const [auditFilter, setAuditFilter] = useState<AuditActorFilter>('all');
  const policyEngine = useRef(new ApprovalPolicyEngine());
  const impactRefreshTimers = useRef(new Map<string, number>());
  const pendingImpactRefreshes = useRef(new Map<string, PendingImpactRefresh>());

  useEffect(() => {
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(
    () => () => {
      for (const timeout of impactRefreshTimers.current.values()) {
        window.clearTimeout(timeout);
      }
    },
    [],
  );

  const selectedApproval = useMemo(
    () => state.approvals.find((approval) => approval.id === selectedApprovalId) ?? null,
    [selectedApprovalId, state.approvals],
  );

  const pendingCount = state.approvals.filter((approval) => approval.status === 'pending').length;
  const displayedRuns = useMemo(
    () => {
      const projectedRuns = projectRuns(state);
      if (state.paused) {
        return projectedRuns.map((run) => run.controlState === 'running' ? ({
            ...run,
            workspacePaused: true,
            status: 'waiting' as const,
            detail: 'Paused by Jordan · workspace and context preserved',
            lastHeartbeat: 'paused just now',
            currentAction: {
              ...run.currentAction,
              label: 'Paused by human owner',
              detail: 'No new model or tool calls can start. The workspace, loop position, and context remain preserved.',
              kind: 'analysis' as const,
              tool: 'Steward policy control',
              elapsed: 'Paused',
            },
          }) : ({
            ...run,
            workspacePaused: true,
          }));
      }

      return projectedRuns.map((run) =>
        run.controlState === 'interrupted'
          ? {
              ...run,
              workspacePaused: false,
              status: 'waiting' as const,
              detail: 'Interrupted by Jordan · workspace, journal, and queue preserved',
              lastHeartbeat: run.interruptedAt ? `stopped ${run.interruptedAt}` : 'stopped just now',
            }
          : run.controlState === 'interrupt_requested' || run.controlState === 'interrupt_acknowledged'
            ? {
                ...run,
                workspacePaused: false,
                status: 'waiting' as const,
                detail:
                  run.controlState === 'interrupt_acknowledged'
                    ? 'Worker acknowledged the interrupt · waiting for process settlement'
                    : 'Human interrupt requested · waiting for worker acknowledgement',
                lastHeartbeat: 'control request in progress',
              }
            : run.controlState === 'interrupt_unknown'
              ? {
                  ...run,
                  workspacePaused: false,
                  status: 'waiting' as const,
                  detail: 'Worker state is unknown · no new work will be dispatched',
                  lastHeartbeat: 'connection uncertain',
                }
              : { ...run, workspacePaused: false },
      );
    },
    [state],
  );
  const selectedRun = useMemo<DemoRun | null>(
    () => displayedRuns.find((run) => run.agentLaneId === selectedRunId) ?? null,
    [displayedRuns, selectedRunId],
  );
  const queueRun = useMemo<DemoRun | null>(
    () => displayedRuns.find((run) => run.agentLaneId === queueLaneId) ?? null,
    [displayedRuns, queueLaneId],
  );

  function showToast(message: string, detail?: string, tone: ToastState['tone'] = 'success') {
    setToast({ message, detail, tone });
  }

  function scheduleImpactRefresh(
    runRef: Pick<DemoRun, 'id' | 'agentLaneId'>,
    patch: ImpactCopyPatch,
    changeSummary: string,
    sourceRef: string,
  ) {
    const refreshKey = runRef.agentLaneId;
    const prior = pendingImpactRefreshes.current.get(refreshKey);
    pendingImpactRefreshes.current.set(refreshKey, {
      patch: { ...prior?.patch, ...patch },
      changeSummary,
      sourceRefs: [...new Set([...(prior?.sourceRefs ?? []), sourceRef])],
      eventCount: (prior?.eventCount ?? 0) + 1,
    });

    setState((current) => {
      const storedRun = current.runs.find(
        (run) => run.agentLaneId === runRef.agentLaneId,
      );
      if (!storedRun) return current;
      const slot = current.impactSlots[storedRun.agentLaneId];
      if (!slot) return current;
      const eventTimestamp = isoDateTime(new Date().toISOString());
      const nextSourceSequence = slot.latestSourceEventSequence + 1;
      const request = requestImpactSummaryGeneration({
        slot,
        requestId: impactGenerationRequestId(
          `impact-request-${storedRun.agentLaneId}-${nextSourceSequence}`,
        ),
        event: {
          sequence: nextSourceSequence,
          kind: sourceRef.startsWith('interrupt') || sourceRef.startsWith('resume')
            ? 'human_control_changed'
            : 'progress_recorded',
          occurredAt: eventTimestamp,
        },
        requestedAt: eventTimestamp,
      });
      if (!request.allowed) {
        return {
          ...current,
          runs: current.runs.map((run) =>
            run.agentLaneId === runRef.agentLaneId
              ? {
                  ...run,
                  impactSummary: {
                    ...run.impactSummary,
                    freshness: 'error' as const,
                    error: request.reason,
                  },
                }
              : run,
          ),
        };
      }

      return {
        ...current,
        impactSlots: {
          ...current.impactSlots,
          [storedRun.agentLaneId]: request.value,
        },
        runs: current.runs.map((run) =>
          run.agentLaneId === runRef.agentLaneId
            ? {
                ...run,
                impactSummary: {
                  ...run.impactSummary,
                  freshness: 'refreshing' as const,
                  pendingSourceEvents:
                    (run.impactSummary.pendingSourceEvents ?? 0) + 1,
                  error: undefined,
                },
              }
            : run,
        ),
      };
    });

    const existingTimer = impactRefreshTimers.current.get(refreshKey);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    const timeout = window.setTimeout(() => {
      const pending = pendingImpactRefreshes.current.get(refreshKey);
      if (!pending) return;
      pendingImpactRefreshes.current.delete(refreshKey);
      impactRefreshTimers.current.delete(refreshKey);

      setState((current) => {
        const run = current.runs.find(
          (item) => item.agentLaneId === runRef.agentLaneId,
        );
        let slot = run ? current.impactSlots[run.agentLaneId] : undefined;
        if (!run || !slot?.activeRequest) return current;

        if (slot.activeRequest.state === 'queued') {
          const authorization = authorizeImpactSummaryGeneration({
            slot,
            actor: IMPACT_OBSERVER,
            requestId: slot.activeRequest.id,
            runId: impactObserverRunId(
              `impact-observer-${String(slot.activeRequest.id)}`,
            ),
            baseRevision: slot.activeRequest.baseRevision,
            model: impactModel(run.impactSummary),
            authorizedAt: isoDateTime(new Date().toISOString()),
          });
          if (!authorization.allowed) {
            return {
              ...current,
              runs: current.runs.map((item) =>
                item.agentLaneId === runRef.agentLaneId
                  ? {
                      ...item,
                      impactSummary: {
                        ...item.impactSummary,
                        freshness: 'error' as const,
                        pendingSourceEvents: 0,
                        error: authorization.reason,
                      },
                    }
                  : item,
              ),
            };
          }
          slot = authorization.value;
        }

        const activeRequest = slot.activeRequest;
        if (!activeRequest || activeRequest.state !== 'running') return current;
        const projectedRun = projectControlState(
          run,
          current.runControls[run.agentLaneId],
        );
        const copy = { ...run.impactSummary, ...pending.patch };
        const published = publishImpactSummaryRevision({
          slot,
          actor: IMPACT_OBSERVER,
          requestId: activeRequest.id,
          runId: activeRequest.authorization.runId,
          baseRevision: activeRequest.baseRevision,
          summary: {
            outcome: copy.outcome,
            userImpact: copy.userImpact,
            status: impactStatusForRun(projectedRun),
            nextMilestone: copy.nextMilestone,
          },
          generatedAt: isoDateTime(new Date().toISOString()),
        });

        if (!published.allowed) {
          const failed = failImpactSummaryGeneration({
            slot,
            actor: IMPACT_OBSERVER,
            requestId: activeRequest.id,
            runId: activeRequest.authorization.runId,
            baseRevision: activeRequest.baseRevision,
            message: published.reason,
            failedAt: isoDateTime(new Date().toISOString()),
          });
          return {
            ...current,
            impactSlots: failed.allowed
              ? { ...current.impactSlots, [run.agentLaneId]: failed.value }
              : current.impactSlots,
            runs: current.runs.map((item) =>
              item.agentLaneId === runRef.agentLaneId
                ? {
                    ...item,
                    impactSummary: {
                      ...item.impactSummary,
                      freshness: 'error' as const,
                      pendingSourceEvents: 0,
                      error: published.reason,
                    },
                  }
                : item,
            ),
          };
        }

        const revision = published.value.currentRevision;
        if (!revision) return current;
        const nextSummary: ImpactSummary = {
          ...copy,
          refreshedAt: 'just now',
          sourceUpdates: run.impactSummary.sourceUpdates + pending.eventCount,
          sourceThroughSequence: revision.sourceEventSequence,
          revision: revision.revision,
          revisionId: `impact-${run.agentLaneId}-r${revision.revision}`,
          freshness: published.value.freshness === 'fresh' ? 'current' : 'stale',
          changeSummary: pending.changeSummary,
          generatedBy: 'Impact observer',
          sourceRefs: [...new Set([...run.impactSummary.sourceRefs, ...pending.sourceRefs])].slice(-4),
          pendingSourceEvents: 0,
          error: undefined,
        };

        return {
          ...current,
          impactSlots: {
            ...current.impactSlots,
            [run.agentLaneId]: published.value,
          },
          runs: current.runs.map((item) =>
            item.agentLaneId === runRef.agentLaneId
              ? { ...item, impactSummary: nextSummary }
              : item,
          ),
          audit: [
            {
              id: uniqueDemoId('evt-impact'),
              actor: 'Impact observer',
              actorType: 'system' as const,
              action: 'published a summary revision',
              target: String(projectedRun.id),
              detail: `${pending.changeSummary} Read-only revision ${revision.revision} covered ${pending.eventCount} new ${pending.eventCount === 1 ? 'event' : 'events'}.`,
              time: `Today · ${nowLabel()}`,
              tone: 'neutral' as const,
            },
            ...current.audit,
          ],
        };
      });
    }, 650);
    impactRefreshTimers.current.set(refreshKey, timeout);
  }

  function addAuditEvent(event: Omit<AuditItem, 'id' | 'time'>) {
    setState((current) => ({
      ...current,
      audit: [
        {
          ...event,
          id: uniqueDemoId('evt-audit'),
          time: `Today · ${nowLabel()}`,
        },
        ...current.audit,
      ],
    }));
  }

  function openApproval(id: string) {
    setSelectedApprovalId(id);
  }

  function openAgentQueue(run: DemoRun) {
    setQueueLaneId(run.agentLaneId);
  }

  function openRun(runId: string) {
    const run = displayedRuns.find((candidate) => candidate.id === runId);
    if (run) setSelectedRunId(run.agentLaneId);
  }

  function queueAgentWork(input: {
    title: string;
    desiredOutcome: string;
    position: 'next' | 'backlog';
    expectedAgentMinutes: number;
  }) {
    const target = state.runs.find((run) => run.agentLaneId === queueLaneId);
    if (!target) {
      showToast('Agent queue is unavailable', 'The selected stable agent lane could not be found.', 'error');
      return;
    }

    const operationId = uniqueDemoId('queue-operation');
    let expectedAgentMinutes: ReturnType<typeof agentExpectedMinutes>;
    try {
      expectedAgentMinutes = agentExpectedMinutes(input.expectedAgentMinutes);
    } catch (error) {
      showToast(
        'Choose an agent work estimate',
        error instanceof Error ? error.message : 'Agent work estimates use 15-minute increments.',
        'error',
      );
      return;
    }
    const queueItem = {
      id: `queue-${target.agentLaneId}-${operationId}`,
      laneId: target.agentLaneId,
      title: input.title.trim(),
      desiredOutcome: input.desiredOutcome.trim(),
      position: input.position,
      expectedAgentMinutes,
      queuedAt: 'just now',
      queuedBy: 'Jordan Lee',
    } as const;
    const control = state.runControls[target.agentLaneId];
    if (!control) {
      showToast('Agent queue is unavailable', 'The lane has no canonical control state.', 'error');
      return;
    }
    const domainDecision = queueDomainWork({
      control,
      actor: SEED_HUMAN,
      workId: queuedWorkId(queueItem.id),
      signalId: runControlSignalId(`signal-${operationId}-queue`),
      title: queueItem.title,
      desiredOutcome: queueItem.desiredOutcome,
      expectedAgentMinutes: queueItem.expectedAgentMinutes,
      priority: queueItem.position,
      queuedAt: isoDateTime(new Date().toISOString()),
    });
    if (!domainDecision.allowed) {
      showToast('Work could not be queued', domainDecision.reason, 'error');
      return;
    }

    setState((current) => ({
      ...current,
      runControls: {
        ...current.runControls,
        [target.agentLaneId]: domainDecision.value,
      },
      audit: [
        {
          id: uniqueDemoId('evt-queue'),
          actor: 'Jordan Lee',
          actorType: 'human' as const,
          action: 'queued work for an agent',
          target: `${target.agent} · ${target.agentLaneId}`,
          detail: `${input.title.trim()} — desired result: ${input.desiredOutcome.trim()}. Estimated agent work: ${input.expectedAgentMinutes} minutes; human review and waiting are excluded. The queue remains with the agent lane across run attempts.`,
          time: `Today · ${nowLabel()}`,
          tone: 'neutral' as const,
        },
        ...current.audit,
      ],
    }));
    scheduleImpactRefresh(
      target,
      {
        plainStatus: `${target.agent}'s current assignment continues unchanged. Jordan added another desired result to the stable agent queue.`,
        nextMilestone:
          input.position === 'next'
            ? control.queue.some((item) => item.priority === 'next')
              ? `${input.title.trim()} is in the next-up queue behind earlier requests.`
              : `${input.title.trim()} is next after the current checkpoint.`
            : `${input.title.trim()} is saved in the later-work queue.`,
      },
      'Added a human-requested outcome without changing the active assignment.',
      queueItem.id,
    );
    setQueueLaneId(null);
    showToast(
      'Work queued for ' + target.agent,
      'The current task was not interrupted. The result is stored on the agent lane and survives run replacement.',
    );
  }

  function interruptAgent(run: DemoRun) {
    if (
      run.controlState === 'interrupt_requested' ||
      run.controlState === 'interrupt_acknowledged'
    ) {
      showToast(
        'Interrupt already pending',
        'Steward is still waiting for the worker to confirm that the process stopped.',
      );
      return;
    }

    const control = state.runControls[run.agentLaneId];
    if (!control) {
      showToast('Interrupt could not be requested', 'The lane has no canonical control state.', 'error');
      return;
    }

    const operationId = uniqueDemoId('interrupt-operation');
    const interruptionReason = 'Jordan requested an interruption of this agent.';
    const requestDecision = requestAgentRunInterruption({
      control,
      actor: SEED_HUMAN,
      signalId: runControlSignalId(`signal-${operationId}-interrupt-request`),
      requestedAt: isoDateTime(new Date().toISOString()),
      reason: interruptionReason,
    });
    if (!requestDecision.allowed) {
      showToast('Interrupt could not be requested', requestDecision.reason, 'error');
      return;
    }

    setState((current) => ({
      ...current,
      runControls: {
        ...current.runControls,
        [run.agentLaneId]: requestDecision.value,
      },
      audit: [
        {
          id: `evt-${operationId}-interrupt`,
          actor: 'Jordan Lee',
          actorType: 'human' as const,
          action: 'requested an agent interruption',
          target: `${run.agent} · ${run.id}`,
          detail: 'Fenced new dispatches and asked the worker to checkpoint and stop. Process settlement is still pending.',
          time: `Today · ${nowLabel()}`,
          tone: 'amber' as const,
        },
        ...current.audit,
      ],
    }));
    scheduleImpactRefresh(
      run,
      {
        plainStatus: `Jordan requested that ${run.agent} stop. Steward is waiting for the worker to acknowledge the request and is not yet claiming the process ended.`,
        nextMilestone: `The worker confirms that ${run.agent}'s checkpoint is saved and the process has stopped.`,
      },
      'Recorded a human interrupt request while process settlement remained pending.',
      `interrupt-request-${run.id}-${operationId}`,
    );
    showToast(
      `Interrupt requested for ${run.agent}`,
      'New dispatches are fenced while Steward waits for worker acknowledgement.',
    );

    window.setTimeout(() => {
      setState((current) => {
        const currentControl = current.runControls[run.agentLaneId];
        if (!currentControl) return current;
        const acknowledgedAt = isoDateTime(new Date().toISOString());
        const decision = acknowledgeAgentRunInterruption({
          control: currentControl,
          actor: DEMO_ORCHESTRATION_WORKER,
          runId: agentRunId(run.id),
          signalId: runControlSignalId(`signal-${operationId}-interrupt-ack`),
          acknowledgedAt,
        });
        if (!decision.allowed) return current;
        return {
          ...current,
          runControls: {
            ...current.runControls,
            [run.agentLaneId]: decision.value,
          },
          audit: [
            {
              id: `evt-${operationId}-interrupt-ack`,
              actor: 'Orchestration worker',
              actorType: 'system' as const,
              action: 'acknowledged an interrupt request',
              target: `${run.agent} · ${run.id}`,
              detail: 'Accepted the cancellation request and began settling the active provider process.',
              time: `Today · ${nowLabel()}`,
              tone: 'amber' as const,
            },
            ...current.audit,
          ],
        };
      });
      scheduleImpactRefresh(
        run,
        {
          plainStatus: `${run.agent}'s worker acknowledged the interruption and is settling the active process.`,
          nextMilestone: 'Confirm process settlement before offering resume.',
        },
        'Recorded worker acknowledgement without prematurely claiming the process stopped.',
        `interrupt-ack-${run.id}-${operationId}`,
      );

      window.setTimeout(() => {
        setState((current) => {
          const currentControl = current.runControls[run.agentLaneId];
          if (!currentControl) return current;
          const settledAt = isoDateTime(new Date().toISOString());
          const decision = settleAgentRunInterruption({
            control: currentControl,
            actor: DEMO_ORCHESTRATION_WORKER,
            runId: agentRunId(run.id),
            signalId: runControlSignalId(`signal-${operationId}-interrupt-settled`),
            outcome: 'interrupted',
            settledAt,
            detail:
              'The worker confirmed the provider process stopped. Workspace, checkpoint, journal, and stable queue remain preserved.',
          });
          if (!decision.allowed) return current;
          const currentTask = current.agentTasks[run.agentLaneId];
          const pausedTask =
            currentTask?.status === 'running'
              ? pauseAgentTask({ task: currentTask, pausedAt: settledAt })
              : undefined;
          return {
            ...current,
            runControls: {
              ...current.runControls,
              [run.agentLaneId]: decision.value,
            },
            agentTasks:
              pausedTask?.allowed === true
                ? {
                    ...current.agentTasks,
                    [run.agentLaneId]: pausedTask.value,
                  }
                : current.agentTasks,
            audit: [
              {
                id: `evt-${operationId}-interrupt-settled`,
                actor: 'Orchestration worker',
                actorType: 'system' as const,
                action: 'confirmed an interrupted process stopped',
                target: `${run.agent} · ${run.id}`,
                detail: 'Provider process settlement was observed; the workspace, checkpoint, evidence, and agent-lane queue remain preserved.',
                time: `Today · ${nowLabel()}`,
                tone: 'amber' as const,
              },
              ...current.audit,
            ],
          };
        });
        scheduleImpactRefresh(
          run,
          {
            plainStatus: `${run.agent} is now confirmed stopped. The saved work and evidence remain available, and no additional work is happening.`,
            nextMilestone: `A human reviews the saved checkpoint and resumes ${run.agent} when it is safe to continue.`,
          },
          'Confirmed that the worker process stopped and preserved the checkpoint.',
          `interrupt-settled-${run.id}-${operationId}`,
        );
        showToast(
          `${run.agent} interrupted`,
          'The worker confirmed process settlement; workspace, journal, checkpoint, and queued work are preserved.',
        );
      }, 350);
    }, 350);
  }

  function resumeAgent(run: DemoRun) {
    const control = state.runControls[run.agentLaneId];
    if (!control) {
      showToast('Agent could not be resumed', 'The lane has no canonical control state.', 'error');
      return;
    }
    const operationId = uniqueDemoId('resume-operation');
    const resumedAt = isoDateTime(new Date().toISOString());
    const decision = resumeDomainRun({
      control,
      actor: SEED_HUMAN,
      signalId: runControlSignalId(`signal-${operationId}-resume`),
      resumedAt,
    });
    if (!decision.allowed) {
      showToast('Agent could not be resumed', decision.reason, 'error');
      return;
    }

    setState((current) => {
      const currentTask = current.agentTasks[run.agentLaneId];
      const resumedTask =
        !current.paused && currentTask?.status === 'paused'
          ? resumeAgentTask({ task: currentTask, resumedAt })
          : undefined;
      return {
        ...current,
        runControls: {
          ...current.runControls,
          [run.agentLaneId]: decision.value,
        },
        agentTasks:
          resumedTask?.allowed === true
            ? {
                ...current.agentTasks,
                [run.agentLaneId]: resumedTask.value,
              }
            : current.agentTasks,
        audit: [
        {
          id: `evt-${operationId}-resume`,
          actor: 'Jordan Lee',
          actorType: 'human' as const,
          action: 'resumed an interrupted agent',
          target: `${run.agent} · ${run.id}`,
          detail: 'Continued from the preserved checkpoint without skipping the engineering loop.',
          time: `Today · ${nowLabel()}`,
          tone: 'green' as const,
        },
        ...current.audit,
      ],
      };
    });
    scheduleImpactRefresh(
      run,
      {
        plainStatus: `${run.agent} resumed from the saved checkpoint and can continue toward the intended user outcome.`,
        nextMilestone: run.nextStep,
      },
      'Recorded the human-authorized resume from the preserved checkpoint.',
      `resume-${run.id}-${operationId}`,
    );
    showToast(
      `${run.agent} resumed`,
      state.paused
        ? 'This agent is ready, but the workspace-wide pause still prevents new actions.'
        : 'Work can continue from the preserved checkpoint.',
    );
  }

  function approveNonProduction(approval: ApprovalItem, decisionOptionId?: string) {
    const selectedDecision =
      approval.kind === 'decision'
        ? approval.checks.find((check) => check.id === decisionOptionId)
        : undefined;
    if (approval.kind === 'decision' && !selectedDecision) {
      showToast(
        'Choose a product direction',
        'Select the customer behavior the team should implement before recording this decision.',
        'error',
      );
      return;
    }

    const resolvedAt = isoDateTime(new Date().toISOString());
    setState((current) => ({
      ...current,
      approvals: current.approvals.map((item) =>
        item.id === approval.id
          ? {
              ...item,
              status: 'approved' as const,
              endedAt: resolvedAt,
              decision: selectedDecision
                ? {
                    optionId: selectedDecision.id,
                    label: selectedDecision.label,
                    detail: selectedDecision.detail,
                    decidedBy: 'Jordan Lee',
                    decidedAt: resolvedAt,
                  }
                : item.decision,
            }
          : item,
      ),
      missions: current.missions.map((mission) =>
        mission.id === approval.workItemId
          ? {
              ...mission,
              state: approval.kind === 'scope' ? ('engineering' as const) : mission.state,
              progress:
                approval.kind === 'scope'
                  ? Math.max(mission.progress, 14)
                  : Math.max(mission.progress, 83),
              updated: 'just now',
            }
          : mission,
      ),
      audit: [
        {
          id: uniqueDemoId('evt-approval'),
          actor: 'Jordan Lee',
          actorType: 'human' as const,
          action: approval.kind === 'scope' ? 'approved development scope' : 'recorded product direction',
          target: `${approval.workItemId} · ${approval.id}`,
          detail:
            approval.kind === 'scope'
              ? 'Authorized the fixed role team to begin work inside the bounded development environment.'
              : `Chose “${selectedDecision?.label}” (${selectedDecision?.detail}); verification and manager review may continue.`,
          time: `Today · ${nowLabel()}`,
          tone: 'green' as const,
        },
        ...current.audit,
      ],
    }));
    setSelectedApprovalId(null);
    showToast(
      approval.kind === 'scope' ? 'Scope approved' : 'Decision recorded',
      approval.kind === 'scope'
        ? 'The role team can now work freely inside development.'
        : 'The verifier has been unblocked with your direction.',
    );
  }

  function handleApprove(approval: ApprovalItem, decisionOptionId?: string) {
    const canonicalApproval = state.approvals.find((item) => item.id === approval.id);
    if (!canonicalApproval || canonicalApproval.status !== 'pending') {
      showToast('This request is already closed', 'Its recorded decision remains visible in this browser.', 'error');
      return;
    }
    if (canonicalApproval.kind === 'production') {
      if (!canonicalApproval.managerReview) {
        showToast(
          'Manager review required',
          'A different manager must check the completed engineering loop before a human production task can be posted.',
          'error',
        );
        return;
      }
      setProductionApproval(canonicalApproval);
      return;
    }
    approveNonProduction(canonicalApproval, decisionOptionId);
  }

  function confirmProduction(approval: ApprovalItem) {
    const canonicalApproval = state.approvals.find((item) => item.id === approval.id);
    if (!canonicalApproval || canonicalApproval.status !== 'pending') {
      setProductionApproval(null);
      showToast(
        'This production task is already closed',
        'Steward rejected the stale confirmation instead of changing an existing decision.',
        'error',
      );
      return;
    }
    if (!canonicalApproval.managerReview) {
      showToast(
        'Release approval was denied',
        'No accepted manager review is attached to this production-check task.',
        'error',
      );
      return;
    }

    const approvedAt = isoDateTime(new Date().toISOString());
    const displayedRelease = releaseCandidateFromDisplayedEvidence(canonicalApproval);
    const approved = policyEngine.current.approve({
      approvalId: approvalId(`domain-${approval.id.toLowerCase()}`),
      release: displayedRelease,
      productionCheckTask: SEED_PRODUCTION_CHECK_TASK,
      actor: SEED_HUMAN,
      approvedAt,
    });

    if (!approved.allowed) {
      showToast('Release approval was denied', approved.reason, 'error');
      return;
    }

    const consumed = policyEngine.current.consume({
      approvalId: approved.value.id,
      release: displayedRelease,
      actor: DEPLOYMENT_BROKER,
      consumedAt: isoDateTime(new Date().toISOString()),
    });

    if (!consumed.allowed) {
      showToast('Demo policy refused authorization', consumed.reason, 'error');
      return;
    }

    setState((current) => ({
      ...current,
      approvals: current.approvals.map((item) =>
        item.id === canonicalApproval.id
          ? { ...item, status: 'deployed' as const, endedAt: approvedAt }
          : item,
      ),
      missions: current.missions.map((mission) =>
        mission.id === canonicalApproval.workItemId
          ? { ...mission, state: 'deployed' as const, progress: 100, updated: 'just now' }
          : mission,
      ),
      audit: [
        {
          id: uniqueDemoId('evt-broker'),
          actor: 'Simulated broker',
          actorType: 'system' as const,
          action: 'simulated single-use approval consumption',
          target: `${canonicalApproval.workItemId} · ${canonicalApproval.release?.commit.slice(0, 7) ?? ''}`,
          detail: `Matched the approved release digests for ${canonicalApproval.target}. This browser-local demo did not queue or deploy an artifact.`,
          time: `Today · ${nowLabel()}`,
          tone: 'green' as const,
        },
        {
          id: uniqueDemoId('evt-human-approval'),
          actor: 'Jordan Lee',
          actorType: 'human' as const,
          action: 'recorded release authorization',
          target: `${canonicalApproval.workItemId} · ${canonicalApproval.release?.commit.slice(0, 7) ?? ''}`,
          detail: `Authorized build ${canonicalApproval.release?.buildDigest}; approval was bound to all six release digests.`,
          time: `Today · ${nowLabel()}`,
          tone: 'green' as const,
        },
        ...current.audit,
      ],
    }));
    setProductionApproval(null);
    setSelectedApprovalId(null);
    showToast('Demo authorization recorded', 'Stored in this browser only. No artifact was deployed.');
  }

  function confirmChanges(approval: ApprovalItem, note: string) {
    const canonicalApproval = state.approvals.find((item) => item.id === approval.id);
    if (!canonicalApproval || canonicalApproval.status !== 'pending') {
      setChangesApproval(null);
      showToast(
        'This request is already closed',
        'Steward rejected the stale change request and preserved the recorded decision.',
        'error',
      );
      return;
    }

    const resolvedAt = isoDateTime(new Date().toISOString());
    setState((current) => ({
      ...current,
      approvals: current.approvals.map((item) =>
        item.id === canonicalApproval.id
          ? { ...item, status: 'changes_requested' as const, endedAt: resolvedAt }
          : item,
      ),
      missions: current.missions.map((mission) =>
        mission.id === canonicalApproval.workItemId
          ? { ...mission, state: 'blocked' as const, updated: 'just now' }
          : mission,
      ),
      audit: [
        {
          id: uniqueDemoId('evt-changes'),
          actor: 'Jordan Lee',
          actorType: 'human' as const,
          action: 'requested changes',
          target: `${canonicalApproval.workItemId} · ${canonicalApproval.id}`,
          detail: note,
          time: `Today · ${nowLabel()}`,
          tone: 'amber' as const,
        },
        ...current.audit,
      ],
    }));
    setChangesApproval(null);
    setSelectedApprovalId(null);
    showToast('Direction sent to the team', 'The current handoff is preserved and a new revision is blocked on your note.');
  }

  function createMission(input: NewMissionInput) {
    const nextNumber =
      Math.max(...state.missions.map((mission) => Number(mission.id.replace('STW-', '')) || 0)) + 1;
    const id = `STW-${nextNumber}`;
    const approvalNumber = 22 + state.approvals.filter((approval) => approval.id.startsWith('APR-02')).length;
    const approval: ApprovalItem = {
      id: `APR-${approvalNumber}`,
      workItemId: id,
      project: 'New mission',
      title: `Approve scope for ${input.title}`,
      summary: `${input.goal} Mira will define acceptance criteria, risks, and a compact context packet before an engineer starts the completion loop.`,
      kind: 'scope',
      status: 'pending',
      risk: input.risk,
      requestedAt: 'just now',
      startedAt: isoDateTime(new Date().toISOString()),
      requestedBy: 'Mira',
      requestedByColor: '#e2e3ea',
      requestedByRole: 'Engineering manager',
      budget: `$${input.budget.toFixed(2)} token cap`,
      checks: [
        { id: 'criteria', label: 'Intent captured', detail: 'Goal and outcome recorded', status: 'passed' },
        { id: 'budget', label: 'Token envelope', detail: `$${input.budget.toFixed(2)} hard stop`, status: 'passed' },
        { id: 'risk', label: 'Initial risk', detail: `${input.risk} · Manager will refine`, status: 'warning' },
      ],
    };
    const mission: DemoMission = {
      id,
      title: input.title,
      project: 'New mission',
      goal: input.goal,
      state: 'scope_review',
      risk: input.risk,
      progress: 5,
      owner: 'Mira',
      ownerColor: '#e2e3ea',
      model: 'Claude Haiku 4.5',
      spent: 0.04,
      budget: input.budget,
      updated: 'just now',
      branch: `mission/${id.toLowerCase()}-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    };

    setState((current) => ({
      ...current,
      missions: [mission, ...current.missions],
      approvals: [approval, ...current.approvals],
      audit: [
        {
          id: uniqueDemoId('evt-mission'),
          actor: 'Jordan Lee',
          actorType: 'human' as const,
          action: 'created a mission',
          target: id,
          detail: `Set a ${input.risk}-risk mission with a $${input.budget.toFixed(2)} token cap.`,
          time: `Today · ${nowLabel()}`,
          tone: 'neutral' as const,
        },
        ...current.audit,
      ],
    }));
    setNewMissionOpen(false);
    setCurrentView('approvals');
    showToast('Mission drafted', `${id} is waiting for your scope approval before agents touch code.`);
  }

  function togglePause() {
    const next = !state.paused;
    const transitionedAt = isoDateTime(new Date().toISOString());
    setState((current) => {
      const agentTasks = Object.fromEntries(
        Object.entries(current.agentTasks).map(([laneId, task]) => {
          const laneRunning = current.runControls[laneId]?.status === 'running';
          const transition = next
            ? task.status === 'running' && laneRunning
              ? pauseAgentTask({ task, pausedAt: transitionedAt })
              : undefined
            : task.status === 'paused' && laneRunning
              ? resumeAgentTask({ task, resumedAt: transitionedAt })
              : undefined;
          return [laneId, transition?.allowed === true ? transition.value : task] as const;
        }),
      );
      return { ...current, paused: next, agentTasks };
    });
    addAuditEvent({
      actor: 'Jordan Lee',
      actorType: 'human',
      action: next ? 'paused all agent runs' : 'resumed development runs',
      target: 'Northwind Labs workspace',
      detail: next
        ? 'Active workspaces and context were preserved; no new model calls may start.'
        : 'Authorized queued development work to continue under existing budgets and policy.',
      tone: next ? 'amber' : 'green',
    });
    showToast(next ? 'All agents paused' : 'Development resumed', next ? 'Workspaces and context are safely preserved.' : 'Existing missions are moving again.');
  }

  let view: React.ReactNode;
  switch (currentView) {
    case 'overview':
      view = (
        <OverviewView
          approvals={state.approvals}
          missions={state.missions}
          runs={displayedRuns}
          paused={state.paused}
          onOpenApproval={openApproval}
          onViewApprovals={() => setCurrentView('approvals')}
          onViewRuns={() => setCurrentView('runs')}
          onNewMission={() => setNewMissionOpen(true)}
          onOpenRun={openRun}
        />
      );
      break;
    case 'missions':
      view = (
        <MissionsView
          missions={state.missions}
          filter={missionFilter}
          riskFilter={missionRiskFilter}
          onFilterChange={setMissionFilter}
          onRiskFilterChange={setMissionRiskFilter}
        />
      );
      break;
    case 'runs':
      view = <RunsView runs={displayedRuns} onOpenRun={openRun} />;
      break;
    case 'approvals':
      view = <ApprovalsView approvals={state.approvals} onOpenApproval={openApproval} />;
      break;
    case 'team':
      view = <TeamView agents={demoAgents} runs={displayedRuns} onControlAgent={openRun} />;
      break;
    case 'routing':
      view = <RoutingView />;
      break;
    case 'audit':
      view = (
        <AuditView
          items={state.audit}
          actorFilter={auditFilter}
          onActorFilterChange={setAuditFilter}
        />
      );
      break;
  }

  return (
    <>
      <AppShell
        currentView={currentView}
        onNavigate={setCurrentView}
        attentionCount={pendingCount}
        paused={state.paused}
        onTogglePause={togglePause}
        onNewMission={() => setNewMissionOpen(true)}
      >
        {view}
      </AppShell>

      <ApprovalDrawer
        approval={selectedApproval}
        open={Boolean(selectedApproval)}
        onClose={() => setSelectedApprovalId(null)}
        onApprove={handleApprove}
        onRequestChanges={setChangesApproval}
      />
      <RunInspector
        run={selectedRun}
        open={Boolean(selectedRun)}
        onClose={() => setSelectedRunId(null)}
        onQueue={openAgentQueue}
        onInterrupt={interruptAgent}
        onResume={resumeAgent}
      />
      <AgentQueueModal
        run={queueRun}
        open={Boolean(queueRun)}
        onClose={() => setQueueLaneId(null)}
        onSubmit={queueAgentWork}
      />
      <ProductionApprovalModal
        approval={productionApproval}
        onClose={() => setProductionApproval(null)}
        onConfirm={confirmProduction}
      />
      <RequestChangesModal
        approval={changesApproval}
        onClose={() => setChangesApproval(null)}
        onConfirm={confirmChanges}
      />
      <NewMissionModal open={newMissionOpen} onClose={() => setNewMissionOpen(false)} onCreate={createMission} />

      {toast ? (
        <div
          className={cn(
            'fixed left-4 right-4 top-20 z-[70] mx-auto flex max-w-md items-start gap-3 rounded-[14px] border bg-white p-4 text-ink shadow-[0_1px_2px_rgba(23,28,36,.05),0_10px_30px_rgba(23,28,36,.14)] sm:left-auto sm:right-5 sm:top-5 sm:mx-0',
            toast.tone === 'success' ? 'border-teal-border' : 'border-urgent-border',
          )}
          role="status"
        >
          <span
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-[8px]',
              toast.tone === 'success' ? 'bg-teal-soft text-teal-700' : 'bg-urgent-soft text-urgent',
            )}
          >
            {toast.tone === 'success' ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{toast.message}</p>
            {toast.detail ? <p className="mt-0.5 text-xs leading-4 text-muted">{toast.detail}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="grid size-7 place-items-center rounded-[8px] text-muted hover:bg-line-soft hover:text-ink"
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </>
  );
}
