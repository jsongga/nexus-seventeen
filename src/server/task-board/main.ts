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
  host: projectRootsRaw === undefined ? undefined : {
    projectRoots: projectRootsRaw.split(":").map((value) => value.trim()).filter((value) => value.length > 0),
  },
});

const address = await service.start();
process.stdout.write(`Steward task board listening on ${address.url}\n`);

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void service.close().then(() => process.exit(0), () => process.exit(1));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
