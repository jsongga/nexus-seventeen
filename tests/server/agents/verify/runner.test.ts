import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { VerifyRunner } from "#server/agents/verify";
import type { VerifyRule, VerifyRunStatus } from "#server/agents/verify";

interface WorkflowOptions {
  readonly compile?: readonly string[];
  readonly rules: readonly VerifyRule[];
  readonly full?: readonly string[];
}

async function writePath(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function writeWorkflow(root: string, options: WorkflowOptions): Promise<void> {
  const contract = {
    version: 1,
    compile: options.compile ?? ["compile"],
    rules: options.rules,
    full: options.full ?? ["node .test-helpers/exit0.mjs"],
  };
  await writePath(
    root,
    "docs/workflow.md",
    `# Test workflow\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`,
  );
}

async function command(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${String(code)}): ${stdout}${stderr}`));
    });
  });
}

async function foregroundRepo(
  files: Readonly<Record<string, string>>,
  options: WorkflowOptions,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-foreground-"));
  await writeWorkflow(root, options);
  await writePath(root, ".gitignore", ".test-dist/\n.verify-runs/\n.test-helpers/\n");
  for (const [path, contents] of Object.entries(files)) await writePath(root, path, contents);
  await command("git", ["init", "--quiet", "--initial-branch=main"], root);
  await command("git", ["config", "user.email", "verify-test@example.invalid"], root);
  await command("git", ["config", "user.name", "Verify Test"], root);
  await command("git", ["add", "."], root);
  await command("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline"], root);
  return root;
}

async function pollStatus(
  runner: VerifyRunner,
  id: string,
  predicate: (status: VerifyRunStatus) => boolean,
): Promise<VerifyRunStatus> {
  const deadline = Date.now() + 5_000;
  let latest = await runner.status(id);
  while (!predicate(latest) && Date.now() < deadline) {
    await delay(25);
    latest = await runner.status(id);
  }
  assert.ok(predicate(latest), `run ${id} did not reach the expected state; last state was ${latest.state}`);
  return latest;
}

async function backgroundRepo(full: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-background-"));
  await writeWorkflow(root, {
    rules: [{ match: "docs/**", action: { kind: "none" } }],
    full,
  });
  await writePath(
    root,
    ".test-helpers/exit0.mjs",
    'process.stdout.write("successful-child-output\\n");\n',
  );
  await writePath(
    root,
    ".test-helpers/delayed-exit0.mjs",
    'process.stdout.write("successful-child-output\\n"); setTimeout(() => process.exit(0), 300);\n',
  );
  await writePath(
    root,
    ".test-helpers/fail.mjs",
    'process.stderr.write("intentional-failure\\n"); process.exit(7);\n',
  );
  await writePath(
    root,
    ".test-helpers/never-reached.mjs",
    'process.stdout.write("NEVER_REACHED\\n");\n',
  );
  await writePath(root, ".test-helpers/sleep.mjs", "setTimeout(() => process.exit(0), 5000);\n");

  const relativeSupervisor = "build/server/agents/verify/supervisor.js";
  await mkdir(dirname(join(root, relativeSupervisor)), { recursive: true });
  await copyFile(join(process.cwd(), relativeSupervisor), join(root, relativeSupervisor));
  return root;
}

test("docs-only change is green, prints nothing to verify, and executes no commands", async (t) => {
  const root = await foregroundRepo(
    { "docs/guide.md": "before\n" },
    { rules: [{ match: "docs/**", action: { kind: "none" } }] },
  );
  await writePath(root, "docs/guide.md", "after\n");
  const executions: readonly string[][] = [];
  const log = t.mock.method(console, "log", () => undefined);
  const runner = new VerifyRunner({
    repoRoot: root,
    execute: async (argv) => {
      (executions as string[][]).push([...argv]);
      return 0;
    },
  });

  assert.deepEqual(await runner.changedFiles("HEAD"), ["docs/guide.md"]);
  assert.deepEqual(await runner.runForeground("fast", "HEAD"), { outcome: "green" });
  assert.deepEqual(executions, []);
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [["nothing to verify"]]);
});

test("an escalating container-test change returns the rule reason and executes no commands", async () => {
  const root = await foregroundRepo(
    { "tests/container/image.test.ts": "before\n" },
    { rules: [{ match: "tests/container/**", action: { kind: "escalate" } }] },
  );
  await writePath(root, "tests/container/image.test.ts", "after\n");
  const executions: string[][] = [];
  const runner = new VerifyRunner({
    repoRoot: root,
    execute: async (argv) => {
      executions.push([...argv]);
      return 0;
    },
  });

  assert.deepEqual(await runner.runForeground("fast", "HEAD"), {
    outcome: "escalate",
    reasons: ["tests/container/image.test.ts (rule tests/container/** escalates)"],
  });
  assert.deepEqual(executions, []);
});

test("a mapped runtime change compiles twice and runs exactly its compiled node test", async () => {
  const root = await foregroundRepo(
    {
      "src/server/widget.ts": "export const value = 1;\n",
      "tests/server/widget.test.ts": "export {};\n",
    },
    {
      compile: ["compile-one --fast", "compile-two --tests"],
      rules: [{ match: "src/server/**/*.ts", action: { kind: "mirror" } }],
    },
  );
  await writePath(root, "src/server/widget.ts", "export const value = 2;\n");
  const executions: string[][] = [];
  const runner = new VerifyRunner({
    repoRoot: root,
    execute: async (argv) => {
      executions.push([...argv]);
      if (executions.length === 2) {
        await writePath(root, ".test-dist/tests/server/widget.test.js", "export {};\n");
      }
      return 0;
    },
  });

  assert.deepEqual(await runner.runForeground("fast", "HEAD"), { outcome: "green" });
  assert.deepEqual(executions, [
    ["compile-one", "--fast"],
    ["compile-two", "--tests"],
    ["node", "--test", ".test-dist/tests/server/widget.test.js"],
  ]);
});

test("a failing node-test step is named and prevents the later vitest step", async () => {
  const root = await foregroundRepo(
    {
      "src/shared/value.ts": "export const value = 1;\n",
      "tests/server/existing.test.ts": "export {};\n",
    },
    {
      compile: ["compile-one", "compile-two"],
      rules: [{
        match: "src/shared/**",
        action: { kind: "fixed", nodeTestDirs: ["tests/server"], vitest: ["src/web"] },
      }],
    },
  );
  await writePath(root, "src/shared/value.ts", "export const value = 2;\n");
  const executions: string[][] = [];
  const exitCodes = [0, 0, 1, 0];
  const runner = new VerifyRunner({
    repoRoot: root,
    execute: async (argv) => {
      executions.push([...argv]);
      return exitCodes[executions.length - 1] ?? 0;
    },
  });

  assert.deepEqual(await runner.runForeground("area", "HEAD"), {
    outcome: "failed",
    step: "node --test .test-dist/tests/server/**/*.test.js",
  });
  assert.deepEqual(executions, [
    ["compile-one"],
    ["compile-two"],
    ["node", "--test", ".test-dist/tests/server/**/*.test.js"],
  ]);
});

test("a selected compiled test missing after compile fails as a mapping bug", async () => {
  const root = await foregroundRepo(
    {
      "src/server/missing.ts": "export const value = 1;\n",
      "tests/server/missing.test.ts": "export {};\n",
    },
    {
      compile: ["compile-one", "compile-two"],
      rules: [{ match: "src/server/**/*.ts", action: { kind: "mirror" } }],
    },
  );
  await writePath(root, "src/server/missing.ts", "export const value = 2;\n");
  const executions: string[][] = [];
  const runner = new VerifyRunner({
    repoRoot: root,
    execute: async (argv) => {
      executions.push([...argv]);
      return 0;
    },
  });

  const result = await runner.runForeground("fast", "HEAD");
  assert.deepEqual(result, {
    outcome: "failed",
    step: "selection (tests/server/missing.test.ts missing after compile — mapping bug)",
  });
  assert.match(result.outcome === "failed" ? result.step : "", /mapping bug/u);
  assert.deepEqual(executions, [["compile-one"], ["compile-two"]]);
});

test("a deleted committed file escalates before incremental compilation", async () => {
  const root = await foregroundRepo(
    {
      "src/server/deleted.ts": "export const value = 1;\n",
      "tests/server/deleted.test.ts": "export {};\n",
    },
    {
      compile: ["compile-one", "compile-two"],
      rules: [{ match: "src/server/**/*.ts", action: { kind: "mirror" } }],
    },
  );
  await rm(join(root, "src/server/deleted.ts"));
  const executions: string[][] = [];
  const runner = new VerifyRunner({
    repoRoot: root,
    execute: async (argv) => {
      executions.push([...argv]);
      return 0;
    },
  });

  assert.deepEqual(await runner.changedFiles("HEAD"), ["src/server/deleted.ts"]);
  assert.deepEqual(await runner.runForeground("fast", "HEAD"), {
    outcome: "escalate",
    reasons: [
      "src/server/deleted.ts (deleted or renamed — stale compiled outputs; run a clean tier)",
    ],
  });
  assert.deepEqual(executions, []);
});

test("a background full run progresses from running to green and tail reads only final bytes", async () => {
  const full = ["node .test-helpers/delayed-exit0.mjs"];
  const root = await backgroundRepo(full);
  const runner = new VerifyRunner({ repoRoot: root });

  const id = await runner.startFull();
  assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{4}$/u);
  const initial = await runner.status(id);
  assert.deepEqual(initial, {
    id,
    state: "running",
    startedAt: initial.startedAt,
    endedAt: null,
    exitCode: null,
    command: full.join(" && "),
  });
  assert.ok(!Number.isNaN(Date.parse(initial.startedAt)));

  const complete = await pollStatus(runner, id, (status) => status.state === "green");
  assert.equal(complete.exitCode, 0);
  assert.ok(complete.endedAt !== null && !Number.isNaN(Date.parse(complete.endedAt)));
  const log = await runner.tail(id);
  assert.match(log, /successful-child-output/u);
  const logBytes = await readFile(join(root, ".verify-runs", id, "log"));
  const expectedTail = logBytes.subarray(Math.max(0, logBytes.length - 8)).toString("utf8");
  assert.equal(await runner.tail(id, 8), expectedTail);
  assert.equal(Buffer.byteLength(expectedTail), 8);
});

test("a background full run stops at its failing step and records that step", async () => {
  const full = [
    "node .test-helpers/exit0.mjs",
    "node .test-helpers/fail.mjs",
    "node .test-helpers/never-reached.mjs",
  ];
  const root = await backgroundRepo(full);
  const runner = new VerifyRunner({ repoRoot: root });

  const id = await runner.startFull();
  const complete = await pollStatus(runner, id, (status) => status.state === "failed");
  assert.equal(complete.exitCode, 7);
  assert.equal(complete.command, full.join(" && "));
  assert.ok(complete.endedAt !== null);
  const log = await runner.tail(id, 16_384);
  assert.match(log, /successful-child-output/u);
  assert.match(log, /intentional-failure/u);
  assert.match(log, /failed step: node \.test-helpers\/fail\.mjs \(exit 7\)/u);
  assert.doesNotMatch(log, /never-reached|NEVER_REACHED/u);
});

test("status reports died after a running supervisor is killed", async () => {
  const root = await backgroundRepo(["node .test-helpers/sleep.mjs"]);
  const runner = new VerifyRunner({ repoRoot: root });
  const id = await runner.startFull();
  const statusPath = join(root, ".verify-runs", id, "status.json");
  const deadline = Date.now() + 5_000;
  let pid: number | undefined;
  while (pid === undefined && Date.now() < deadline) {
    const stored = JSON.parse(await readFile(statusPath, "utf8")) as { pid?: unknown; state?: unknown };
    if (stored.state === "running" && typeof stored.pid === "number") pid = stored.pid;
    else await delay(25);
  }
  assert.ok(pid !== undefined, "supervisor did not record its pid");
  process.kill(pid, "SIGKILL");

  const died = await pollStatus(runner, id, (status) => status.state === "died");
  assert.equal(died.exitCode, null);
  assert.equal(died.endedAt, null);
  assert.equal(died.command, "node .test-helpers/sleep.mjs");
});

test("keepRuns two prunes the oldest run when a third full run starts", async () => {
  const root = await backgroundRepo(["node .test-helpers/exit0.mjs"]);
  const runner = new VerifyRunner({ repoRoot: root, keepRuns: 2 });

  const first = await runner.startFull();
  await pollStatus(runner, first, (status) => status.state === "green");
  const second = await runner.startFull();
  await pollStatus(runner, second, (status) => status.state === "green");
  const third = await runner.startFull();
  await pollStatus(runner, third, (status) => status.state === "green");

  const directories = (await readdir(join(root, ".verify-runs"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.equal(directories.length, 2);
  assert.deepEqual(directories, [second, third].sort());
  assert.ok(!directories.includes(first));
  const listed = await runner.list();
  assert.deepEqual(new Set(listed.map((status) => status.id)), new Set([second, third]));
  assert.ok(listed.every((status) => status.state === "green" && status.exitCode === 0));
});
