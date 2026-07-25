declare const domainIdBrand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [domainIdBrand]: Name;
};

export type UserId = Brand<string, 'UserId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type AgentLaneId = Brand<string, 'AgentLaneId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type WorkItemId = Brand<string, 'WorkItemId'>;
export type ReleaseId = Brand<string, 'ReleaseId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type ManagerReviewId = Brand<string, 'ManagerReviewId'>;
export type ProductionCheckTaskId = Brand<string, 'ProductionCheckTaskId'>;
export type GitCommitSha = Brand<string, 'GitCommitSha'>;
export type ContentDigest = Brand<`sha256:${string}`, 'ContentDigest'>;
export type ISODateTime = Brand<string, 'ISODateTime'>;

export const userId = (value: string): UserId => value as UserId;
export const agentId = (value: string): AgentId => value as AgentId;
export const projectId = (value: string): ProjectId => value as ProjectId;
export const workItemId = (value: string): WorkItemId => value as WorkItemId;
export const releaseId = (value: string): ReleaseId => value as ReleaseId;
export const approvalId = (value: string): ApprovalId => value as ApprovalId;
export const managerReviewId = (value: string): ManagerReviewId => value as ManagerReviewId;
export const productionCheckTaskId = (value: string): ProductionCheckTaskId =>
  value as ProductionCheckTaskId;
export const gitCommitSha = (value: string): GitCommitSha => value as GitCommitSha;
export const isoDateTime = (value: string): ISODateTime => value as ISODateTime;

export function contentDigest(value: `sha256:${string}`): ContentDigest {
  if (!/^sha256:[a-f\d]{64}$/i.test(value)) {
    throw new Error('Content digests must be a sha256: prefix followed by 64 hexadecimal characters.');
  }

  return value as ContentDigest;
}

export type AgentRole = 'manager' | 'engineer' | 'verifier';

export type HumanRole = 'human_approver';
export type RoleKey = AgentRole | HumanRole;
export type PrincipalKind = 'agent' | 'human' | 'service';

export type Capability =
  | 'project.read'
  | 'agent.work.queue'
  | 'agent.run.interrupt'
  | 'agent.run.resume'
  | 'task.plan'
  | 'task.assign'
  | 'task.comment'
  | 'repository.read'
  | 'repository.write'
  | 'command.execute'
  | 'dependency.install'
  | 'network.development'
  | 'preview.launch'
  | 'test.run'
  | 'artifact.create'
  | 'artifact.review'
  | 'release.assemble'
  | 'production.request_approval'
  | 'production.approve'
  | 'production.consume_approval'
  | 'production.deploy';

export interface RoleTemplate {
  readonly key: RoleKey;
  readonly title: string;
  readonly summary: string;
  readonly principalKind: Exclude<PrincipalKind, 'service'>;
  readonly fixed: true;
  readonly capabilities: readonly Capability[];
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type WorkItemState =
  | 'draft'
  | 'awaiting_scope_approval'
  | 'ready'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'changes_requested'
  | 'awaiting_promotion_approval'
  | 'merged'
  | 'release_candidate'
  | 'awaiting_production_approval'
  | 'deploying'
  | 'deployed'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'canceled';

export interface AgentProfile {
  readonly id: AgentId;
  readonly name: string;
  readonly role: AgentRole;
  readonly providerPreference: ModelProvider | 'auto';
  readonly status: 'idle' | 'working' | 'paused';
  readonly monthlyTokenBudget: number;
  readonly avatarInitials: string;
}

export interface HumanActor {
  readonly kind: 'human';
  readonly id: UserId;
  readonly name: string;
  readonly role: HumanRole;
  readonly authenticated: boolean;
}

export interface AgentActor {
  readonly kind: 'agent';
  readonly id: AgentId;
  readonly name: string;
  readonly role: AgentRole;
}

export interface ServiceActor {
  readonly kind: 'service';
  readonly id: 'deployment-broker' | 'orchestration-worker' | 'impact-observer';
  readonly name: string;
}

export type Principal = HumanActor | AgentActor | ServiceActor;

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly developmentEnvironment: string;
  readonly productionEnvironment: string;
  readonly tokenBudget: number;
}

export interface WorkItemAssignments {
  readonly manager?: AgentId;
  readonly engineer?: AgentId;
  readonly verifier?: AgentId;
}

export interface WorkItem {
  readonly id: WorkItemId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly risk: RiskLevel;
  readonly state: WorkItemState;
  readonly assignments: WorkItemAssignments;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface ReleaseDigests {
  readonly commit: GitCommitSha;
  readonly artifact: ContentDigest;
  readonly build: ContentDigest;
  readonly tests: ContentDigest;
  readonly configuration: ContentDigest;
  readonly migrations: ContentDigest;
}

export interface ReleaseCandidate {
  readonly id: ReleaseId;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly version: string;
  readonly environment: 'production';
  readonly digests: ReleaseDigests;
  readonly rollbackPlan: string;
  readonly createdBy: AgentId;
  readonly createdAt: ISODateTime;
}

export type EngineeringPhase = 'research' | 'plan' | 'execute' | 'test';
export type EngineeringLoopStage = EngineeringPhase | 'completed';
export type TestOutcome = 'passed' | 'failed';

export interface ProgressUpdate {
  readonly summary: string;
  readonly recordedAt: ISODateTime;
}

export interface ProgressJournalEntry extends ProgressUpdate {
  readonly sequence: number;
  readonly iteration: number;
  readonly from: EngineeringLoopStage | 'not_started';
  readonly to: EngineeringLoopStage;
  readonly testOutcome?: TestOutcome;
}

export interface EngineeringLoop {
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly engineerId: AgentId;
  readonly stage: EngineeringLoopStage;
  readonly iteration: number;
  readonly status: 'active' | 'completed';
  readonly journal: readonly ProgressJournalEntry[];
  readonly startedAt: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly lastTestOutcome?: TestOutcome;
}

export type ManagerReviewDecision = 'accepted' | 'changes_requested';

export interface ManagerReview {
  readonly id: ManagerReviewId;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly engineerId: AgentId;
  readonly managerId: AgentId;
  readonly loopIteration: number;
  readonly reviewedRelease: ReleaseCandidate;
  readonly decision: ManagerReviewDecision;
  readonly summary: string;
  readonly checksPerformed: readonly string[];
  readonly remainingRisks: readonly string[];
  readonly reviewedAt: ISODateTime;
}

export interface HumanProductionCheckTask {
  readonly id: ProductionCheckTaskId;
  readonly releaseId: ReleaseId;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly managerReviewId: ManagerReviewId;
  readonly managerReviewDecision: 'accepted';
  readonly boundRelease: ReleaseCandidate;
  readonly boundDigests: ReleaseDigests;
  readonly status: 'awaiting_human_check';
  readonly requestedBy: AgentId;
  readonly instructions: string;
  readonly managerReviewSummary: string;
  readonly checksPerformed: readonly string[];
  readonly remainingRisks: readonly string[];
  readonly createdAt: ISODateTime;
}

export type ApprovalStatus = 'approved' | 'consumed' | 'revoked';

export interface ProductionApproval {
  readonly id: ApprovalId;
  readonly releaseId: ReleaseId;
  readonly projectId: ProjectId;
  readonly productionCheckTaskId: ProductionCheckTaskId;
  readonly boundRelease: ReleaseCandidate;
  readonly boundDigests: ReleaseDigests;
  readonly status: ApprovalStatus;
  readonly approvedBy: UserId;
  readonly approvedAt: ISODateTime;
  readonly consumedAt?: ISODateTime;
  readonly consumedBy?: 'deployment-broker';
  readonly revokedAt?: ISODateTime;
  readonly version: number;
}

export type PolicyFailureCode =
  | 'AGENT_PRODUCTION_FORBIDDEN'
  | 'HUMAN_APPROVER_REQUIRED'
  | 'DEPLOYMENT_BROKER_REQUIRED'
  | 'APPROVAL_ALREADY_EXISTS'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'APPROVAL_REVOKED'
  | 'INVALID_APPROVAL_TIMESTAMP'
  | 'RELEASE_MISMATCH'
  | 'STALE_RELEASE'
  | 'ROLE_MISMATCH'
  | 'PROGRESS_ENTRY_REQUIRED'
  | 'INVALID_PROGRESS_TIMESTAMP'
  | 'INVALID_LOOP_TRANSITION'
  | 'TEST_RESULT_REQUIRED'
  | 'LOOP_NOT_COMPLETE'
  | 'MANAGER_SEPARATION_REQUIRED'
  | 'MANAGER_REVIEW_REQUIRED'
  | 'MANAGER_REVIEW_EVIDENCE_REQUIRED'
  | 'MANAGER_REVIEW_NOT_ACCEPTED'
  | 'MANAGER_REVIEW_MISMATCH'
  | 'PRODUCTION_CHECK_TASK_REQUIRED'
  | 'PRODUCTION_CHECK_TASK_MISMATCH'
  | 'HUMAN_RUN_CONTROL_REQUIRED'
  | 'HUMAN_AUTHENTICATION_REQUIRED'
  | 'QUEUE_ITEM_TITLE_REQUIRED'
  | 'QUEUE_ITEM_OUTCOME_REQUIRED'
  | 'AGENT_ESTIMATE_INTERVAL_REQUIRED'
  | 'INVALID_RUN_CONTROL_TIMESTAMP'
  | 'ORCHESTRATION_WORKER_REQUIRED'
  | 'INVALID_RUN_CONTROL_TRANSITION'
  | 'RUN_CONTROL_REPLAY_CONFLICT'
  | 'RUN_ATTEMPT_MISMATCH'
  | 'RUN_ATTEMPT_REUSED'
  | 'RUN_NOT_ACTIVE'
  | 'RUN_COMPLETION_EVIDENCE_REQUIRED'
  | 'RUN_RECONCILIATION_EVIDENCE_REQUIRED'
  | 'RUN_NOT_INTERRUPTED'
  | 'RUN_INTERRUPTED'
  | 'AGENT_TASK_TIMING_INVALID'
  | 'INVALID_AGENT_TASK_TRANSITION'
  | 'IMPACT_TASK_CONTEXT_REQUIRED'
  | 'IMPACT_SUMMARY_INVALID'
  | 'IMPACT_SOURCE_EVENT_INVALID'
  | 'IMPACT_GENERATION_REQUEST_REQUIRED'
  | 'IMPACT_GENERATION_LINK_MISMATCH'
  | 'IMPACT_GENERATION_ID_REUSED'
  | 'IMPACT_OBSERVER_REQUIRED'
  | 'IMPACT_BASE_REVISION_CONFLICT'
  | 'IMPACT_MODEL_PROVENANCE_INVALID'
  | 'IMPACT_GENERATION_TIMESTAMP_INVALID';

export interface PolicyAllowed<Value> {
  readonly allowed: true;
  readonly value: Value;
}

export interface PolicyDenied {
  readonly allowed: false;
  readonly code: PolicyFailureCode;
  readonly reason: string;
}

export type PolicyDecision<Value> = PolicyAllowed<Value> | PolicyDenied;

export type ModelProvider = 'openai' | 'anthropic';
export type ModelTier = 'economy' | 'balanced' | 'frontier';

export interface ModelPrice {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  readonly asOf: string;
  readonly note?: string;
}

export interface ModelProfile {
  readonly provider: ModelProvider;
  readonly tier: ModelTier;
  readonly modelId: string;
  readonly displayName: string;
  readonly price: ModelPrice;
  readonly sourceUrl: string;
}

export interface EscalationEvidence {
  readonly failedAttempts?: number;
  readonly verificationFailures?: number;
  readonly evaluatorScore?: number;
  readonly minimumEvaluatorScore?: number;
  readonly securitySensitive?: boolean;
  readonly largeDiff?: boolean;
}

export interface RouteRequest {
  readonly role: AgentRole;
  readonly risk: RiskLevel;
  readonly providerPreference?: ModelProvider | 'auto';
  readonly evidence?: EscalationEvidence;
}

export interface RouteDecision {
  readonly provider: ModelProvider;
  readonly tier: ModelTier;
  readonly model: ModelProfile;
  readonly reasons: readonly string[];
  readonly escalated: boolean;
}

export interface TokenEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly method: 'provided' | 'character_heuristic';
  readonly caveat?: string;
}

export interface CostEstimate {
  readonly model: ModelProfile;
  readonly tokens: TokenEstimate;
  readonly estimatedUsd: number;
}

export interface CostComparison {
  readonly routed: CostEstimate;
  readonly frontierBaseline: CostEstimate;
  readonly estimatedSavingsUsd: number;
  readonly estimatedSavingsPercent: number;
  readonly qualityAssessed: false;
  readonly caveat: string;
}
