import {
  ContainedCliAgentLauncher,
  HttpTaskBoardClient,
  TaskBoardHttpError,
  TaskWorker,
} from "@cicada/steward-task-worker";
import type { TaskFleetTransientClassifier, TaskFleetWorkerFactory } from "./types.js";

export const createTaskFleetWorker: TaskFleetWorkerFactory = async (config, boardUrl) => {
  return TaskWorker.create({
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
};

export const isTransientTaskFleetError: TaskFleetTransientClassifier = (error) => {
  if (!(error instanceof TaskBoardHttpError)) return false;
  return error.status === null || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
};
