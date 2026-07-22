import type { AgentExpectedMinutes, AgentTask, ISODateTime } from '../domain';

export type ApprovalKind = 'production' | 'scope' | 'decision';
export type ApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'deployed';
export type RiskTone = 'low' | 'medium' | 'high' | 'critical';

export interface EvidenceCheck {
  id: string;
  label: string;
  detail: string;
  status: 'passed' | 'warning' | 'pending';
}

export interface ApprovalItem {
  id: string;
  workItemId: string;
  project: string;
  title: string;
  summary: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  risk: RiskTone;
  requestedAt: string;
  /** Exact human-task lifecycle timestamps; human work intentionally has no ETA. */
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  requestedBy: string;
  requestedByColor: string;
  requestedByRole: string;
  budget?: string;
  branch?: string;
  target?: string;
  confirmationPhrase?: string;
  release?: {
    commit: string;
    buildDigest: string;
    artifactDigest: string;
    testsDigest: string;
    configDigest: string;
    migrationsDigest: string;
    changedFiles: number;
    additions: number;
    deletions: number;
    cost: number;
    baselineCost: number;
    rollback: string;
  };
  managerReview?: {
    manager: string;
    managerColor: string;
    completedAt: string;
    summary: string;
    confidence: 'high' | 'medium' | 'low';
    reviewedFiles: number;
    findings: string[];
    openRisks: string[];
    engineerLoops: number;
  };
  decision?: {
    optionId: string;
    label: string;
    detail: string;
    decidedBy: string;
    decidedAt: string;
  };
  checks: EvidenceCheck[];
}

export interface DemoMission {
  id: string;
  title: string;
  project: string;
  goal: string;
  state:
    | 'scope_review'
    | 'engineering'
    | 'manager_review'
    | 'human_review'
    | 'deployed'
    | 'blocked';
  risk: RiskTone;
  progress: number;
  owner: string;
  ownerColor: string;
  model: string;
  spent: number;
  budget: number;
  updated: string;
  branch: string;
}

export interface QueuedAgentWork {
  id: string;
  laneId: string;
  title: string;
  desiredOutcome: string;
  expectedAgentMinutes: AgentExpectedMinutes;
  position: 'next' | 'backlog';
  queuedAt: string;
  queuedBy: string;
}

export type AgentControlState =
  | 'idle'
  | 'running'
  | 'interrupt_requested'
  | 'interrupt_acknowledged'
  | 'interrupted'
  | 'interrupt_refused'
  | 'interrupt_unknown';

export function isInterruptPending(state: AgentControlState): boolean {
  return state === 'interrupt_requested' || state === 'interrupt_acknowledged';
}

export function isInterruptSettled(state: AgentControlState): boolean {
  return state === 'interrupted';
}

export function isRunStateUncertain(state: AgentControlState): boolean {
  return state === 'interrupt_unknown';
}

export interface ImpactSummary {
  outcome: string;
  userImpact: string;
  plainStatus: string;
  nextMilestone: string;
  refreshedAt: string;
  model: string;
  sourceUpdates: number;
  confidence: 'high' | 'medium' | 'low';
  revision: number;
  revisionId: string;
  sourceThroughSequence: number;
  freshness: 'current' | 'refreshing' | 'stale' | 'error';
  changeSummary: string;
  generatedBy: 'Impact observer';
  sourceRefs: string[];
  pendingSourceEvents?: number;
  error?: string;
}

export interface DemoRun {
  id: string;
  agentLaneId: string;
  workItemId: string;
  agent: string;
  role: string;
  color: string;
  model: string;
  tier: 'Economy' | 'Balanced' | 'Frontier';
  activity: string;
  detail: string;
  progress: number;
  tokens: number;
  tokenLimit: number;
  cost: number;
  started: string;
  status: 'working' | 'checking' | 'waiting';
  /** Presentation-only projection of the workspace-wide human pause. */
  workspacePaused?: boolean;
  loopPhase: 'research' | 'plan' | 'execute' | 'test' | 'manager_review';
  iteration: number;
  lastHeartbeat: string;
  currentAction: {
    label: string;
    detail: string;
    kind: 'analysis' | 'file' | 'command' | 'review';
    target?: string;
    tool: string;
    elapsed: string;
  };
  loopSteps: Array<{
    phase: 'Research' | 'Plan' | 'Execute' | 'Test';
    status: 'done' | 'active' | 'queued' | 'failed';
    detail: string;
  }>;
  journal: Array<{
    id: string;
    time: string;
    phase: string;
    title: string;
    note: string;
    evidence?: string;
    tone: 'note' | 'success' | 'warning';
  }>;
  nextStep: string;
  controlState: AgentControlState;
  interruptRequestedAt?: string;
  interruptAcknowledgedAt?: string;
  interruptedAt?: string;
  interruptionReason?: string;
  interruptionDetail?: string;
  queue: QueuedAgentWork[];
  /** Stable task projection. Provider-run replacement must not reset this timing. */
  agentTask?: AgentTask;
  impactSummary: ImpactSummary;
}

export interface DemoAgent {
  id: string;
  name: string;
  role: 'Engineering manager' | 'Software engineer' | 'Verification engineer';
  color: string;
  model: string;
  provider: 'Anthropic' | 'OpenAI';
  status: 'active' | 'idle' | 'waiting';
  responsibility: string;
  can: string[];
  cannot: string[];
  spend: number;
}

export interface AuditItem {
  id: string;
  actor: string;
  actorType: 'human' | 'agent' | 'system';
  action: string;
  target: string;
  detail: string;
  time: string;
  tone: 'neutral' | 'green' | 'amber' | 'red';
}

export const initialApprovals: ApprovalItem[] = [
  {
    id: 'APR-019',
    workItemId: 'STW-482',
    project: 'Identity service',
    title: 'Promote SSO session hardening',
    summary:
      'Ships rotating refresh tokens, replay detection, and a guarded session migration. The candidate passed independent review and the full release suite.',
    kind: 'production',
    status: 'pending',
    risk: 'high',
    requestedAt: '11 min ago',
    startedAt: '2026-07-18T23:16:00.000Z' as ISODateTime,
    requestedBy: 'Vale',
    requestedByColor: '#e4e7ea',
    requestedByRole: 'Engineering manager',
    branch: 'release/stw-482-session-hardening',
    target: 'Production · us-west-2',
    confirmationPhrase: 'AUTHORIZE STW-482',
    release: {
      commit: '7f83b1657ff1fc53b92dc18148a1d65dfa13514d',
      buildDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      artifactDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      testsDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      configDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      migrationsDigest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      changedFiles: 14,
      additions: 428,
      deletions: 96,
      cost: 3.84,
      baselineCost: 12.76,
      rollback: 'Repoint identity-service to image 2026.07.17-3; migration is additive.',
    },
    managerReview: {
      manager: 'Vale',
      managerColor: '#e4e7ea',
      completedAt: '13 min ago',
      summary:
        'Reviewed the complete diff, replay-threat model, migration behavior, and release evidence. The implementation meets the agreed acceptance criteria and is ready for a human production check.',
      confidence: 'high',
      reviewedFiles: 14,
      findings: [
        'Refresh-token reuse invalidates the full token family and records a security event.',
        'The additive session migration is backward compatible and its rollback was rehearsed in preview.',
        'All 286 automated checks passed against the immutable candidate.',
      ],
      openRisks: [
        'Watch sign-in failure and token-refresh error rates during the first 30 minutes of rollout.',
      ],
      engineerLoops: 2,
    },
    checks: [
      { id: 'tests', label: 'Test suite', detail: '286 passed · 0 failed', status: 'passed' },
      { id: 'review', label: 'Independent review', detail: 'Vale · Claude Sonnet 5', status: 'passed' },
      { id: 'security', label: 'Security policy', detail: 'No high findings', status: 'passed' },
      { id: 'rollback', label: 'Rollback rehearsal', detail: 'Completed in preview', status: 'passed' },
    ],
  },
  {
    id: 'APR-020',
    workItemId: 'STW-476',
    project: 'Billing platform',
    title: 'Approve webhook reliability scope',
    summary:
      'Authorize the team to add idempotency storage, replay tooling, and provider-specific retry policies inside the isolated development workspace.',
    kind: 'scope',
    status: 'pending',
    risk: 'medium',
    requestedAt: '34 min ago',
    startedAt: '2026-07-18T22:53:00.000Z' as ISODateTime,
    requestedBy: 'Mira',
    requestedByColor: '#e2e3ea',
    requestedByRole: 'Engineering manager',
    budget: '$9.00 token cap',
    branch: 'mission/stw-476-webhook-reliability',
    checks: [
      { id: 'criteria', label: 'Acceptance criteria', detail: '6 outcomes defined', status: 'passed' },
      { id: 'budget', label: 'Token envelope', detail: '$9.00 hard stop', status: 'passed' },
      { id: 'risk', label: 'Risk inventory', detail: 'Migration flagged for review', status: 'warning' },
    ],
  },
  {
    id: 'APR-021',
    workItemId: 'STW-479',
    project: 'Activation experience',
    title: 'Choose retry behavior for imports',
    summary:
      'Verification found two valid behaviors for partially imported workspaces. The choice changes the customer experience, so the team stopped instead of guessing.',
    kind: 'decision',
    status: 'pending',
    risk: 'medium',
    requestedAt: '1 hr ago',
    startedAt: '2026-07-18T22:27:00.000Z' as ISODateTime,
    requestedBy: 'Gauge',
    requestedByColor: '#dce9ef',
    requestedByRole: 'Verification engineer',
    branch: 'feat/stw-479-guided-import',
    checks: [
      { id: 'option-a', label: 'Resume completed steps', detail: 'Faster; more state complexity', status: 'warning' },
      { id: 'option-b', label: 'Restart import safely', detail: 'Simpler; repeats uploads', status: 'warning' },
    ],
  },
];

export const initialMissions: DemoMission[] = [
  {
    id: 'STW-482',
    title: 'Harden SSO session lifecycle',
    project: 'Identity service',
    goal: 'Reduce account takeover risk without forcing active users to sign in again.',
    state: 'human_review',
    risk: 'high',
    progress: 100,
    owner: 'Vale',
    ownerColor: '#e4e7ea',
    model: 'Claude Haiku 4.5',
    spent: 3.84,
    budget: 8,
    updated: '11 min ago',
    branch: 'release/stw-482-session-hardening',
  },
  {
    id: 'STW-479',
    title: 'Make workspace imports recoverable',
    project: 'Activation experience',
    goal: 'Let customers safely recover from interrupted imports without support.',
    state: 'manager_review',
    risk: 'medium',
    progress: 82,
    owner: 'Gauge',
    ownerColor: '#dce9ef',
    model: 'GPT-5.4 mini + deterministic checks',
    spent: 2.12,
    budget: 7,
    updated: '8 min ago',
    branch: 'feat/stw-479-guided-import',
  },
  {
    id: 'STW-476',
    title: 'Make billing webhooks idempotent',
    project: 'Billing platform',
    goal: 'Eliminate duplicate fulfillment when payment providers retry events.',
    state: 'scope_review',
    risk: 'medium',
    progress: 8,
    owner: 'Mira',
    ownerColor: '#e2e3ea',
    model: 'Claude Haiku 4.5',
    spent: 0.18,
    budget: 9,
    updated: '34 min ago',
    branch: 'mission/stw-476-webhook-reliability',
  },
  {
    id: 'STW-471',
    title: 'Polish mobile navigation',
    project: 'Customer dashboard',
    goal: 'Make the five most common actions one-thumb reachable on small screens.',
    state: 'engineering',
    risk: 'low',
    progress: 64,
    owner: 'Patch',
    ownerColor: '#d5eeeb',
    model: 'GPT-5.4 mini',
    spent: 0.72,
    budget: 4,
    updated: 'just now',
    branch: 'feat/stw-471-mobile-navigation',
  },
  {
    id: 'STW-465',
    title: 'Reduce search response latency',
    project: 'Search API',
    goal: 'Keep p95 query latency below 300 ms for large workspaces.',
    state: 'deployed',
    risk: 'medium',
    progress: 100,
    owner: 'Harbor',
    ownerColor: '#f6dfad',
    model: 'Mixed route',
    spent: 4.91,
    budget: 11,
    updated: 'Yesterday',
    branch: 'release/stw-465-search-cache',
  },
];

export const initialRuns: DemoRun[] = [
  {
    id: 'RUN-882',
    agentLaneId: 'lane-patch',
    workItemId: 'STW-471',
    agent: 'Patch',
    role: 'Software engineer',
    color: '#d5eeeb',
    model: 'GPT-5.4 mini',
    tier: 'Economy',
    activity: 'Implementing mobile command bar',
    detail: 'Editing navigation shell and responsive interaction tests',
    progress: 64,
    tokens: 18200,
    tokenLimit: 42000,
    cost: 0.72,
    started: '23 min ago',
    status: 'working',
    loopPhase: 'execute',
    iteration: 2,
    lastHeartbeat: '8 sec ago',
    currentAction: {
      label: 'Editing the mobile command bar',
      detail: 'Refactoring the one-thumb navigation layout after the first test pass found a 390 px overflow.',
      kind: 'file',
      target: 'src/components/navigation/MobileCommandBar.tsx',
      tool: 'Codex patch',
      elapsed: '6m 12s',
    },
    loopSteps: [
      { phase: 'Research', status: 'done', detail: 'Reproduced the overflow and traced it to the action rail.' },
      { phase: 'Plan', status: 'done', detail: 'Recorded a three-file responsive fix and regression test.' },
      { phase: 'Execute', status: 'active', detail: 'Updating the shell and mobile command bar.' },
      { phase: 'Test', status: 'queued', detail: 'Run component, accessibility, and 390 px browser checks.' },
    ],
    journal: [
      {
        id: 'journal-882-5',
        time: '8 sec ago',
        phase: 'Execute · loop 2',
        title: 'Narrow layout fix in progress',
        note: 'Moved command actions into the safe-area container and removed the fixed-width rail.',
        evidence: 'src/components/navigation/MobileCommandBar.tsx',
        tone: 'note',
      },
      {
        id: 'journal-882-4',
        time: '9 min ago',
        phase: 'Plan · loop 2',
        title: 'Regression plan recorded',
        note: 'Add 390 px and 360 px viewport coverage before rerunning the full navigation suite.',
        evidence: 'tests/e2e/mobile-navigation.spec.ts',
        tone: 'success',
      },
      {
        id: 'journal-882-3',
        time: '12 min ago',
        phase: 'Research · loop 2',
        title: 'Failure isolated',
        note: 'The command rail exceeded its parent by 20 px only when the safe-area inset was present.',
        evidence: 'Playwright trace · mobile-chrome',
        tone: 'warning',
      },
      {
        id: 'journal-882-2',
        time: '14 min ago',
        phase: 'Test · loop 1',
        title: 'Mobile browser check failed',
        note: 'Desktop and component tests passed; the 390 px viewport exposed horizontal overflow.',
        evidence: '1 failed · 43 passed',
        tone: 'warning',
      },
      {
        id: 'journal-882-1',
        time: '22 min ago',
        phase: 'Research · loop 1',
        title: 'Existing navigation mapped',
        note: 'Documented touch targets, safe-area behavior, and the five most common actions.',
        tone: 'success',
      },
    ],
    nextStep: 'Finish the layout patch, then rerun the focused mobile suite and the full regression suite.',
    controlState: 'running',
    queue: [
      {
        id: 'queue-882-1',
        laneId: 'lane-patch',
        title: 'Check keyboard-only navigation',
        desiredOutcome: 'People who do not use touch can reach the same five common actions without getting trapped.',
        expectedAgentMinutes: 30 as AgentExpectedMinutes,
        position: 'next',
        queuedAt: '6 min ago',
        queuedBy: 'Jordan Lee',
      },
    ],
    impactSummary: {
      outcome: 'Make the most-used mobile actions comfortable to reach with one hand.',
      userImpact: 'People on smaller phones should navigate without sideways scrolling or awkward stretches.',
      plainStatus: 'The first version revealed a narrow-screen layout problem. Patch is correcting it now and will repeat the mobile checks.',
      nextMilestone: 'The improved navigation passes small-screen and accessibility checks, then moves to manager review.',
      refreshedAt: '8 sec ago',
      model: 'GPT-5.4 mini observer',
      sourceUpdates: 5,
      confidence: 'high',
      revision: 5,
      revisionId: 'impact-run-882-r5',
      sourceThroughSequence: 105,
      freshness: 'current',
      changeSummary: 'Recorded the failed mobile check and the corrective second loop.',
      generatedBy: 'Impact observer',
      sourceRefs: ['STW-471', 'journal-882-5'],
    },
  },
  {
    id: 'RUN-879',
    agentLaneId: 'lane-vale',
    workItemId: 'STW-479',
    agent: 'Vale',
    role: 'Engineering manager',
    color: '#e4e7ea',
    model: 'Claude Sonnet 5',
    tier: 'Balanced',
    activity: 'Reviewing recovery state machine',
    detail: 'Fresh context · journal, diff, and test evidence loaded',
    progress: 58,
    tokens: 31800,
    tokenLimit: 60000,
    cost: 1.46,
    started: '16 min ago',
    status: 'checking',
    loopPhase: 'manager_review',
    iteration: 2,
    lastHeartbeat: '17 sec ago',
    currentAction: {
      label: 'Reviewing recovery state transitions',
      detail: 'Comparing the final diff with acceptance criteria and the engineer\'s two-loop evidence journal.',
      kind: 'review',
      target: 'src/imports/recovery-machine.ts',
      tool: 'Diff + test evidence',
      elapsed: '4m 38s',
    },
    loopSteps: [
      { phase: 'Research', status: 'done', detail: 'Failure modes and customer outcomes documented.' },
      { phase: 'Plan', status: 'done', detail: 'Recovery-state change set bounded to four files.' },
      { phase: 'Execute', status: 'done', detail: 'Resume and safe-restart paths implemented.' },
      { phase: 'Test', status: 'done', detail: '108 deterministic checks pass on the candidate.' },
    ],
    journal: [
      {
        id: 'journal-879-3',
        time: '17 sec ago',
        phase: 'Manager review',
        title: 'State invariants checked',
        note: 'Confirmed completed import steps cannot be applied twice and cancellation remains reversible.',
        evidence: 'recovery-machine.ts · lines changed 118',
        tone: 'success',
      },
      {
        id: 'journal-879-2',
        time: '5 min ago',
        phase: 'Manager review',
        title: 'Product ambiguity escalated',
        note: 'Both partial-import retry behaviors are technically valid; asked the human owner to choose the customer experience.',
        evidence: 'APR-021',
        tone: 'warning',
      },
      {
        id: 'journal-879-1',
        time: '13 min ago',
        phase: 'Manager review',
        title: 'Engineer evidence accepted',
        note: 'Read the progress journal, final diff, focused fixtures, and full-suite results from two loops.',
        evidence: '108 passed · 0 failed',
        tone: 'success',
      },
    ],
    nextStep: 'Record the human product decision, finish the review, and either return changes or post a human production-check task.',
    controlState: 'running',
    queue: [],
    impactSummary: {
      outcome: 'Let customers recover an interrupted workspace import without starting over unnecessarily.',
      userImpact: 'Customers should spend less time repeating uploads or asking support to repair an incomplete import.',
      plainStatus: 'The recovery behavior works and passed its checks. Vale is reviewing the customer-facing tradeoff before handing it to a person.',
      nextMilestone: 'A human chooses the preferred retry experience, then the manager completes the release assessment.',
      refreshedAt: '17 sec ago',
      model: 'Claude Haiku 4.5 observer',
      sourceUpdates: 3,
      confidence: 'medium',
      revision: 3,
      revisionId: 'impact-run-879-r3',
      sourceThroughSequence: 203,
      freshness: 'current',
      changeSummary: 'Raised the customer-facing recovery decision for human input.',
      generatedBy: 'Impact observer',
      sourceRefs: ['STW-479', 'APR-021'],
    },
  },
  {
    id: 'RUN-880',
    agentLaneId: 'lane-gauge',
    workItemId: 'STW-479',
    agent: 'Gauge',
    role: 'Verification engineer',
    color: '#dce9ef',
    model: 'GPT-5.4 mini',
    tier: 'Economy',
    activity: 'Running recovery fixtures',
    detail: '92 / 108 deterministic checks complete',
    progress: 85,
    tokens: 9400,
    tokenLimit: 28000,
    cost: 0.31,
    started: '12 min ago',
    status: 'checking',
    loopPhase: 'test',
    iteration: 2,
    lastHeartbeat: '4 sec ago',
    currentAction: {
      label: 'Running interrupted-import fixtures',
      detail: 'Exercising resume, cancel, and duplicate-event cases against the final candidate.',
      kind: 'command',
      target: 'pnpm vitest run src/imports/recovery-machine.test.ts',
      tool: 'Terminal · Vitest',
      elapsed: '2m 07s',
    },
    loopSteps: [
      { phase: 'Research', status: 'done', detail: 'Mapped failure cases from production-like fixtures.' },
      { phase: 'Plan', status: 'done', detail: 'Defined 108 deterministic recovery assertions.' },
      { phase: 'Execute', status: 'done', detail: 'Prepared fixtures without changing application code.' },
      { phase: 'Test', status: 'active', detail: '92 of 108 recovery checks complete.' },
    ],
    journal: [
      {
        id: 'journal-880-3',
        time: '4 sec ago',
        phase: 'Test · loop 2',
        title: 'Focused fixtures are running',
        note: 'Resume and cancel cases pass; duplicate-event and timeout cases remain.',
        evidence: '92 / 108 checks complete',
        tone: 'note',
      },
      {
        id: 'journal-880-2',
        time: '7 min ago',
        phase: 'Execute · loop 2',
        title: 'Fixture corrected',
        note: 'Updated the clock fixture to model the provider timeout without touching product code.',
        evidence: 'src/imports/fixtures/provider-timeout.ts',
        tone: 'success',
      },
      {
        id: 'journal-880-1',
        time: '11 min ago',
        phase: 'Test · loop 1',
        title: 'Non-deterministic clock found',
        note: 'One timeout assertion raced the fake clock, so verification returned to research before retrying.',
        evidence: '107 passed · 1 failed',
        tone: 'warning',
      },
    ],
    nextStep: 'Complete all 108 checks, attach the result digest, and report the evidence to the engineering manager.',
    controlState: 'running',
    queue: [
      {
        id: 'queue-880-1',
        laneId: 'lane-gauge',
        title: 'Verify a slow-network recovery',
        desiredOutcome: 'Customers on unreliable connections can safely continue an import after a timeout.',
        expectedAgentMinutes: 45 as AgentExpectedMinutes,
        position: 'backlog',
        queuedAt: '3 min ago',
        queuedBy: 'Jordan Lee',
      },
    ],
    impactSummary: {
      outcome: 'Prove that interrupted imports recover safely across common failure conditions.',
      userImpact: 'Customers should keep their completed work and avoid duplicate imports when a connection drops.',
      plainStatus: 'Most recovery scenarios pass. Gauge is finishing the timeout and duplicate-event checks before reporting the result.',
      nextMilestone: 'All recovery scenarios pass with repeatable evidence that the manager can inspect.',
      refreshedAt: '4 sec ago',
      model: 'GPT-5.4 mini observer',
      sourceUpdates: 3,
      confidence: 'high',
      revision: 3,
      revisionId: 'impact-run-880-r3',
      sourceThroughSequence: 303,
      freshness: 'current',
      changeSummary: 'Captured the latest deterministic recovery-check progress.',
      generatedBy: 'Impact observer',
      sourceRefs: ['STW-479', 'journal-880-3'],
    },
  },
  {
    id: 'RUN-877',
    agentLaneId: 'lane-mira',
    workItemId: 'QUEUE-MIRA',
    agent: 'Mira',
    role: 'Engineering manager',
    color: '#e2e3ea',
    model: 'Claude Haiku 4.5',
    tier: 'Economy',
    activity: 'Available for the next mission',
    detail: 'Watching the human queue for a bounded outcome to scope',
    progress: 0,
    tokens: 1200,
    tokenLimit: 18000,
    cost: 0.03,
    started: 'Standing by',
    status: 'waiting',
    loopPhase: 'research',
    iteration: 1,
    lastHeartbeat: '21 sec ago',
    currentAction: {
      label: 'Standing by for human direction',
      detail: 'No assignment is active. Mira can accept queued work without interrupting another agent.',
      kind: 'analysis',
      tool: 'Steward work queue',
      elapsed: 'Ready',
    },
    loopSteps: [
      { phase: 'Research', status: 'queued', detail: 'Starts when a human-queued outcome is accepted.' },
      { phase: 'Plan', status: 'queued', detail: 'Scope and acceptance criteria will be written next.' },
      { phase: 'Execute', status: 'queued', detail: 'A software engineer receives the bounded work.' },
      { phase: 'Test', status: 'queued', detail: 'Evidence requirements are set before execution.' },
    ],
    journal: [
      {
        id: 'journal-877-1',
        time: '21 sec ago',
        phase: 'Queue',
        title: 'Ready for another outcome',
        note: 'No active assignment; the prior scope handoff is preserved in the audit trail.',
        tone: 'success',
      },
    ],
    nextStep: 'Accept the next human-queued outcome and begin a bounded research pass.',
    controlState: 'running',
    queue: [],
    impactSummary: {
      outcome: 'No customer outcome is assigned to Mira right now.',
      userImpact: 'Mira is available to turn the next human request into clear, reviewable work.',
      plainStatus: 'Mira is standing by. No model or development tool is currently working on a task.',
      nextMilestone: 'A human queues the next desired result, then Mira defines its scope and success criteria.',
      refreshedAt: '21 sec ago',
      model: 'Claude Haiku 4.5 observer',
      sourceUpdates: 1,
      confidence: 'high',
      revision: 1,
      revisionId: 'impact-run-877-r1',
      sourceThroughSequence: 401,
      freshness: 'current',
      changeSummary: 'Confirmed that no customer outcome is currently assigned.',
      generatedBy: 'Impact observer',
      sourceRefs: ['QUEUE-MIRA'],
    },
  },
  {
    id: 'RUN-876',
    agentLaneId: 'lane-harbor',
    workItemId: 'QUEUE-HARBOR',
    agent: 'Harbor',
    role: 'Engineering manager',
    color: '#f6dfad',
    model: 'Claude Haiku 4.5',
    tier: 'Economy',
    activity: 'Waiting for accepted release work',
    detail: 'No immutable candidate currently needs packaging',
    progress: 0,
    tokens: 900,
    tokenLimit: 16000,
    cost: 0.02,
    started: 'Standing by',
    status: 'waiting',
    loopPhase: 'manager_review',
    iteration: 1,
    lastHeartbeat: '29 sec ago',
    currentAction: {
      label: 'Monitoring the accepted-work queue',
      detail: 'Harbor has no candidate to package and cannot touch production while waiting.',
      kind: 'review',
      tool: 'Steward release queue',
      elapsed: 'Ready',
    },
    loopSteps: [
      { phase: 'Research', status: 'queued', detail: 'Await an accepted engineering outcome.' },
      { phase: 'Plan', status: 'queued', detail: 'Prepare an evidence and rollback checklist.' },
      { phase: 'Execute', status: 'queued', detail: 'Package only an immutable candidate.' },
      { phase: 'Test', status: 'queued', detail: 'Confirm evidence digests before human handoff.' },
    ],
    journal: [
      {
        id: 'journal-876-1',
        time: '29 sec ago',
        phase: 'Queue',
        title: 'No release handoff waiting',
        note: 'Harbor remains idle without production credentials or deployment authority.',
        tone: 'success',
      },
    ],
    nextStep: 'Accept the next manager-approved candidate or a human-queued preparation task.',
    controlState: 'running',
    queue: [],
    impactSummary: {
      outcome: 'No release outcome is assigned to Harbor right now.',
      userImpact: 'Harbor is available to prepare a reviewed change for a clear human production decision.',
      plainStatus: 'Harbor is standing by. There is no candidate being packaged or deployed.',
      nextMilestone: 'A manager accepts completed work, then Harbor prepares its human-facing evidence packet.',
      refreshedAt: '29 sec ago',
      model: 'Claude Haiku 4.5 observer',
      sourceUpdates: 1,
      confidence: 'high',
      revision: 1,
      revisionId: 'impact-run-876-r1',
      sourceThroughSequence: 501,
      freshness: 'current',
      changeSummary: 'Confirmed that no release candidate is waiting for packaging.',
      generatedBy: 'Impact observer',
      sourceRefs: ['QUEUE-HARBOR'],
    },
  },
];

export const demoAgents: DemoAgent[] = [
  {
    id: 'agent-manager-planning',
    name: 'Mira',
    role: 'Engineering manager',
    color: '#e2e3ea',
    model: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    status: 'waiting',
    responsibility: 'Scopes human goals, assigns bounded work, and checks that each engineer has a testable delivery contract.',
    can: ['Read repositories', 'Set acceptance criteria', 'Assign engineering work'],
    cannot: ['Implement assigned work', 'Approve production', 'Access production'],
    spend: 1.26,
  },
  {
    id: 'agent-engineer',
    name: 'Patch',
    role: 'Software engineer',
    color: '#d5eeeb',
    model: 'GPT-5.4 mini',
    provider: 'OpenAI',
    status: 'active',
    responsibility: 'Owns a Research → Plan → Execute → Test loop until the task passes, journaling progress at every transition.',
    can: ['Edit development files', 'Run tools and tests', 'Publish progress entries'],
    cannot: ['Accept own work', 'Read production secrets', 'Deploy production'],
    spend: 5.84,
  },
  {
    id: 'agent-manager-review',
    name: 'Vale',
    role: 'Engineering manager',
    color: '#e4e7ea',
    model: 'Claude Sonnet 5',
    provider: 'Anthropic',
    status: 'active',
    responsibility: 'Checks completed engineering work against scope, evidence, risks, and maintainability before any human handoff.',
    can: ['Inspect diffs and journals', 'Request another loop', 'Accept manager review'],
    cannot: ['Be the reviewed engineer', 'Approve production', 'Deploy production'],
    spend: 7.12,
  },
  {
    id: 'agent-verifier',
    name: 'Gauge',
    role: 'Verification engineer',
    color: '#dce9ef',
    model: 'GPT-5.4 mini',
    provider: 'OpenAI',
    status: 'active',
    responsibility: 'Independently runs deterministic checks and records evidence for every acceptance criterion.',
    can: ['Run test suites', 'Scan artifacts', 'Block manager handoff'],
    cannot: ['Change acceptance criteria', 'Waive a failed check', 'Deploy production'],
    spend: 3.08,
  },
  {
    id: 'agent-manager-release',
    name: 'Harbor',
    role: 'Engineering manager',
    color: '#f6dfad',
    model: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    status: 'idle',
    responsibility: 'Posts a human production-check task only after an independent manager accepts the immutable candidate.',
    can: ['Package immutable evidence', 'Post human check tasks', 'Prepare rollback plans'],
    cannot: ['Modify an accepted candidate', 'Approve a release', 'Hold production credentials'],
    spend: 1.48,
  },
];

export const initialAudit: AuditItem[] = [
  {
    id: 'evt-1',
    actor: 'Vale',
    actorType: 'agent',
    action: 'posted a human production-check task',
    target: 'STW-482 · 7f83b16',
    detail: 'Manager review accepted; APR-019 is bound to build sha256:bbbb…bbbb and all matching evidence digests.',
    time: '11 min ago',
    tone: 'amber',
  },
  {
    id: 'evt-2',
    actor: 'Vale',
    actorType: 'agent',
    action: 'accepted engineering work as manager',
    target: 'STW-482',
    detail: 'Reviewed 14 files and two engineer loops; all four required gates passed. Production remains locked pending a human.',
    time: '13 min ago',
    tone: 'green',
  },
  {
    id: 'evt-3',
    actor: 'Gauge',
    actorType: 'agent',
    action: 'journaled a blocked verification step',
    target: 'STW-479',
    detail: 'Stopped before choosing partial-import retry semantics and attached both valid options to APR-021.',
    time: '1 hr ago',
    tone: 'amber',
  },
  {
    id: 'evt-4',
    actor: 'Jordan Lee',
    actorType: 'human',
    action: 'recorded release authorization',
    target: 'STW-465 · 14ab201',
    detail: 'Browser-local demo recorded one-time approval consumption; no artifact was deployed.',
    time: 'Yesterday · 4:42 PM',
    tone: 'green',
  },
  {
    id: 'evt-5',
    actor: 'Policy engine',
    actorType: 'system',
    action: 'simulated blocked agent deployment attempt',
    target: 'STW-465',
    detail: 'Demo policy rejected a software engineer identity without deploy_production capability. No command executed.',
    time: 'Yesterday · 4:36 PM',
    tone: 'red',
  },
];
