import { resolve } from "node:path";
import { loadTaskFleetConfig } from "./config.js";
import { TaskFleet } from "./fleet.js";
import { createTaskFleetWorker, isTransientTaskFleetError } from "./runtime.js";

function configPath(): string {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1) throw new Error("Usage: steward-task-fleet [config.json]");
  const source = arguments_[0] ?? process.env.STEWARD_TASK_FLEET_CONFIG;
  if (source === undefined || source.length === 0) {
    throw new Error("Pass a config path or set STEWARD_TASK_FLEET_CONFIG");
  }
  return resolve(source);
}

const config = await loadTaskFleetConfig(configPath());
const fleet = new TaskFleet({ config, workerFactory: createTaskFleetWorker, isTransient: isTransientTaskFleetError });
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

try {
  await fleet.run(stop.signal);
} finally {
  await fleet.close();
}
