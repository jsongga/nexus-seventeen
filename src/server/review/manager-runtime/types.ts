import type {
  AgentTaskProjection,
  DurableOutboxEvent,
  LeaseRenewalRequest,
  LeaseRenewalResult,
  RuntimeCommandPollRequest,
  RuntimeCommandPollResult,
  RuntimeEventBatch,
  RuntimeEventBatchReceipt,
  Sha256Digest,
  SupervisorRegistrationRequest,
  SupervisorRegistrationResult,
} from "#shared/protocol";

export interface ManagerRuntimeControlClient {
  register(
    request: SupervisorRegistrationRequest,
    context: Readonly<{ runtimeProofChallenge: string; replacementProof: string | null }>,
    signal?: AbortSignal,
  ): Promise<ManagerRegistrationSession>;
  renewLease(request: LeaseRenewalRequest, signal?: AbortSignal): Promise<LeaseRenewalResult>;
  pollCommands(request: RuntimeCommandPollRequest, signal?: AbortSignal): Promise<RuntimeCommandPollResult>;
  uploadEvents(request: RuntimeEventBatch, signal?: AbortSignal): Promise<RuntimeEventBatchReceipt>;
}

export type ManagerRegistrationSession = SupervisorRegistrationResult & Readonly<{
  runtimeGenerationProof: string;
}>;

export interface ManagerRuntimeClaim {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly laneId: string;
  readonly runtimeInstanceId: string;
  readonly runtimeEpoch: number;
  readonly runtimeGenerationProof: string;
}

export interface PassingEngineerEvidence {
  readonly apiVersion: 1;
  readonly evidenceId: string;
  readonly evidenceDigest: Sha256Digest;
  readonly registeredBy: string;
  readonly registeredAt: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly completionEventId: string;
  readonly engineerAgentId: string;
  readonly engineerLaneId: string;
  readonly checkpointRef: string | null;
  readonly resultOverview: string;
  readonly testOutcome: "passed";
  readonly testEvidenceDigest: Sha256Digest;
  readonly releaseArtifactDigest: Sha256Digest;
  readonly releaseManifestDigest: Sha256Digest;
  readonly targetEnvironment: string;
  readonly completedAt: string;
}

export type ManagerDecision = "accepted" | "changes_requested";

export interface ManagerReviewRequest {
  readonly reviewTaskId: string;
  readonly evidenceDigest: Sha256Digest;
  readonly decision: ManagerDecision;
  readonly summary: string;
  readonly remainingRisks: string;
}

export interface ManagerReviewReceipt {
  readonly managerReviewId: string;
  readonly reviewTaskId: string;
  readonly evidenceId: string;
  readonly evidenceDigest: Sha256Digest;
  readonly decision: ManagerDecision;
  readonly managerRuntimeInstanceId: string;
  readonly managerRuntimeEpoch: number;
  readonly duplicate: boolean;
}

export interface ManagerReviewClient {
  listQueue(claim: ManagerRuntimeClaim, signal?: AbortSignal): Promise<readonly PassingEngineerEvidence[]>;
  recordReview(
    claim: ManagerRuntimeClaim,
    evidenceId: string,
    request: ManagerReviewRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ManagerReviewReceipt>;
}

export interface EvidenceInspectionRequest {
  readonly task: AgentTaskProjection;
  readonly evidence: PassingEngineerEvidence;
  readonly iteration: number;
}

export interface EvidenceInspectionResult {
  readonly state: "accepted" | "changes_requested" | "continue";
  readonly evidenceDigest: Sha256Digest;
  readonly testEvidenceDigest: Sha256Digest;
  readonly releaseArtifactDigest: Sha256Digest;
  readonly releaseManifestDigest: Sha256Digest;
  readonly summary: string;
  readonly remainingRisks: string;
}

/** This interface deliberately exposes no write or command execution method. */
export interface ReadOnlyManagerInspector {
  inspect(request: EvidenceInspectionRequest, signal?: AbortSignal): Promise<EvidenceInspectionResult>;
}

export interface ManagerRuntimeIdentity {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly laneId: string;
  readonly runtimeInstanceId: string;
  readonly displayName: string;
  readonly provider: Readonly<{ name: "codex" | "claude"; model: string }>;
  readonly softwareVersion: string;
}

export interface ManagerRuntimeOptions {
  readonly identity: ManagerRuntimeIdentity;
  readonly statePath: string;
  readonly control: ManagerRuntimeControlClient;
  readonly reviews: ManagerReviewClient;
  readonly inspector: ReadOnlyManagerInspector;
  readonly maxReviewIterations?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type ManagerDesiredState = "active" | "held" | "paused";
export type ManagerWorkPhase = "locate" | "inspect" | "submit";

export interface StoredDecision {
  readonly decision: ManagerDecision;
  readonly summary: string;
  readonly remainingRisks: string;
}

export interface ActiveManagerReview {
  readonly task: AgentTaskProjection;
  readonly phase: ManagerWorkPhase;
  readonly iteration: number;
  readonly evidence: PassingEngineerEvidence | null;
  readonly decision: StoredDecision | null;
  readonly progressMode: "emit" | "suppress";
}

export interface ManagerRuntimeLease {
  readonly leaseId: string;
  readonly leaseGrantedAt: string;
  readonly leaseExpiresAt: string;
}

export interface ManagerRuntimeState {
  readonly version: 1;
  readonly identity: Pick<ManagerRuntimeIdentity, "workspaceId" | "agentId" | "laneId" | "runtimeInstanceId">;
  readonly runtimeEpoch: number;
  readonly runtimeGenerationProof: string | null;
  readonly registrationIntent: Readonly<{
    readonly request: SupervisorRegistrationRequest;
    readonly runtimeProofChallenge: string;
  }> | null;
  readonly lease: ManagerRuntimeLease | null;
  readonly lastServerSequence: number;
  readonly nextLocalSequence: number;
  readonly desiredState: ManagerDesiredState;
  readonly queue: readonly AgentTaskProjection[];
  readonly active: ActiveManagerReview | null;
  readonly currentAction: Readonly<{ taskId: string; summary: string; startedAt: string }> | null;
  readonly pendingEvents: readonly DurableOutboxEvent[];
}
