import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "#server/agents/task-container";
import type { BoundedAgentContext } from "#server/agents/task-worker";

export function docker(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", [...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args[0]} failed: ${stderr}`));
      else resolve(stdout);
    });
  });
}

export async function requireDocker(): Promise<void> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    assert.fail(`Docker daemon unreachable — start Docker Desktop before npm run test:container (${String(error)})`);
  }
}

export async function agentImage(): Promise<string> {
  const tag = await computeAgentImageTag(process.cwd());
  const image = `${AGENT_IMAGE_REPOSITORY}:${tag}`;
  await docker(["image", "inspect", image]);
  return image;
}

/** mkdtemp under os.tmpdir(). */
export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steward-container-"));
}

/** execFile git with cwd; rejects with trimmed stderr. */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim()));
      else resolve(stdout);
    });
  });
}

/** git init -b main + one commit. Returns the repo path. */
export async function fixtureRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repo]);
  await writeFile(join(repo, "readme.md"), "hello\n");
  await runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return repo;
}

export function context(overrides: Partial<BoundedAgentContext> = {}): BoundedAgentContext {
  return {
    apiVersion: 1,
    projectId: "container-project",
    agentId: "container-engineer",
    taskId: "container-task",
    intake: false,
    design: false,
    mission: {
      role: "engineer",
      area: "Container execution",
      mission: "Implement the assigned task in the writable task workspace.",
    },
    projectMemory: "Task work is isolated in a per-run container and workspace.",
    task: {
      kind: "work",
      requiredRole: null,
      title: "Exercise container execution",
      objective: "Prove the agent container can complete work in its task workspace.",
      acceptanceCriteria: "The stub commits its proof file and the run is cleaned up.",
      version: 1,
      expectedAgentMinutes: null,
      phases: [],
    },
    areaMemory: [],
    parentEvidence: null,
    messagesSinceCursor: null,
    nextMessageCursor: 0,
    messages: [],
    triggerQuestion: null,
    openQuestions: [],
    workspaceRefs: [],
    workflow: null,
    ...overrides,
  };
}
