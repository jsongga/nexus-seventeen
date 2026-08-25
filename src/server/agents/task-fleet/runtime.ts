import { execFile } from "node:child_process";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { defaultRuntimeRegistry, type RuntimeRegistry } from "../runtime/registry.js";
import {
  ContainedCliAgentLauncher,
  HttpTaskBoardClient,
  TaskBoardHttpError,
  TaskWorker,
  type AgentLauncher,
} from "#server/agents/task-worker";
import {
  AGENT_IMAGE_REPOSITORY,
  computeAgentImageTag,
  ContainerAgentLauncher,
  DEFAULT_ALLOWED_HOSTS,
  prepareContainerInfrastructure,
} from "#server/agents/task-container";
import { TaskWorkspaceManager, WorkspaceScopedLauncher } from "#server/agents/task-workspace";
import type {
  ManagedTaskWorker,
  TaskFleetAgentConfig,
  TaskFleetErrorClassifier,
  TaskFleetProvider,
  TaskFleetTransientClassifier,
} from "./types.js";

const VERSION_COMMAND_TIMEOUT_MS = 5_000;
const VERSION_COMMAND_MAX_BYTES = 16 * 1024;

export type TaskFleetVersionRunner = (command: string, arguments_: readonly string[]) => Promise<string>;

export interface ContainerRuntimeIdentity {
  readonly runtimeVersion: string;
  readonly imageId: string;
}

export interface CreateTaskFleetWorkerOptions {
  readonly registry?: RuntimeRegistry;
}

const runVersionCommand: TaskFleetVersionRunner = (command, arguments_) => new Promise((resolve, reject) => {
  execFile(command, [...arguments_], {
    encoding: "utf8",
    timeout: VERSION_COMMAND_TIMEOUT_MS,
    maxBuffer: VERSION_COMMAND_MAX_BYTES,
    windowsHide: true,
  }, (error, stdout) => {
    if (error !== null) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

const runDockerInspect: TaskFleetVersionRunner = runVersionCommand;

export async function captureTaskFleetRuntimeVersion(
  runtime: string,
  runner: TaskFleetVersionRunner = runVersionCommand,
): Promise<string | null> {
  try {
    const output = await runner(runtime, ["--version"]);
    const firstLine = output.split(/\r?\n/u, 1)[0]?.trim() ?? "";
    if (firstLine.length < 1 || firstLine.length > 128 || /[\u0000-\u001f\u007f]/u.test(firstLine)) return null;
    return firstLine;
  } catch {
    return null;
  }
}

/** Runtime pin and full immutable image ID from one `docker image inspect`; null when unreadable. */
export async function captureContainerRuntimeVersion(
  provider: TaskFleetProvider,
  image: string,
  runner: TaskFleetVersionRunner = runDockerInspect,
): Promise<ContainerRuntimeIdentity | null> {
  try {
    const format = `{{index .Config.Labels "steward.cli.${provider}"}}|{{.Id}}`;
    const output = await runner("docker", ["image", "inspect", "-f", format, image]);
    const firstLine = output.split(/\r?\n/u, 1)[0]?.trim() ?? "";
    const separator = firstLine.indexOf("|");
    if (separator < 1 || separator !== firstLine.lastIndexOf("|")) return null;
    const label = firstLine.slice(0, separator);
    const imageId = firstLine.slice(separator + 1);
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) return null;
    const runtimeVersion = `${label}+${imageId.slice("sha256:".length, "sha256:".length + 12)}`;
    if (runtimeVersion.length > 128 || /[\u0000-\u001f\u007f]/u.test(runtimeVersion)) return null;
    return Object.freeze({ runtimeVersion, imageId });
  } catch {
    return null;
  }
}

async function createLocalProcessTaskFleetWorker(
  config: TaskFleetAgentConfig,
  boardUrl: string,
  adapter: RuntimeAdapter,
): Promise<ManagedTaskWorker> {
  const runtimeVersion = await captureTaskFleetRuntimeVersion(adapter.runtime);
  let launcher: AgentLauncher = new ContainedCliAgentLauncher({
    adapter,
    model: config.model,
    workingDirectory: config.workingDirectory,
    ...(config.agentTimeoutMs === undefined ? {} : { timeoutMs: config.agentTimeoutMs }),
    ...(config.terminationGraceMs === undefined ? {} : { terminationGraceMs: config.terminationGraceMs }),
  });
  if (config.workspaceRoot !== undefined) {
    const manager = new TaskWorkspaceManager({
      workspaceRoot: config.workspaceRoot,
      repositoryPath: config.workingDirectory,
    });
    await manager.retainStrays([]);
    launcher = new WorkspaceScopedLauncher(launcher, manager);
  }
  const worker = await TaskWorker.create({
    identity: { workerId: config.workerId, agentId: config.agentId },
    statePath: config.statePath,
    board: new HttpTaskBoardClient({ baseUrl: boardUrl, token: config.token }),
    launcher,
    pinned: {
      runtime: config.provider,
      ...(runtimeVersion === null ? {} : { runtimeVersion }),
      model: config.model,
    },
    longPollMs: config.longPollMs,
  });
  return Object.freeze({
    run: (signal: AbortSignal) => worker.dispatchOnce(signal),
    hasActiveClaim: () => worker.hasActiveClaim(),
    quarantineActiveClaim: (detail: string, signal?: AbortSignal) => worker.quarantineActiveClaim(detail, signal),
    dropActiveClaim: (detail: string) => worker.dropActiveClaim(detail),
    // TaskWorker clears immediately after persisting a successful claim. The
    // fleet's post-operation clear remains useful for test/custom adapters.
    reportLaneError: (detail: string | null, signal?: AbortSignal) => detail === null
      ? Promise.resolve()
      : worker.reportLaneError(detail, signal),
    close: () => worker.close(),
  });
}

async function createContainerTaskFleetWorker(
  config: TaskFleetAgentConfig,
  boardUrl: string,
  adapter: RuntimeAdapter,
): Promise<ManagedTaskWorker> {
  const lane = config.container;
  if (lane === undefined) throw new Error("container lane config missing");
  const image = lane.image ?? `${AGENT_IMAGE_REPOSITORY}:${await computeAgentImageTag(process.cwd())}`;
  const infrastructure = await prepareContainerInfrastructure({
    image,
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...lane.extraAllowedHosts],
  });
  const runtimeIdentity = await captureContainerRuntimeVersion(config.provider, image);
  if (runtimeIdentity === null) {
    throw new Error(`container image identity could not be inspected: ${image}`);
  }
  const manager = new TaskWorkspaceManager({ workspaceRoot: lane.workspaceRoot, repositoryPath: config.workingDirectory });
  await manager.retainStrays([]);
  const launcher = new WorkspaceScopedLauncher(
    new ContainerAgentLauncher({
      adapter,
      model: config.model,
      image: runtimeIdentity.imageId,
      ...(lane.agentCommand === undefined ? {} : { agentCommand: lane.agentCommand }),
      networkName: infrastructure.agentNetwork,
      proxyUrl: infrastructure.proxyUrl,
      ...(config.agentTimeoutMs === undefined ? {} : { timeoutMs: config.agentTimeoutMs }),
      ...(config.terminationGraceMs === undefined ? {} : { terminationGraceMs: config.terminationGraceMs }),
    }),
    manager,
  );
  const worker = await TaskWorker.create({
    identity: { workerId: config.workerId, agentId: config.agentId },
    statePath: config.statePath,
    board: new HttpTaskBoardClient({ baseUrl: boardUrl, token: config.token }),
    launcher,
    pinned: {
      runtime: config.provider,
      runtimeVersion: runtimeIdentity.runtimeVersion,
      model: config.model,
    },
    longPollMs: config.longPollMs,
  });
  return Object.freeze({
    run: (signal: AbortSignal) => worker.dispatchOnce(signal),
    hasActiveClaim: () => worker.hasActiveClaim(),
    quarantineActiveClaim: (detail: string, signal?: AbortSignal) => worker.quarantineActiveClaim(detail, signal),
    dropActiveClaim: (detail: string) => worker.dropActiveClaim(detail),
    // TaskWorker clears immediately after persisting a successful claim. The
    // fleet's post-operation clear remains useful for test/custom adapters.
    reportLaneError: (detail: string | null, signal?: AbortSignal) => detail === null
      ? Promise.resolve()
      : worker.reportLaneError(detail, signal),
    close: () => worker.close(),
  });
}

export async function createTaskFleetWorker(
  config: TaskFleetAgentConfig,
  boardUrl: string,
  options: CreateTaskFleetWorkerOptions = {},
): Promise<ManagedTaskWorker> {
  const adapter = (options.registry ?? defaultRuntimeRegistry()).get(config.provider);
  if (adapter === null) throw new Error(`Unknown runtime adapter: ${config.provider}`);
  return config.runtime === "container"
    ? createContainerTaskFleetWorker(config, boardUrl, adapter)
    : createLocalProcessTaskFleetWorker(config, boardUrl, adapter);
}

export const classifyTaskFleetError: TaskFleetErrorClassifier = (error) => {
  if (error instanceof TaskBoardHttpError) {
    if (error.status === 401) return "CREDENTIAL_REVOKED";
    return error.status === null || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
      ? "TRANSIENT"
      : "POISONED";
  }
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  return code === "EIO" || code === "ENOSPC" || code === "EMFILE" || code === "ENFILE" || code === "EBUSY"
    ? "TRANSIENT"
    : "POISONED";
};

export const isTransientTaskFleetError: TaskFleetTransientClassifier = (error) => (
  classifyTaskFleetError(error) === "TRANSIENT"
);
