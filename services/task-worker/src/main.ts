import { ContainedCliAgentLauncher } from "./contained-cli-launcher.js";
import { HttpTaskBoardClient } from "./http-board-client.js";
import { TaskWorker } from "./worker.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

const provider = required("STEWARD_TASK_WORKER_PROVIDER");
if (provider !== "codex" && provider !== "claude") throw new Error("STEWARD_TASK_WORKER_PROVIDER is invalid");
const longPollMs = optionalInteger("STEWARD_TASK_WORKER_LONG_POLL_MS");
const timeoutMs = optionalInteger("STEWARD_TASK_WORKER_AGENT_TIMEOUT_MS");
const terminationGraceMs = optionalInteger("STEWARD_TASK_WORKER_TERMINATION_GRACE_MS");

const worker = await TaskWorker.create({
  identity: {
    workerId: required("STEWARD_TASK_WORKER_ID"),
    agentId: required("STEWARD_TASK_WORKER_AGENT_ID"),
  },
  statePath: required("STEWARD_TASK_WORKER_STATE_PATH"),
  board: new HttpTaskBoardClient({
    baseUrl: required("STEWARD_TASK_BOARD_URL"),
    token: required("STEWARD_TASK_WORKER_AGENT_TOKEN"),
  }),
  launcher: new ContainedCliAgentLauncher({
    provider,
    model: required("STEWARD_TASK_WORKER_MODEL"),
    workingDirectory: required("STEWARD_TASK_WORKER_WORKING_DIRECTORY"),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(terminationGraceMs === undefined ? {} : { terminationGraceMs }),
  }),
  ...(longPollMs === undefined ? {} : { longPollMs }),
});

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
try {
  await worker.run(stop.signal);
} finally {
  await worker.close();
}
