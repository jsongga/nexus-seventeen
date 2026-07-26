import {
  STEWARD_RUNTIME_API_VERSION,
  parseAgentTaskProjection,
  parseLeaseRenewalResult,
  parseRuntimeCommandEnvelope,
  parseRuntimeCommandPollResult,
  parseRuntimeEventBatch,
  parseRuntimeEventBatchReceipt,
  parseSupervisorRegistrationRequest,
  parseSupervisorRegistrationResult,
  type AgentTaskProjection,
  type AgentRole,
  type LeaseRenewalRequest,
  type RuntimeCommandEnvelope,
  type RuntimeCommandPayload,
  type RuntimeCommandPollRequest,
  type RuntimeEventBatch,
  type SupervisorRegistrationRequest,
} from "#shared/protocol";
import type { SupervisorControlPlaneClient } from "#server/agents/supervisor/client";
import { parseSupervisorConfig, type SupervisorConfig } from "#server/agents/supervisor/config";

export const FORECAST_MINUTES = 15;
export const FORECAST_COMPLETES_AT = "2026-07-18T20:15:00.000Z";

export function registrationIdentity(expectedRuntimeEpoch: number | null = null): SupervisorRegistrationRequest {
  return parseSupervisorRegistrationRequest({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: "workspace-test",
    agentId: "agent-test",
    laneId: "lane-test",
    runtimeInstanceId: "runtime-test",
    expectedRuntimeEpoch,
    displayName: "Test engineer",
    role: "engineer",
    capabilities: ["research", "plan", "modify_workspace", "run_tests"],
    provider: { name: "codex", model: "fake-test-model" },
    softwareVersion: "0.1.0",
    checkpointRef: null,
  });
}

export function taskFixture(taskId = "task-one"): AgentTaskProjection {
  return parseAgentTaskProjection({
    taskId,
    workspaceId: "workspace-test",
    agentId: "agent-test",
    laneId: "lane-test",
    subject: { type: "development" },
    title: `Deliver ${taskId}`,
    objective: "Produce a user-visible result and verify it.",
    status: "queued",
    expectedAgentMinutes: FORECAST_MINUTES,
    expectedCompletedAt: FORECAST_COMPLETES_AT,
    startedAt: null,
    endedAt: null,
  });
}

export function configFixture(
  root: string,
  options: { runtimeInstanceId?: string; role?: Exclude<AgentRole, "impact_observer"> } = {},
): SupervisorConfig {
  const role = options.role ?? "engineer";
  return parseSupervisorConfig({
    controlPlaneUrl: "https://control.example.test",
    supervisorToken: "test-supervisor-token-0001",
    workspaceId: "workspace-test",
    agentId: "agent-test",
    laneId: "lane-test",
    runtimeInstanceId: options.runtimeInstanceId ?? "runtime-test",
    displayName: `Test ${role}`,
    role,
    provider: { name: "codex", model: "fake-test-model" },
    softwareVersion: "0.1.0",
    workingDirectory: `${root}/workspace/project`,
    stateDirectory: `${root}/state/supervisor`,
    leaseIntervalMs: 1_000,
  });
}

export class FakeControlPlane implements SupervisorControlPlaneClient {
  available = true;
  loseNextUploadResponse = false;
  loseNextRegistrationResponse = false;
  registrationCalls = 0;
  uploadCalls = 0;
  pollCalls = 0;
  latestServerSequence = 0;
  acceptedThrough = 0;
  readonly commands: RuntimeCommandEnvelope[] = [];
  readonly receivedBatches: RuntimeEventBatch[] = [];
  readonly leaseRequests: LeaseRenewalRequest[] = [];
  readonly storedEvents = new Map<string, string>();
  readonly registrationRequests: SupervisorRegistrationRequest[] = [];
  readonly #registrations = new Map<string, { serialized: string; result: ReturnType<typeof parseSupervisorRegistrationResult> }>();
  #runtimeEpoch: number;

  constructor(initialRuntimeEpoch = 0) {
    this.#runtimeEpoch = initialRuntimeEpoch;
  }

  enqueue(payload: RuntimeCommandPayload, expectedRuntimeEpoch: number): RuntimeCommandEnvelope {
    this.latestServerSequence += 1;
    const command = parseRuntimeCommandEnvelope({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      commandId: `command-${this.latestServerSequence}`,
      workspaceId: "workspace-test",
      agentId: "agent-test",
      laneId: "lane-test",
      serverSequence: this.latestServerSequence,
      expectedRuntimeEpoch,
      issuedAt: new Date().toISOString(),
      payload,
    });
    this.commands.push(command);
    return command;
  }

  async register(request: SupervisorRegistrationRequest) {
    this.#assertAvailable();
    this.registrationCalls += 1;
    this.registrationRequests.push(request);
    const serialized = JSON.stringify(request);
    const existing = this.#registrations.get(request.runtimeInstanceId);
    if (existing) {
      if (existing.serialized !== serialized) throw new Error("runtime instance registration changed across retry");
      return existing.result;
    }
    const expected = this.#runtimeEpoch === 0 ? null : this.#runtimeEpoch;
    if (request.expectedRuntimeEpoch !== expected) throw new Error("registration CAS conflict");
    this.#runtimeEpoch += 1;
    const now = new Date();
    const result = parseSupervisorRegistrationResult({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      laneId: request.laneId,
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeEpoch: this.#runtimeEpoch,
      leaseId: `lease-${this.#runtimeEpoch}`,
      leaseGrantedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      lastAcceptedLocalSequence: this.acceptedThrough,
      controlVersion: 1,
    });
    this.#registrations.set(request.runtimeInstanceId, { serialized, result });
    if (this.loseNextRegistrationResponse) {
      this.loseNextRegistrationResponse = false;
      throw new Error("simulated lost registration response");
    }
    return result;
  }

  async renewLease(request: Parameters<SupervisorControlPlaneClient["renewLease"]>[0]) {
    this.#assertAvailable();
    this.leaseRequests.push(request);
    const now = new Date();
    return parseLeaseRenewalResult({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      laneId: request.laneId,
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeEpoch: request.runtimeEpoch,
      leaseId: request.leaseId,
      leaseGrantedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      acceptedThroughLocalSequence: this.acceptedThrough,
      controlVersion: 1,
    });
  }

  async uploadEvents(request: RuntimeEventBatch) {
    this.#assertAvailable();
    const batch = parseRuntimeEventBatch(request);
    this.uploadCalls += 1;
    for (const event of batch.events) {
      const serialized = JSON.stringify(event);
      const previous = this.storedEvents.get(event.eventId);
      if (previous !== undefined && previous !== serialized) {
        throw new Error(`idempotency conflict for ${event.eventId}`);
      }
      this.storedEvents.set(event.eventId, serialized);
      this.acceptedThrough = Math.max(this.acceptedThrough, event.localSequence);
    }
    this.receivedBatches.push(batch);
    if (this.loseNextUploadResponse) {
      this.loseNextUploadResponse = false;
      throw new Error("simulated lost upload response");
    }
    return parseRuntimeEventBatchReceipt({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: batch.workspaceId,
      agentId: batch.agentId,
      laneId: batch.laneId,
      runtimeInstanceId: batch.runtimeInstanceId,
      runtimeEpoch: batch.runtimeEpoch,
      acceptedThroughLocalSequence: this.acceptedThrough,
      controlVersion: 1,
    });
  }

  async pollCommands(request: RuntimeCommandPollRequest) {
    this.#assertAvailable();
    this.pollCalls += 1;
    const commands = this.commands.filter((command) => command.serverSequence > request.afterServerSequence);
    return parseRuntimeCommandPollResult({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      laneId: request.laneId,
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeEpoch: request.runtimeEpoch,
      latestServerSequence: this.latestServerSequence,
      commands,
    });
  }

  #assertAvailable(): void {
    if (!this.available) throw new Error("control plane unavailable");
  }
}
