import {
  ContainedCliAgentLauncher,
  HttpTaskBoardClient,
  TaskBoardHttpError,
  TaskWorker,
} from "#server/agents/task-worker";
import type { TaskFleetTransientClassifier, TaskFleetWorkerFactory } from "./types.js";

export const createTaskFleetWorker: TaskFleetWorkerFactory = async (config, boardUrl) => {
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

export const isTransientTaskFleetError: TaskFleetTransientClassifier = (error) => {
  if (error instanceof TaskBoardHttpError) {
    return error.status === null || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  return code === "EIO" || code === "ENOSPC" || code === "EMFILE" || code === "ENFILE" || code === "EBUSY";
};
