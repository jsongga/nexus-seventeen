import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface SupervisorStatus {
  readonly id: string;
  readonly tier?: "full";
  readonly state: "running" | "green" | "failed";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly command: string;
  readonly pid?: number;
}

interface StepResult {
  readonly exitCode: number;
  readonly detail?: string;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseStatus(value: unknown, path: string): SupervisorStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid verify status at ${path}`);
  }
  const candidate = value as Record<string, unknown>;
  const validPid = typeof candidate.pid === "number" && Number.isInteger(candidate.pid) && candidate.pid > 0;
  if (
    typeof candidate.id !== "string" || candidate.state !== "running" ||
    typeof candidate.startedAt !== "string" || candidate.endedAt !== null ||
    candidate.exitCode !== null || typeof candidate.command !== "string" || !validPid
  ) {
    throw new Error(`invalid verify status at ${path}`);
  }
  return {
    id: candidate.id,
    tier: candidate.tier === "full" ? "full" : undefined,
    state: "running",
    startedAt: candidate.startedAt,
    endedAt: null,
    exitCode: null,
    command: candidate.command,
    pid: candidate.pid as number,
  };
}

async function readInitialStatus(path: string): Promise<SupervisorStatus> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return parseStatus(JSON.parse(await readFile(path, "utf8")) as unknown, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`verify status did not appear at ${path}`);
}

function runStep(argv: readonly string[], logDescriptor: number): Promise<StepResult> {
  const [program, ...args] = argv;
  if (program === undefined || program.length === 0) {
    return Promise.resolve({ exitCode: 1, detail: "empty command" });
  }
  return new Promise<StepResult>((resolveStep) => {
    const child = spawn(program, args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolveStep({ exitCode: 1, detail: error.message });
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        resolveStep({
          exitCode: code ?? 1,
          detail: signal === null ? undefined : `terminated by ${signal}`,
        });
      }
    });
  });
}

export async function runSupervisor(
  runDirectory: string,
  commands: readonly (readonly string[])[],
): Promise<number> {
  const statusPath = resolve(runDirectory, "status.json");
  const logPath = resolve(runDirectory, "log");
  const initial = await readInitialStatus(statusPath);
  if (initial.pid !== process.pid) throw new Error(`verify supervisor pid mismatch at ${statusPath}`);
  await atomicWriteJson(statusPath, { ...initial, pid: process.pid });

  const log = await open(logPath, "a");
  let exitCode = 0;
  try {
    for (const argv of commands) {
      const display = argv.join(" ");
      await log.write(`$ ${display}\n`);
      const result = await runStep(argv, log.fd);
      if (result.exitCode !== 0) {
        exitCode = result.exitCode;
        const detail = result.detail === undefined ? "" : `: ${result.detail}`;
        await log.write(`failed step: ${display} (exit ${result.exitCode})${detail}\n`);
        break;
      }
    }
  } finally {
    await log.close();
  }

  await atomicWriteJson(statusPath, {
    ...initial,
    pid: process.pid,
    state: exitCode === 0 ? "green" : "failed",
    endedAt: new Date().toISOString(),
    exitCode,
  });
  return exitCode;
}

function commandList(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("supervisor commands must be a non-empty array");
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length === 0 || entry.some((argument) => typeof argument !== "string")) {
      throw new Error("each supervisor command must be a non-empty string array");
    }
    return entry as string[];
  });
}

async function main(args: readonly string[]): Promise<void> {
  const [runDirectory, encodedCommands] = args;
  if (runDirectory === undefined || encodedCommands === undefined || args.length !== 2) {
    throw new Error("usage: supervisor <run-directory> <json-encoded-argv-list>");
  }
  const exitCode = await runSupervisor(runDirectory, commandList(JSON.parse(encodedCommands) as unknown));
  process.exitCode = exitCode;
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  realpathSync(resolve(entrypoint)) === realpathSync(fileURLToPath(import.meta.url))
) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
