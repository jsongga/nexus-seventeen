/** Exposes fleet configuration, worker construction, supervision, and lane contracts to runtime entry points. */

export { loadTaskFleetConfig, parseTaskFleetConfig, type TaskFleetConfigWarning } from "./config.js";
export {
  captureContainerRuntimeVersion,
  captureTaskFleetRuntimeVersion,
  classifyTaskFleetError,
  createTaskFleetWorker,
  isTransientTaskFleetError,
} from "./worker-factory.js";
export type {
  ManagedTaskWorker,
  TaskFleetAgentConfig,
  TaskFleetConfig,
  TaskFleetContainerLaneConfig,
  TaskFleetEvent,
  TaskFleetLaneSnapshot,
  TaskFleetLaneStatus,
  TaskFleetLogger,
  TaskFleetLaunchMode,
  TaskFleetRetryConfig,
  TaskFleetRuntime,
  TaskFleetSleeper,
  TaskFleetSnapshot,
  TaskFleetTransientClassifier,
  TaskFleetErrorClassification,
  TaskFleetErrorClassifier,
  TaskFleetWorkerFactory,
} from "./types.js";
