import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ContainerAgentLauncher,
  DEFAULT_ALLOWED_HOSTS,
  prepareContainerInfrastructure,
  type ContainerInfrastructure,
} from "#server/agents/task-container";
import { AgentProcessError, type AgentLaunchRequest } from "#server/agents/task-worker";
import { TaskWorkspaceManager, WorkspaceScopedLauncher } from "#server/agents/task-workspace";
import {
  agentImage,
  context,
  docker,
  fixtureRepo,
  requireDocker,
  runGit,
  tempRoot,
} from "./helpers.js";

const PROBE = "fetch('https://example.com',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))";

function request(runId: string, taskId: string): AgentLaunchRequest {
  return {
    runId,
    wakeReason: "human_assignment",
    context: context({ taskId }),
  };
}

function launcher(
  image: string,
  infrastructure: ContainerInfrastructure,
  manager: TaskWorkspaceManager,
  options: Readonly<{ hang?: boolean; timeoutMs?: number; terminationGraceMs?: number }> = {},
): WorkspaceScopedLauncher {
  const inner = new ContainerAgentLauncher({
    provider: "codex",
    model: "stub-model",
    image,
    agentCommand: "steward-stub",
    networkName: infrastructure.agentNetwork,
    proxyUrl: infrastructure.proxyUrl,
    ...(options.hang ? { extraContainerEnv: { STEWARD_STUB_MODE: "hang" } } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.terminationGraceMs === undefined ? {} : { terminationGraceMs: options.terminationGraceMs }),
  });
  return new WorkspaceScopedLauncher(inner, manager);
}

function dockerExitCode(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("docker", [...args], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve(0);
      } else if (typeof error.code === "number") {
        resolve(error.code);
      } else {
        reject(new Error(`docker ${args[0]} failed: ${stderr.trim()}`, { cause: error }));
      }
    });
  });
}

async function waitForTaskContainer(containerName: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const output = await docker([
      "ps",
      "--filter",
      "name=steward-task-",
      "--format",
      "{{.Names}}",
    ]);
    if (output.split(/\r?\n/u).includes(containerName)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${containerName}`);
}

async function assertNoTaskContainers(): Promise<void> {
  assert.equal((await docker(["ps", "-aq", "--filter", "label=steward.task"])).trim(), "");
}

test("stub round-trip harvests its commit and removes all transient state", async (t) => {
  await requireDocker();
  const image = await agentImage();
  const infrastructure = await prepareContainerInfrastructure({ image, allowedHosts: DEFAULT_ALLOWED_HOSTS });
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "workspaces");
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });
  const taskId = "container-round-trip";

  const handle = await launcher(image, infrastructure, manager).launch(request("round-trip", taskId));

  assert.equal((await handle.completion).status, "completed");
  assert.match(await runGit(repo, ["show", `task/${taskId}:stub-proof.txt`]), /^stub ran with \d+ prompt bytes\n$/u);
  await assert.rejects(access(manager.workspacePath(taskId)), { code: "ENOENT" });
  await assertNoTaskContainers();
});

test("agent network blocks direct egress and the proxy refuses a non-allowlisted host", async () => {
  await requireDocker();
  const image = await agentImage();
  const infrastructure = await prepareContainerInfrastructure({ image, allowedHosts: DEFAULT_ALLOWED_HOSTS });

  assert.equal(await dockerExitCode([
    "run",
    "--rm",
    "--network",
    infrastructure.agentNetwork,
    image,
    "node",
    "-e",
    PROBE,
  ]), 1);
  assert.equal(await dockerExitCode([
    "run",
    "--rm",
    "--network",
    infrastructure.agentNetwork,
    "-e",
    `HTTPS_PROXY=${infrastructure.proxyUrl}`,
    image,
    "node",
    "-e",
    PROBE,
  ]), 1);
});

test("an externally killed task container fails uneventfully and retains its workspace", async (t) => {
  await requireDocker();
  const image = await agentImage();
  const infrastructure = await prepareContainerInfrastructure({ image, allowedHosts: DEFAULT_ALLOWED_HOSTS });
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "workspaces");
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });
  const taskId = "container-killed";
  const runId = "killed";
  const containerName = `steward-task-${runId}`;
  const target = launcher(image, infrastructure, manager, {
    hang: true,
    timeoutMs: 120_000,
    terminationGraceMs: 250,
  });

  const handle = await target.launch(request(runId, taskId));
  const rejected = assert.rejects(handle.completion, (error: unknown) => error instanceof AgentProcessError);
  await waitForTaskContainer(containerName);
  await docker(["kill", containerName]);

  await rejected;
  const retained = (await readdir(workspaceRoot)).filter((name) => name.startsWith(`retained-${taskId}-`));
  assert.equal(retained.length, 1);
  await assertNoTaskContainers();
});

test("interrupt returns only after the task container is absent", async (t) => {
  await requireDocker();
  const image = await agentImage();
  const infrastructure = await prepareContainerInfrastructure({ image, allowedHosts: DEFAULT_ALLOWED_HOSTS });
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "workspaces"), repositoryPath: repo });
  const taskId = "container-interrupted";
  const runId = "interrupted";
  const containerName = `steward-task-${runId}`;
  const target = launcher(image, infrastructure, manager, {
    hang: true,
    timeoutMs: 120_000,
    terminationGraceMs: 250,
  });

  const handle = await target.launch(request(runId, taskId));
  const rejected = assert.rejects(handle.completion, (error: unknown) => error instanceof AgentProcessError);
  await waitForTaskContainer(containerName);
  await handle.interrupt("test stop");

  assert.equal((await docker(["ps", "-q", "--filter", `name=${containerName}`])).trim(), "");
  await rejected;
  await assertNoTaskContainers();
});
