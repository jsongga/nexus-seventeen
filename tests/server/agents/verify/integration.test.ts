import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const CLI_PATH = join(process.cwd(), "build/server/agents/verify/main.js");
const SUPERVISOR_PATH = join(process.cwd(), "build/server/agents/verify/step-runner.js");

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliStatus {
  readonly id: string;
  readonly state: "running" | "green" | "failed" | "died";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly command: string;
}

async function writePath(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

function execute(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(command, [...args], { cwd, encoding: "utf8", env }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({
        exitCode: error.code,
        stdout,
        stderr,
      });
    });
  });
}

async function executeSuccessfully(command: string, args: readonly string[], cwd: string): Promise<void> {
  const result = await execute(command, args, cwd);
  assert.equal(result.exitCode, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
}

function runCli(repoRoot: string, args: readonly string[]): Promise<CommandResult> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return execute(process.execPath, [CLI_PATH, ...args], repoRoot, env);
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-cli-integration-"));
  const repo = join(root, "repo");
  await executeSuccessfully("git", ["init", "-b", "main", repo], root);

  const contract = {
    version: 1,
    compile: ["node compile-marker.mjs"],
    rules: [
      { match: "src/**", action: { kind: "mirror" } },
      { match: "**/*.md", action: { kind: "none" } },
    ],
    full: ["node full-one.mjs", "node full-two.mjs"],
  };
  await writePath(
    repo,
    "docs/workflow.md",
    `# Fixture workflow\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`
  );
  await writePath(repo, ".gitignore", ".test-dist/\n.verify-runs/\nbuild/\ncompile-marker.log\nfull-fail.flag\n");
  await writePath(repo, "src/x.ts", 'export const state = "base";\n');
  await writePath(
    repo,
    "tests/x.test.ts",
    [
      'const assert = require("node:assert/strict");',
      'const { readFileSync } = require("node:fs");',
      'const test = require("node:test");',
      "",
      'test("source is green", () => {',
      '  assert.match(readFileSync("src/x.ts", "utf8"), /green/);',
      "});",
      "",
    ].join("\n")
  );
  await writePath(
    repo,
    "compile-marker.mjs",
    [
      'import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";',
      'mkdirSync(".test-dist/tests", { recursive: true });',
      'copyFileSync("tests/x.test.ts", ".test-dist/tests/x.test.js");',
      'appendFileSync("compile-marker.log", "compiled\\n");',
      "",
    ].join("\n")
  );
  await writePath(repo, "full-one.mjs", 'process.stdout.write("first-full-command\\n");\n');
  await writePath(
    repo,
    "full-two.mjs",
    [
      'import { existsSync } from "node:fs";',
      'process.stdout.write("second-full-command-complete\\n");',
      'if (existsSync("full-fail.flag")) process.exitCode = 9;',
      "",
    ].join("\n")
  );

  await executeSuccessfully("git", ["add", "."], repo);
  await executeSuccessfully(
    "git",
    [
      "-c",
      "user.name=Verify Fixture",
      "-c",
      "user.email=verify-fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "baseline",
    ],
    repo
  );

  await writePath(repo, "build/sentinel.txt", "keep me\n");
  const fixtureSupervisor = join(repo, "build/server/agents/verify/step-runner.js");
  await mkdir(dirname(fixtureSupervisor), { recursive: true });
  await copyFile(SUPERVISOR_PATH, fixtureSupervisor);
  return repo;
}

async function waitForStatus(
  repoRoot: string,
  id: string,
  expected: "green" | "failed"
): Promise<{ readonly result: CommandResult; readonly status: CliStatus }> {
  const deadline = Date.now() + 5_000;
  let result = await runCli(repoRoot, ["status", id]);
  let status = JSON.parse(result.stdout) as CliStatus;
  while (status.state === "running" && Date.now() < deadline) {
    await delay(25);
    result = await runCli(repoRoot, ["status", id]);
    status = JSON.parse(result.stdout) as CliStatus;
  }
  assert.equal(status.state, expected, `run ${id} did not reach ${expected}`);
  return { result, status };
}

test("real verify CLI dispatches foreground and background runs against a git fixture", async (t) => {
  const repo = await createFixture();
  t.after(async () => rm(dirname(repo), { recursive: true, force: true }));

  await writePath(repo, "src/x.ts", 'export const state = "escalating";\n');
  await writePath(repo, "unsafe.yml", "unmapped: true\n");
  const escalating = await runCli(repo, ["fast", "--base", "main"]);
  assert.equal(escalating.exitCode, 2);
  assert.match(escalating.stderr, /unsafe\.yml \(unmapped change, run area\/full\)/u);

  await rm(join(repo, "unsafe.yml"));
  await writePath(repo, "src/x.ts", 'export const state = "failing";\n');
  const failing = await runCli(repo, ["fast", "--base", "main"]);
  assert.equal(failing.exitCode, 1, `${failing.stdout}${failing.stderr}`);
  assert.match(failing.stderr, /node --test \.test-dist\/tests\/x\.test\.js/u);

  await writePath(repo, "src/x.ts", 'export const state = "green";\n');
  const green = await runCli(repo, ["fast", "--base", "main"]);
  assert.equal(green.exitCode, 0, green.stderr);
  assert.equal(await readFile(join(repo, "compile-marker.log"), "utf8"), "compiled\ncompiled\n");
  await access(join(repo, "build/sentinel.txt"));

  const full = await runCli(repo, ["full"]);
  assert.equal(full.exitCode, 0, full.stderr);
  const id = full.stdout.trim();
  assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{4}$/u);

  const completed = await waitForStatus(repo, id, "green");
  assert.equal(completed.result.exitCode, 0);
  assert.equal(completed.status.exitCode, 0);
  assert.equal(completed.status.command, "node full-one.mjs && node full-two.mjs");

  const completeTail = await runCli(repo, ["tail", id]);
  assert.equal(completeTail.exitCode, 0, completeTail.stderr);
  assert.match(completeTail.stdout, /first-full-command/u);
  assert.match(completeTail.stdout, /second-full-command-complete/u);
  const boundedTail = await runCli(repo, ["tail", id, "--bytes", "8"]);
  assert.equal(boundedTail.exitCode, 0, boundedTail.stderr);
  assert.equal(Buffer.byteLength(boundedTail.stdout), 8);
  assert.equal(boundedTail.stdout, Buffer.from(completeTail.stdout).subarray(-8).toString("utf8"));

  const listed = await runCli(repo, ["list"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  const [listedId, listedState, listedStartedAt] = listed.stdout.trim().split("\t");
  assert.equal(listedId, id);
  assert.equal(listedState, "green");
  assert.equal(listedStartedAt, completed.status.startedAt);

  await writePath(repo, "full-fail.flag", "fail\n");
  const failedFull = await runCli(repo, ["full"]);
  assert.equal(failedFull.exitCode, 0, failedFull.stderr);
  const failedId = failedFull.stdout.trim();
  const failedStatus = await waitForStatus(repo, failedId, "failed");
  assert.equal(failedStatus.result.exitCode, 1);
  assert.equal(failedStatus.status.exitCode, 9);

  const usage = await runCli(repo, ["fast", "--base"]);
  assert.equal(usage.exitCode, 64);
  assert.match(usage.stderr, /usage:/iu);
});
