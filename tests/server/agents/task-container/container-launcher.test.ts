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
  options: Readonly<{ run: string; inspect: string }>
): Promise<{ binary: string; log: string; marker: string; workspace: string }> {
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const binary = join(bin, "docker");
  const log = join(root, "docker.log");
  const marker = join(root, "run.pid");
  await mkdir(bin);
  await mkdir(workspace);
  await writeFile(
    binary,
    `#!/usr/bin/env node
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
`,
    { mode: 0o700 }
  );
  await chmod(binary, 0o700);
  return { binary, log, marker, workspace };
}

function launcher(
  fixture: Readonly<{ binary: string; workspace: string }>,
  terminationGraceMs = 20
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

async function launch(target: ContainerAgentLauncher, workspace: string, runId: string) {
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

  assert.doesNotThrow(
    () =>
      new ContainerAgentLauncher({
        ...options,
        image: `sha256:${"a".repeat(64)}`,
      })
  );
  assert.throws(
    () =>
      new ContainerAgentLauncher({
        ...options,
        image: "--network=host",
      }),
    /image is invalid/u
  );
});

test("redacts container context and diagnostics without aborting the run", async () => {
  const credential = "ghp_abcdefghijklmnop";
  const baseContext = context();
  const root = await tempRoot();
  const promptPath = join(root, "redacted-prompt.txt");
  const fixture = await fakeDocker(root, {
    run: `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        fs.writeFileSync(${JSON.stringify(promptPath)}, input);
        process.stderr.write(${JSON.stringify(`Diagnostic contained <${credential}>; keep this.`)});
        const result = {status:"completed",progress:[],result:${JSON.stringify(`Done after ${credential}.`)},proposedChildTasks:[],expectedAgentMinutes:null,phases:[],humanQuestion:null,detail:"Done."};
        process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}) + "\\n");
        process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
      });
    `,
    inspect: `process.stderr.write("Error: No such object\\n"); process.exit(1);`,
  });

  const handle = await launcher(fixture).launch({
    runId: "run-container-redaction",
    wakeReason: "human_assignment",
    context: context({
      projectMemory: "Reference https://github.com and keep this field.",
      task: {
        ...baseContext.task,
        objective: "Rotate the -----BEGIN PRIVATE KEY----- described in the runbook.",
        acceptanceCriteria: "Keep git@github.com:org/repo.git and this field intact.",
      },
      messages: [
        ...baseContext.messages,
        {
          messageId: "message-three",
          cursor: 3,
          author: "human",
          body: `Remove ${credential} from the fixture.`,
          createdAt: "2026-07-19T20:00:00.000Z",
        },
      ],
      nextMessageCursor: 3,
    }),
    workspace: { path: fixture.workspace },
  });

  const outcome = await handle.completion;
  assert.equal(outcome.status, "completed");
  const activity: RuntimeEvent[] = [];
  for await (const event of handle.activity) activity.push(event);
  const prompt = await readFile(promptPath, "utf8");
  assert.match(prompt, /"objective":"Rotate the \[redacted: credential\]"/u);
  assert.match(prompt, /"projectMemory":"Reference https:\/\/github\.com and keep this field\."/u);
  assert.match(prompt, /"acceptanceCriteria":"Keep git@github\.com:org\/repo\.git and this field intact\."/u);
  assert.match(prompt, /Remove \[redacted: credential\] from the fixture\./u);
  assert.doesNotMatch(prompt, new RegExp(credential, "u"));
  assert.deepEqual(
    activity.filter((event) => event.type === "credential_redaction"),
    [
      { type: "credential_redaction", site: "context", patternName: "privateKey", count: 1 },
      { type: "credential_redaction", site: "context", patternName: "prefixedToken", count: 1 },
      { type: "credential_redaction", site: "provider_outcome", patternName: "prefixedToken", count: 1 },
      { type: "credential_redaction", site: "diagnostics", patternName: "prefixedToken", count: 1 },
    ]
  );
  assert.deepEqual(
    activity.find((event) => event.type === "tool_result" && event.name === "diagnostics"),
    {
      type: "tool_result",
      name: "diagnostics",
      output: "Diagnostic contained <[redacted: credential]>; keep this.",
    }
  );
  assert.match(JSON.stringify(outcome), /Done after \[redacted: credential\]/u);
  const log = await readFile(fixture.log, "utf8");
  assert.doesNotMatch(JSON.stringify({ activity, log, outcome, prompt }), new RegExp(credential, "u"));
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
    (error: unknown) =>
      error instanceof AgentProcessError && error.message === "Task container could not be confirmed absent"
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
  await until(
    () => activityEvents.some((event) => event.type === "tool_call" && event.name === "container_attached"),
    "container attachment activity"
  );

  await handle.interrupt("Human interrupted this agent run");
  await assert.rejects(handle.completion, /interrupted directly/u);
  assert.deepEqual((await readFile(fixture.log, "utf8")).trim().split("\n"), [
    "run",
    "stop",
    "inspect",
    "rm",
    "inspect",
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
    "run",
    "stop",
    "inspect",
    "rm",
    "inspect",
  ]);
});
