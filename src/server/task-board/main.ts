/** Starts the loopback task-board service from environment configuration and closes it on process signals. */

import { createTaskBoardService } from "./service.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

const projectRootsRaw = process.env.STEWARD_PROJECT_ROOTS;

const service = await createTaskBoardService({
  dbPath: required("STEWARD_TASK_BOARD_DB_PATH"),
  humanToken: required("STEWARD_TASK_BOARD_HUMAN_TOKEN"),
  humanPrincipal: process.env.STEWARD_TASK_BOARD_HUMAN_PRINCIPAL ?? "human:operator",
  corsOrigins: (process.env.STEWARD_TASK_BOARD_CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
  listenHost: (process.env.STEWARD_TASK_BOARD_HOST ?? "127.0.0.1") as "127.0.0.1" | "::1",
  port: optionalInteger("STEWARD_TASK_BOARD_PORT", 4_318),
  heartbeatTimeoutSeconds: optionalInteger("STEWARD_TASK_BOARD_HEARTBEAT_TIMEOUT_SECONDS", 300),
  reconcileIntervalSeconds: optionalInteger("STEWARD_TASK_BOARD_RECONCILE_INTERVAL_SECONDS", 60),
  parkNotifySeconds: optionalInteger("STEWARD_TASK_BOARD_PARK_NOTIFY_SECONDS", 86_400),
  parkAutoAbandonSeconds: optionalInteger("STEWARD_TASK_BOARD_PARK_AUTO_ABANDON_SECONDS", 604_800),
  stageCapSeconds: optionalInteger("STEWARD_TASK_BOARD_STAGE_CAP_SECONDS", 3_600),
  taskCapSeconds: optionalInteger("STEWARD_TASK_BOARD_TASK_CAP_SECONDS", 10_800),
  verifyWorkspaceRoot: process.env.STEWARD_TASK_BOARD_VERIFY_WORKSPACE_ROOT,
  hostPaths:
    projectRootsRaw === undefined
      ? undefined
      : {
          projectRoots: projectRootsRaw
            .split(":")
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        },
});

const address = await service.start();
process.stdout.write(`Steward task board listening on ${address.url}\n`);

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void service.close().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
