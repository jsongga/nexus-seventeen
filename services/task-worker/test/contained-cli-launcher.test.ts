import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ContainedCliAgentLauncher } from "../src/contained-cli-launcher.js";
import { context, tempRoot, until } from "./helpers.js";

async function fakeCodex(root: string, source: string): Promise<{ bin: string; working: string; scratch: string }> {
  const bin = join(root, "bin");
  const working = join(root, "workspace");
  const scratch = join(root, "scratch");
  await mkdir(bin);
  await mkdir(working);
  await mkdir(scratch);
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { bin, working, scratch };
}

test("runs one real contained Codex process with bounded full-task context", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(root, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "prompt.txt"), input);
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "args.json"), JSON.stringify(process.argv.slice(2)));
  const result = {
    status: "completed",
    progress: ["The focused retry checks pass."],
    result: "Customers can retry checkout without a duplicate charge.",
    proposedChildTasks: [],
    humanQuestion: null,
    detail: "Checkout retries are now idempotent and tested."
  };
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
});
`);
  const launcher = new ContainedCliAgentLauncher({
    provider: "codex",
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: {
      PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: fixture.scratch,
    },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });

  const handle = await launcher.launch({
    runId: "run-contained-one",
    wakeReason: "human_assignment",
    context: context(),
  });
  const outcome = await handle.completion;

  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.outputs.map((output) => output.type), ["progress", "result"]);
  const prompt = await readFile(join(fixture.scratch, "prompt.txt"), "utf8");
  assert.match(prompt, /research → plan → execute → test/u);
  assert.match(prompt, /single human-triggered run/u);
  assert.match(prompt, /Never deploy/u);
  const args = JSON.parse(await readFile(join(fixture.scratch, "args.json"), "utf8")) as string[];
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("--output-schema"));
});

test("manager role is launched read-only with an oversight prompt", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(root, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "prompt.txt"), input);
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "args.json"), JSON.stringify(process.argv.slice(2)));
  const result = {status:"completed",progress:[],result:"The evidence is ready for human review.",proposedChildTasks:[],humanQuestion:null,detail:"Oversight completed."};
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}));
  console.log(JSON.stringify({type:"turn.completed"}));
});
`);
  const launcher = new ContainedCliAgentLauncher({
    provider: "codex",
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: { PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: fixture.scratch },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });
  const handle = await launcher.launch({
    runId: "run-manager-one",
    wakeReason: "human_assignment",
    context: context({ mission: { role: "manager", area: "Release oversight", mission: "Review evidence and risks." } }),
  });
  await handle.completion;
  const args = JSON.parse(await readFile(join(fixture.scratch, "args.json"), "utf8")) as string[];
  assert.ok(args.includes("read-only"));
  assert.match(await readFile(join(fixture.scratch, "prompt.txt"), "utf8"), /read-only oversight/u);
});

test("direct interrupt kills and confirms absence of the entire OS process group", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(root, `
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");
fs.writeFileSync(path.join(process.env.TMPDIR, "pid.txt"), String(process.pid));
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:"ignore"});
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const launcher = new ContainedCliAgentLauncher({
    provider: "codex",
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: { PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: fixture.scratch },
    timeoutMs: 10_000,
    terminationGraceMs: 20,
    groupAbsenceTimeoutMs: 2_000,
  });
  const handle = await launcher.launch({
    runId: "run-interrupt-one",
    wakeReason: "human_assignment",
    context: context(),
  });
  const completion = handle.completion;
  void completion.catch(() => undefined);
  const marker = join(fixture.scratch, "pid.txt");
  await until(() => existsSync(marker), "fake agent process");
  const groupId = Number(await readFile(marker, "utf8"));
  await handle.interrupt("Human interrupted this agent run");
  await assert.rejects(completion, /interrupted/u);
  assert.throws(() => process.kill(-groupId, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});
