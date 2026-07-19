import { resolve } from 'node:path';
import type { ControlPlaneOptions, WorkloadIdentityCredential } from './config.js';

type Environment = Readonly<Record<string, string | undefined>>;

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function workloadIdentities(environment: Environment): readonly WorkloadIdentityCredential[] {
  const encoded = environment.STEWARD_WORKLOAD_IDENTITIES_JSON;
  if (encoded === undefined || encoded.length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('STEWARD_WORKLOAD_IDENTITIES_JSON must be valid JSON');
  }
  if (!Array.isArray(value)) {
    throw new Error('STEWARD_WORKLOAD_IDENTITIES_JSON must contain an array');
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`STEWARD_WORKLOAD_IDENTITIES_JSON[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    for (const field of ['workspaceId', 'agentId', 'laneId', 'role', 'token'] as const) {
      if (typeof record[field] !== 'string') {
        throw new Error(`STEWARD_WORKLOAD_IDENTITIES_JSON[${index}].${field} must be a string`);
      }
    }
    return {
      workspaceId: record.workspaceId as string,
      agentId: record.agentId as string,
      laneId: record.laneId as string,
      role: record.role as WorkloadIdentityCredential['role'],
      token: record.token as string,
    };
  });
}

function legacyDevelopmentCredential(
  environment: Environment,
):
  | Readonly<{ developmentMode: true; legacyDevSupervisorToken: string }>
  | Readonly<{ developmentMode?: false; legacyDevSupervisorToken?: never }> {
  const enabled = environment.STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN;
  const token = environment.STEWARD_LEGACY_DEV_SUPERVISOR_TOKEN;
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new Error('STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN must be "true" or "false"');
  }
  if (token === undefined) {
    if (enabled === 'true') {
      throw new Error(
        'STEWARD_LEGACY_DEV_SUPERVISOR_TOKEN is required when the legacy credential is enabled',
      );
    }
    return {};
  }
  if (enabled !== 'true') {
    throw new Error(
      'STEWARD_LEGACY_DEV_SUPERVISOR_TOKEN requires STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN=true',
    );
  }
  if (environment.NODE_ENV !== 'development' && environment.NODE_ENV !== 'test') {
    throw new Error(
      'The legacy supervisor credential is only available when NODE_ENV is development or test',
    );
  }
  return { developmentMode: true, legacyDevSupervisorToken: token };
}

export function controlPlaneOptionsFromEnvironment(
  environment: Environment,
  workingDirectory = process.cwd(),
): ControlPlaneOptions {
  return {
    workspaceId: environment.STEWARD_WORKSPACE_ID ?? 'workspace-alpha',
    storePath: resolve(workingDirectory, environment.STEWARD_STORE_PATH ?? './data/control-plane.jsonl'),
    workloadIdentities: workloadIdentities(environment),
    ...legacyDevelopmentCredential(environment),
    humanToken: required(environment, 'STEWARD_HUMAN_TOKEN'),
    observerReadToken: required(environment, 'STEWARD_OBSERVER_READ_TOKEN'),
    managerReviewPermitToken: required(
      environment,
      'STEWARD_MANAGER_REVIEW_PERMIT_TOKEN',
    ),
    runtimeGenerationProofKey: required(
      environment,
      'STEWARD_RUNTIME_GENERATION_PROOF_KEY',
    ),
    host: environment.STEWARD_HOST ?? '127.0.0.1',
    port: Number(environment.STEWARD_PORT ?? '4317'),
    corsOrigins: (environment.STEWARD_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
