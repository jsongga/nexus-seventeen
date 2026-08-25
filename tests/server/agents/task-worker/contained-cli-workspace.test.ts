import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { claudeAdapter } from "../../../../src/server/agents/runtime/claude.js";
import { ContainedCliAgentLauncher } from "#server/agents/task-worker/contained-cli-launcher";
import { CLAUDE_PROFILE } from "../runtime/profile-fixtures.js";
import { context, tempRoot } from "./helpers.js";

test("a contained launch uses the per-run workspace for cwd and sandbox roots", async () => {
  const root = await tempRoot();
  const bin = join(root, "bin");
  const fallback = join(root, "fallback");
  const workspace = join(root, "pipeline-workspace");
  const scratch = join(root, "scratch");
  await Promise.all([mkdir(bin), mkdir(fallback), mkdir(workspace), mkdir(scratch)]);
  const executable = join(bin, "claude");
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(process.env.TMPDIR, "cwd.txt"), process.cwd());
  fs.writeFileSync(path.join(process.env.TMPDIR, "args.json"), JSON.stringify(process.argv.slice(2)));
  const result = {status:"completed",progress:[],result:"Done.",proposedChildTasks:[],expectedAgentMinutes:null,phases:[],humanQuestion:null,detail:"Done."};
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,structured_output:result}));
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const launcher = new ContainedCliAgentLauncher({
    adapter: claudeAdapter,
    profile: CLAUDE_PROFILE,
    model: "claude-test-model",
    workingDirectory: fallback,
    environment: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: scratch,
    },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });

  const handle = await launcher.launch({
    runId: "run-contained-workspace",
    wakeReason: "workflow_handoff",
    context: context(),
    workspace: { path: workspace },
  });
  assert.equal((await handle.completion).status, "completed");

  assert.equal(await readFile(join(scratch, "cwd.txt"), "utf8"), await realpath(workspace));
  const args = JSON.parse(await readFile(join(scratch, "args.json"), "utf8")) as string[];
  const settingsIndex = args.indexOf("--settings");
  assert.notEqual(settingsIndex, -1);
  const settings = JSON.parse(args[settingsIndex + 1]!) as {
    sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } };
  };
  assert.deepEqual(settings.sandbox.filesystem.allowRead, [workspace]);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [workspace]);

  await assert.rejects(
    launcher.launch({
      runId: "run-contained-relative-workspace",
      wakeReason: "workflow_handoff",
      context: context(),
      workspace: { path: "relative-workspace" },
    }),
    /workingDirectory must be absolute/u,
  );
});
