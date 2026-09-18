/** Provides the fast, area, full, status, tail, and list commands for repository verification runs. */

import { VerifyRunner } from "./runner.js";
import type { VerifyTier } from "./mapping.js";

const USAGE = `usage:
  verify fast [--base <ref>]
  verify area [--base <ref>]
  verify full
  verify status <id>
  verify tail <id> [--bytes N]
  verify list
`;

function usage(): number {
  process.stderr.write(USAGE);
  return 64;
}

async function foreground(runner: VerifyRunner, tier: VerifyTier, args: readonly string[]): Promise<number> {
  let base = "main";
  if (args.length !== 0) {
    const candidate = args[1];
    if (args.length !== 2 || args[0] !== "--base" || candidate === undefined || candidate.length === 0) {
      return usage();
    }
    base = candidate;
  }

  const result = await runner.runForeground(tier, base);
  switch (result.outcome) {
    case "green":
      return 0;
    case "failed":
      process.stderr.write(`verification failed: ${result.step}\n`);
      return 1;
    case "escalate":
      process.stderr.write(`${result.reasons.join("\n")}\n`);
      return 2;
  }
}

function parseBytes(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

async function dispatch(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  const runner = new VerifyRunner({ repoRoot: process.cwd() });

  if (command === "fast") return foreground(runner, "fast", rest);
  if (command === "area") return foreground(runner, "area", rest);

  if (command === "full") {
    if (rest.length !== 0) return usage();
    process.stdout.write(`${await runner.startFull()}\n`);
    return 0;
  }

  if (command === "status") {
    const id = rest[0];
    if (rest.length !== 1 || id === undefined) return usage();
    const status = await runner.status(id);
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return status.state === "running" || status.state === "green" ? 0 : 1;
  }

  if (command === "tail") {
    const id = rest[0];
    if (id === undefined) return usage();
    if (rest.length === 1) {
      process.stdout.write(await runner.tail(id));
      return 0;
    }
    const value = rest[2];
    const bytes = value === undefined ? undefined : parseBytes(value);
    if (rest.length !== 3 || rest[1] !== "--bytes" || bytes === undefined) return usage();
    process.stdout.write(await runner.tail(id, bytes));
    return 0;
  }

  if (command === "list") {
    if (rest.length !== 0) return usage();
    const runs = await runner.list();
    if (runs.length > 0) {
      process.stdout.write(`${runs.map((run) => `${run.id}\t${run.state}\t${run.startedAt}`).join("\n")}\n`);
    }
    return 0;
  }

  return usage();
}

try {
  process.exitCode = await dispatch(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
