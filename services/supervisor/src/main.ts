import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { HttpSupervisorControlPlaneClient } from "./client.js";
import { loadSupervisorConfig, type SupervisorConfig } from "./config.js";
import { SupervisorDaemon } from "./daemon.js";
import {
  FakeProviderAdapter,
  RoleRestrictedProviderAdapter,
  type ProviderAdapter,
  type ProviderAdapterConfig,
} from "./provider.js";
import { SubprocessProviderAdapter } from "./subprocess-provider.js";

export function toProviderAdapterConfig(config: SupervisorConfig): ProviderAdapterConfig {
  return Object.freeze({
    providerName: config.provider.name,
    model: config.provider.model,
    role: config.role,
    workspaceId: config.workspaceId,
    agentId: config.agentId,
    laneId: config.laneId,
    workingDirectory: config.workingDirectory,
  });
}

function optionalTimeout(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = env[key]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer number of milliseconds`);
  return parsed;
}

export async function loadProviderAdapter(
  config: SupervisorConfig,
  env: NodeJS.ProcessEnv,
): Promise<ProviderAdapter> {
  const adapterConfig = toProviderAdapterConfig(config);
  if (config.role !== "engineer") {
    return new RoleRestrictedProviderAdapter(adapterConfig);
  }
  if (env.STEWARD_FAKE_PROVIDER === "true") {
    if (env.NODE_ENV !== "test") {
      throw new Error("The in-process fake provider is available only when NODE_ENV=test");
    }
    return new FakeProviderAdapter({
      providerName: config.provider.name,
      model: config.provider.model,
    });
  }
  const modulePath = env.STEWARD_PROVIDER_ADAPTER_MODULE?.trim();
  if (!modulePath || !isAbsolute(modulePath)) {
    throw new Error(
      "STEWARD_PROVIDER_ADAPTER_MODULE must name an absolute adapter module path (or set STEWARD_FAKE_PROVIDER=true for local testing)",
    );
  }
  const moduleSha256 = env.STEWARD_PROVIDER_ADAPTER_SHA256?.trim();
  if (!moduleSha256) {
    throw new Error("STEWARD_PROVIDER_ADAPTER_SHA256 is required for real provider modules");
  }
  const stepTimeoutMs = optionalTimeout(env, "STEWARD_PROVIDER_STEP_TIMEOUT_MS");
  const abortGraceMs = optionalTimeout(env, "STEWARD_PROVIDER_ABORT_GRACE_MS");
  const requestTimeoutMs = optionalTimeout(env, "STEWARD_PROVIDER_REQUEST_TIMEOUT_MS");
  return SubprocessProviderAdapter.create({
    config: adapterConfig,
    modulePath,
    moduleSha256,
    stateDirectory: config.stateDirectory,
    environment: env,
    ...(stepTimeoutMs !== undefined ? { stepTimeoutMs } : {}),
    ...(abortGraceMs !== undefined ? { abortGraceMs } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = await loadSupervisorConfig({ env });
  const provider = await loadProviderAdapter(config, env);
  const client = new HttpSupervisorControlPlaneClient({
    controlPlaneUrl: config.controlPlaneUrl,
    supervisorToken: config.supervisorToken,
  });
  const daemon = await SupervisorDaemon.create({ config, client, provider });
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    await daemon.run(stop.signal);
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Supervisor failed";
    process.stderr.write(`${message.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")}\n`);
    process.exitCode = 1;
  });
}
