/** Resolves standalone task-worker environment aliases without silently choosing between them. */

export type TaskWorkerEnvironmentWarning = (message: string) => void;

const emitEnvironmentWarning: TaskWorkerEnvironmentWarning = (message) =>
  process.emitWarning(message, {
    type: "DeprecationWarning",
    code: "TASK_WORKER_ENV_ALIAS",
  });

export function taskWorkerRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  warning: TaskWorkerEnvironmentWarning = emitEnvironmentWarning
): string {
  const runtime = environment.STEWARD_TASK_WORKER_RUNTIME;
  const provider = environment.STEWARD_TASK_WORKER_PROVIDER;
  if (runtime !== undefined && provider !== undefined) {
    throw new Error(
      "STEWARD_TASK_WORKER_PROVIDER and STEWARD_TASK_WORKER_RUNTIME cannot both be set; STEWARD_TASK_WORKER_PROVIDER is deprecated, use STEWARD_TASK_WORKER_RUNTIME"
    );
  }
  if (runtime !== undefined) {
    if (runtime.length === 0) throw new Error("STEWARD_TASK_WORKER_RUNTIME is required");
    return runtime;
  }
  if (provider === undefined || provider.length === 0) {
    throw new Error("STEWARD_TASK_WORKER_RUNTIME is required");
  }
  warning("STEWARD_TASK_WORKER_PROVIDER is deprecated; use STEWARD_TASK_WORKER_RUNTIME");
  return provider;
}
