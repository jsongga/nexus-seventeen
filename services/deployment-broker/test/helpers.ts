import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentBrokerOptions } from "../src/config.js";
import type {
  ConsumeGrantRequest,
  CreateGrantRequest,
  RegisterManagerHandoffRequest,
} from "../src/types.js";

export const HUMAN_TOKEN = "human-reviewer-token-0123456789-abcdef";
export const HANDOFF_ISSUER_TOKEN = "manager-handoff-service-0123456789-abcdef";
export const EXECUTOR_TOKEN = "external-deployer-token-0123456789-abcdef";
export const AGENT_TOKEN = "untrusted-agent-token-0123456789-abcdef";
export const DIGEST = `sha256:${"a".repeat(64)}`;
export const MANIFEST_DIGEST = `sha256:${"d".repeat(64)}`;
export const UNREGISTERED_HANDOFF_ID = "11111111-1111-4111-8111-111111111111";

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steward-deployment-broker-"));
}

export function createRequest(overrides: Partial<CreateGrantRequest> = {}): CreateGrantRequest {
  return {
    workspaceId: "workspace-one",
    taskId: "task-one",
    releaseArtifactDigest: DIGEST,
    releaseManifestDigest: MANIFEST_DIGEST,
    targetEnvironment: "production-us",
    handoffId: UNREGISTERED_HANDOFF_ID,
    expiresInSeconds: 60,
    ...overrides,
  };
}

export function handoffRequest(
  overrides: Partial<RegisterManagerHandoffRequest> = {},
): RegisterManagerHandoffRequest {
  return {
    workspaceId: "workspace-one",
    taskId: "task-one",
    releaseArtifactDigest: DIGEST,
    releaseManifestDigest: MANIFEST_DIGEST,
    targetEnvironment: "production-us",
    managerAgentId: "manager-agent-one",
    managerReviewId: "manager-review-one",
    reviewedAt: "2026-07-18T19:59:00.000Z",
    ...overrides,
  };
}

export function consumeRequest(overrides: Partial<ConsumeGrantRequest> = {}): ConsumeGrantRequest {
  const request = createRequest();
  return {
    workspaceId: request.workspaceId,
    taskId: request.taskId,
    releaseArtifactDigest: request.releaseArtifactDigest,
    releaseManifestDigest: request.releaseManifestDigest,
    targetEnvironment: request.targetEnvironment,
    ...overrides,
  };
}

export function options(
  root: string,
  now: () => Date = () => new Date("2026-07-18T20:00:00.000Z"),
): DeploymentBrokerOptions {
  return {
    storePath: join(root, "private", "deployment-grants.jsonl"),
    humanToken: HUMAN_TOKEN,
    handoffIssuerToken: HANDOFF_ISSUER_TOKEN,
    executorToken: EXECUTOR_TOKEN,
    humanPrincipal: "reviewer:alice",
    handoffIssuerPrincipal: "service:manager-handoff",
    executorPrincipal: "deployer:release-service",
    targetEnvironments: ["production-us", "production-eu"],
    now,
  };
}
