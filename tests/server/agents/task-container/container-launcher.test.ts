import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { codexAdapter } from "../../../../src/server/agents/runtime/codex.js";
import type { RuntimeEvent } from "../../../../src/server/agents/runtime/adapter.js";
import { ContainerAgentLauncher } from "#server/agents/task-container";
import { AgentProcessError, PromptRegistry } from "#server/agents/task-worker";
import { CODEX_PROFILE } from "../runtime/profile-fixtures.js";
import { context, tempRoot, until } from "../task-worker/helpers.js";

const PROMPTS = PromptRegistry.loadSync(resolve("config/prompts.md"));

async function fakeDocker(
  root: string,
  options: Readonly<{ run: string; inspect: string }>,
): Promise<{ binary: string; log: string; marker: string; workspace: string }> {
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const binary = join(bin, "docker");
  const log = join(root, "docker.log");
  const marker = join(root, "run.pid");
  await mkdir(bin);
  await mkdir(workspace);
  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const command = process.argv[2];
fs.appendFileSync(${JSON.stringify(log)}, command + "\\n");
if (command === "run") {
  ${options.run}
} else if (command === "stop") {
  process.exit(0);
} else if (command === "inspect") {
  ${options.inspect}
} else if (command === "rm") {
  process.exit(0);
} else {
  process.exit(2);
}
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { binary, log, marker, workspace };
}

function launcher(
  fixture: Readonly<{ binary: string; workspace: string }>,
  terminationGraceMs = 20,
): ContainerAgentLauncher {
  return new ContainerAgentLauncher({
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "gpt-test",
    image: "steward-agent:test",
    networkName: "steward-agents",
    proxyUrl: "http://steward-egress-proxy:3128",
    environment: { PATH: process.env.PATH },
    timeoutMs: 5_000,
    terminationGraceMs,
    dockerBinary: fixture.binary,
  });
}

async function launch(
  target: ContainerAgentLauncher,
  workspace: string,
  runId: string,
) {
  return target.launch({
    runId,
    wakeReason: "human_assignment",
    context: context(),
    workspace: { path: workspace },
  });
}

test("constructor accepts an immutable image ID without allowing option injection", () => {
  const options = {
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "gpt-test",
    networkName: "steward-agents",
    proxyUrl: "http://steward-egress-proxy:3128",
    dockerBinary: "/nonexistent",
  };

  assert.doesNotThrow(() => new ContainerAgentLauncher({
    ...options,
    image: `sha256:${"a".repeat(64)}`,
  }));
  assert.throws(() => new ContainerAgentLauncher({
    ...options,
    image: "--network=host",
  }), /image is invalid/u);
});

test("interrupt rejects when daemon errors prevent confirming container absence", async () => {
  const root = await tempRoot();
  const fixture = await fakeDocker(root, {
    run: `fs.writeFileSync(${JSON.stringify(join(root, "run.pid"))}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1_000);`,
    inspect: `process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1);`,
  });
  const handle = await launch(launcher(fixture), fixture.workspace, "run-daemon-error");
  void handle.completion.catch(() => undefined);
  await until(() => existsSync(fixture.marker), "fake docker run client");

  await assert.rejects(
    handle.interrupt("Human interrupted this agent run"),
    (error: unknown) => error instanceof AgentProcessError
      && error.message === "Task container could not be confirmed absent",
  );
});

test("interrupt waits for docker run to close before accepting explicit absence", async () => {
  const root = await tempRoot();
  const marker = join(root, "run.pid");
  const fixture = await fakeDocker(root, {
    run: `fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdout.write("attached\\n"); process.stdin.resume(); setInterval(() => {}, 1_000);`,
    inspect: `
      const pid = Number(fs.readFileSync(${JSON.stringify(marker)}, "utf8"));
      try {
        process.kill(pid, 0);
        process.stderr.write("Docker run client is still alive\\n");
        process.exit(1);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        process.stderr.write("Error: No such object: steward-task-run-explicit-absence\\n");
        process.exit(1);
      }
    `,
  });
  const handle = await launch(launcher(fixture), fixture.workspace, "run-explicit-absence");
  const activityEvents: RuntimeEvent[] = [];
  const collectedActivity = (async (): Promise<RuntimeEvent[]> => {
    for await (const event of handle.activity) activityEvents.push(event);
    return activityEvents;
  })();
  void handle.completion.catch(() => undefined);
  await until(() => existsSync(fixture.marker), "fake docker run client");
  await until(() => activityEvents.some((event) => event.type === "tool_call" && event.name === "container_attached"), "container attachment activity");

  await handle.interrupt("Human interrupted this agent run");
  await assert.rejects(handle.completion, /interrupted directly/u);
  assert.deepEqual((await readFile(fixture.log, "utf8")).trim().split("\n"), [
    "run", "stop", "inspect", "rm", "inspect",
  ]);
  assert.deepEqual(await collectedActivity, [
    { type: "tool_call", name: "container_starting", detail: "" },
    { type: "tool_call", name: "container_attached", detail: "" },
    { type: "tool_call", name: "container_teardown", detail: "" },
  ]);
});

test("an abnormal docker run close rejects with its teardown failure", async () => {
  const root = await tempRoot();
  const fixture = await fakeDocker(root, {
    run: `process.exit(42);`,
    inspect: `process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1);`,
  });
  const handle = await launch(launcher(fixture, 10), fixture.workspace, "run-abnormal-close");

  await assert.rejects(handle.completion, /Task container could not be confirmed absent/u);
  assert.deepEqual((await readFile(fixture.log, "utf8")).trim().split("\n"), [
    "run", "stop", "inspect", "rm", "inspect",
  ]);
});
