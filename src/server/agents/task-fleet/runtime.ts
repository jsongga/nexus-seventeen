import { execFile } from "node:child_process";
import {
  ContainedCliAgentLauncher,
  HttpTaskBoardClient,
  TaskBoardHttpError,
  TaskWorker,
} from "#server/agents/task-worker";
import type {
  TaskFleetErrorClassifier,
  TaskFleetProvider,
  TaskFleetTransientClassifier,
  TaskFleetWorkerFactory,
} from "./types.js";

const VERSION_COMMAND_TIMEOUT_MS = 5_000;
const VERSION_COMMAND_MAX_BYTES = 16 * 1024;

export type TaskFleetVersionRunner = (command: string, arguments_: readonly string[]) => Promise<string>;

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

export async function captureTaskFleetRuntimeVersion(
  provider: TaskFleetProvider,
  runner: TaskFleetVersionRunner = runVersionCommand,
): Promise<string | null> {
  try {
    const output = await runner(provider, ["--version"]);
    const firstLine = output.split(/\r?\n/u, 1)[0]?.trim() ?? "";
    if (firstLine.length < 1 || firstLine.length > 128 || /[\u0000-\u001f\u007f]/u.test(firstLine)) return null;
    return firstLine;
  } catch {
    return null;
  }
}

export const createTaskFleetWorker: TaskFleetWorkerFactory = async (config, boardUrl) => {
  const runtimeVersion = await captureTaskFleetRuntimeVersion(config.provider);
  const worker = await TaskWorker.create({
    identity: { workerId: config.workerId, agentId: config.agentId },
    statePath: config.statePath,
    board: new HttpTaskBoardClient({ baseUrl: boardUrl, token: config.token }),
    launcher: new ContainedCliAgentLauncher({
      provider: config.provider,
      model: config.model,
      workingDirectory: config.workingDirectory,
      ...(config.agentTimeoutMs === undefined ? {} : { timeoutMs: config.agentTimeoutMs }),
      ...(config.terminationGraceMs === undefined ? {} : { terminationGraceMs: config.terminationGraceMs }),
    }),
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
};

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
