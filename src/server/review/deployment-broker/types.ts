export const DEPLOYMENT_BROKER_API_VERSION = 3 as const;

export interface GrantBinding {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly releaseArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly targetEnvironment: string;
}

export interface RegisterManagerHandoffRequest extends GrantBinding {
  readonly managerAgentId: string;
  readonly managerReviewId: string;
  readonly reviewedAt: string;
}

export interface ManagerHandoff extends RegisterManagerHandoffRequest {
  readonly apiVersion: typeof DEPLOYMENT_BROKER_API_VERSION;
  readonly handoffId: string;
  readonly status: "accepted";
  readonly acceptedBy: string;
  readonly acceptedAt: string;
}

export interface CreateGrantRequest extends GrantBinding {
  readonly handoffId: string;
  readonly expiresInSeconds: number;
}

export type ConsumeGrantRequest = GrantBinding;

export interface DeploymentGrant extends GrantBinding {
  readonly apiVersion: typeof DEPLOYMENT_BROKER_API_VERSION;
  readonly grantId: string;
  readonly handoffId: string;
  readonly issuedBy: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * A durable proof that the exact grant was claimed once. The external deployment
 * executor owns production credentials and must deduplicate authorizationId.
 */
export interface DeploymentAuthorization extends GrantBinding {
  readonly apiVersion: typeof DEPLOYMENT_BROKER_API_VERSION;
  readonly authorizationId: string;
  readonly grantId: string;
  readonly handoffId: string;
  readonly issuedBy: string;
  readonly claimedBy: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string;
}

export interface CreateGrantResult {
  readonly grant: DeploymentGrant;
  readonly duplicate: boolean;
}

export interface RegisterManagerHandoffResult {
  readonly handoff: ManagerHandoff;
  readonly duplicate: boolean;
}

export interface ConsumeGrantResult {
  readonly authorization: DeploymentAuthorization;
  readonly duplicate: boolean;
}

export type StoredEvent = ManagerHandoffRegisteredEvent | GrantCreatedEvent | GrantConsumedEvent;

interface StoredEventBase {
  readonly storeVersion: 3;
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: "manager_handoff_registered" | "grant_created" | "grant_consumed";
  readonly occurredAt: string;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly contentHash: string;
}

export interface ManagerHandoffRegisteredEvent extends StoredEventBase {
  readonly eventType: "manager_handoff_registered";
  readonly handoff: ManagerHandoff;
}

export interface GrantCreatedEvent extends StoredEventBase {
  readonly eventType: "grant_created";
  readonly grant: DeploymentGrant;
}

export interface GrantConsumedEvent extends StoredEventBase {
  readonly eventType: "grant_consumed";
  readonly authorization: DeploymentAuthorization;
}

interface EventDraftBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ManagerHandoffRegisteredEventDraft extends EventDraftBase {
  readonly eventType: "manager_handoff_registered";
  readonly handoff: ManagerHandoff;
}

export interface GrantCreatedEventDraft extends EventDraftBase {
  readonly eventType: "grant_created";
  readonly grant: DeploymentGrant;
}

export interface GrantConsumedEventDraft extends EventDraftBase {
  readonly eventType: "grant_consumed";
  readonly authorization: DeploymentAuthorization;
}

export type EventDraft = ManagerHandoffRegisteredEventDraft | GrantCreatedEventDraft | GrantConsumedEventDraft;
