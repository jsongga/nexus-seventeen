import type {
  ManagerReviewPermitConsumeReceipt,
  ManagerReviewPermitConsumeRequest,
} from "@cicada/steward-protocol";

export const MANAGER_REVIEW_API_VERSION = 1 as const;
export const MANAGER_REVIEW_AUTHORIZATION_VERSION = 2 as const;

export interface FixedManagerIdentity {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly laneId: string;
  readonly role: "manager";
}

export interface ManagerCredential extends FixedManagerIdentity {
  readonly token: string;
}

/**
 * The control-plane runtime generation that is attempting manager work.
 * Credentials identify a fixed lane; these fields fence replaced processes.
 */
export interface ManagerRuntimeClaim extends FixedManagerIdentity {
  readonly runtimeInstanceId: string;
  readonly runtimeEpoch: number;
}

/** Authorizes read-only queue discovery against the current manager runtime. */
export interface ManagerRuntimeAuthorizer {
  authorizeManagerRuntime(claim: ManagerRuntimeClaim): Promise<void>;
}

/** Atomically consumes control-plane authority for one manager review write. */
export interface ManagerReviewPermitConsumer {
  consumeManagerReviewPermit(
    request: ManagerReviewPermitConsumeRequest,
  ): Promise<ManagerReviewPermitConsumeReceipt>;
}

/**
 * Honest boundaries of queue discovery. Review writes do not rely on this
 * snapshot: they consume a task-scoped permit in the control plane.
 */
export const MANAGER_RUNTIME_FENCE_LIMITATIONS = Object.freeze({
  queueDiscoveryAtomicWithWrite: false,
  queueDiscoveryBindsTask: false,
  reviewWriteOrderedWithControls: true,
  reviewWriteBindsExactTask: true,
  queueDiscovery:
    "Queue membership and runtime state can change immediately after the read-only snapshot.",
  reviewWriteAuthority:
    "Each review write consumes a task-scoped permit ordered with control-plane hold, interrupt, and replacement.",
} as const);

export interface PassingEngineerEvidenceRequest {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly completionEventId: string;
  readonly engineerAgentId: string;
  readonly engineerLaneId: string;
  readonly checkpointRef: string | null;
  readonly resultOverview: string;
  readonly testOutcome: "passed";
  readonly testEvidenceDigest: string;
  readonly releaseArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly targetEnvironment: string;
  readonly completedAt: string;
}

export interface PassingEngineerEvidence extends PassingEngineerEvidenceRequest {
  readonly apiVersion: typeof MANAGER_REVIEW_API_VERSION;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly registeredBy: string;
  readonly registeredAt: string;
}

export type ManagerReviewDecision = "accepted" | "changes_requested";

export interface RecordManagerReviewRequest {
  readonly reviewTaskId: string;
  readonly evidenceDigest: string;
  readonly decision: ManagerReviewDecision;
  readonly summary: string;
  readonly remainingRisks: string;
}

export interface ManagerReview {
  readonly apiVersion: typeof MANAGER_REVIEW_API_VERSION;
  readonly authorizationVersion: typeof MANAGER_REVIEW_AUTHORIZATION_VERSION;
  readonly managerReviewId: string;
  readonly reviewTaskId: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly engineerAgentId: string;
  readonly managerAgentId: string;
  readonly managerLaneId: string;
  readonly managerRuntimeInstanceId: string;
  readonly managerRuntimeEpoch: number;
  readonly permitId: string;
  readonly authorizedAt: string;
  readonly workspaceSequence: number;
  readonly decision: ManagerReviewDecision;
  readonly summary: string;
  readonly remainingRisks: string;
  readonly reviewedAt: string;
}

/**
 * The local write-ahead record for a review permit operation. It is durable
 * before the control plane is contacted so a lost response or process crash
 * can resume the same operation without inventing new authority.
 */
export interface ManagerReviewIntent {
  readonly apiVersion: typeof MANAGER_REVIEW_API_VERSION;
  readonly reviewIntentId: string;
  readonly workspaceId: string;
  readonly evidenceId: string;
  readonly managerAgentId: string;
  readonly managerLaneId: string;
  readonly initialRuntimeInstanceId: string;
  readonly initialRuntimeEpoch: number;
  readonly operationId: string;
  readonly request: RecordManagerReviewRequest;
  readonly createdAt: string;
}

/** The exact public contract accepted by the credential-isolated broker. */
export interface RegisterManagerHandoffRequest {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly releaseArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly targetEnvironment: string;
  readonly managerAgentId: string;
  readonly managerReviewId: string;
  readonly reviewedAt: string;
}

export interface RegisteredManagerHandoff extends RegisterManagerHandoffRequest {
  readonly apiVersion: 3;
  readonly handoffId: string;
  readonly status: "accepted";
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

export interface RegisterManagerHandoffResult {
  readonly handoff: RegisteredManagerHandoff;
  readonly duplicate: boolean;
}

export interface ManagerHandoffRegistrar {
  registerManagerHandoff(
    request: RegisterManagerHandoffRequest,
    idempotencyKey: string,
  ): Promise<RegisterManagerHandoffResult>;
}

export interface ProductionCheck {
  readonly apiVersion: typeof MANAGER_REVIEW_API_VERSION;
  readonly productionCheckId: string;
  readonly status: "handoff_registration_pending" | "pending_human_review";
  readonly workspaceId: string;
  readonly taskId: string;
  readonly reviewTaskId: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly completionEventId: string;
  readonly checkpointRef: string | null;
  readonly engineerAgentId: string;
  readonly managerAgentId: string;
  readonly managerRuntimeInstanceId: string;
  readonly managerRuntimeEpoch: number;
  readonly managerReviewId: string;
  readonly permitId: string;
  readonly permitWorkspaceSequence: number;
  readonly resultOverview: string;
  readonly reviewSummary: string;
  readonly remainingRisks: string;
  readonly testEvidenceDigest: string;
  readonly releaseArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly targetEnvironment: string;
  readonly completedAt: string;
  readonly reviewedAt: string;
  readonly handoffId: string | null;
  readonly handoffRegisteredAt: string | null;
}

export interface EngineerFeedback {
  readonly apiVersion: typeof MANAGER_REVIEW_API_VERSION;
  readonly feedbackId: string;
  readonly status: "changes_requested";
  readonly workspaceId: string;
  readonly taskId: string;
  readonly reviewTaskId: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly completionEventId: string;
  readonly checkpointRef: string | null;
  readonly engineerAgentId: string;
  readonly engineerLaneId: string;
  readonly managerAgentId: string;
  readonly managerRuntimeInstanceId: string;
  readonly managerRuntimeEpoch: number;
  readonly managerReviewId: string;
  readonly permitId: string;
  readonly permitWorkspaceSequence: number;
  readonly resultOverview: string;
  readonly reviewSummary: string;
  readonly remainingRisks: string;
  readonly completedAt: string;
  readonly reviewedAt: string;
}

export interface RegisterEvidenceResult {
  readonly evidence: PassingEngineerEvidence;
  readonly duplicate: boolean;
}

export interface RecordManagerReviewResult {
  readonly review: ManagerReview;
  readonly productionCheck: ProductionCheck | null;
  readonly duplicate: boolean;
}

interface StoredEventBase {
  readonly storeVersion: 1;
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previousHash: string;
  readonly contentHash: string;
}

export interface EvidenceRegisteredEvent extends StoredEventBase {
  readonly eventType: "evidence_registered";
  readonly evidence: PassingEngineerEvidence;
}

export interface ManagerReviewRecordedEvent extends StoredEventBase {
  readonly eventType: "manager_review_recorded";
  readonly review: ManagerReview;
}

export interface ManagerReviewIntentRecordedEvent extends StoredEventBase {
  readonly eventType: "manager_review_intent_recorded";
  readonly intent: ManagerReviewIntent;
}

export interface HandoffRegisteredEvent extends StoredEventBase {
  readonly eventType: "handoff_registered";
  readonly managerReviewId: string;
  readonly handoff: RegisteredManagerHandoff;
}

export type StoredEvent =
  | EvidenceRegisteredEvent
  | ManagerReviewIntentRecordedEvent
  | ManagerReviewRecordedEvent
  | HandoffRegisteredEvent;

export type EventDraft =
  | Omit<EvidenceRegisteredEvent, "storeVersion" | "sequence" | "previousHash" | "contentHash">
  | Omit<ManagerReviewIntentRecordedEvent, "storeVersion" | "sequence" | "previousHash" | "contentHash">
  | Omit<ManagerReviewRecordedEvent, "storeVersion" | "sequence" | "previousHash" | "contentHash">
  | Omit<HandoffRegisteredEvent, "storeVersion" | "sequence" | "previousHash" | "contentHash">;
