# Campaign 2 — Worktree + Container Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each task runs in a disposable Docker container against its own isolated git clone, behind the existing `AgentLauncher`/`TaskFleetWorkerFactory` seam, with a proxy-enforced egress allowlist — proven by a stub-runtime e2e; lanes stay untouched as the local-process path.

**Architecture:** A shared envelope module is extracted from `ContainedCliAgentLauncher`; a new `TaskWorkspaceManager` clones per task and harvests branches back by fetch; a new `ContainerAgentLauncher` shells out to the `docker` CLI (one `docker run --rm` per launch); a `WorkspaceScopedLauncher` decorator wires workspace lifecycle around any launcher; fleet config v2 adds an optional `runtime: "container"` lane kind. An in-repo Node CONNECT proxy on a Docker-internal network is the only egress path.

**Tech Stack:** Node 24 / TypeScript, `node:test` on compiled `.test-dist` output, `docker` CLI (Docker Desktop on macOS), git, alpine-based multi-stage Dockerfile.

**Spec:** `docs/superpowers/specs/2026-08-17-worktree-container-execution-design.md`

## Global Constraints

- **No new npm dependencies.** The repo has exactly 3 runtime deps (`react`, `react-dom`, `lucide-react`); docker and git are invoked via `child_process`, the proxy is hand-written on `node:http`/`node:net`.
- **Runtime tests are `node:test`**, TS under `tests/`, compiled by `tsc -p tsconfig.test.json` into `.test-dist/`, importing production code via `#server/...` subpath imports that resolve into `build/` (so `npm run build:runtime` must precede test compile — the npm scripts already do this).
- **Docker-gated tests live in `tests/container/`** and run ONLY via `npm run test:container`. They must never run under `npm run test:runtime`, and they fail loudly (never skip silently) when the daemon is unreachable.
- **The board token never enters a container.** Container env = model credentials + proxy vars only, via the existing from-scratch allowlist pattern.
- **Containers run non-root** (`--user node`), `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 4g`, `--pids-limit 512`, `--rm`, labeled `steward.task=<taskId>`.
- **Config is closed-world JSON** (`exact()` parser); all new fleet fields are optional so v1 configs parse unchanged. No YAML.
- **Behavior of existing local-process lanes must not change.** All existing tests pass unmodified except where a task explicitly says otherwise.
- **Workspace clones use `git clone --no-hardlinks`** (never plain local clone — hardlinked objects would let a container corrupt main-repo object files); harvest is host-side `git fetch` from the clone (executes no hooks from the fetched side).
- **Commit after each task** on branch `campaign-2-container-execution`; never commit with failing tests.
- **Sandbox note for implementers (Codex):** your sandbox has no network and no Docker socket. Write the code and the unit tests, and run the dockerless suites (`npm run test:runtime`). Steps marked **[orchestrator verify]** (image builds, docker-gated suites) are executed by the orchestrating session after your task returns — state in your report that you did not run them.

## File Map

| File | Task | Responsibility |
| --- | --- | --- |
| `src/server/agents/task-worker/agent-envelope.ts` (create) | 1 | Shared envelope/prompt/env/args/activity primitives for both launchers |
| `src/server/agents/task-worker/contained-cli-launcher.ts` (modify) | 1 | Keep class + process-group machinery; import shared code; re-export `RESULT_SCHEMA`/`AgentProcessError` |
| `src/server/agents/task-worker/types.ts` (modify) | 2 | `AgentLaunchRequest.workspace?` |
| `src/server/agents/task-workspace/manager.ts`, `scoped-launcher.ts`, `index.ts` (create) | 2 | Per-task clone/branch/harvest/remove/retain; launcher decorator |
| `src/server/agents/egress-proxy/proxy.ts`, `main.ts` (create) | 3 | CONNECT-only allowlist proxy + container entrypoint |
| `Dockerfile` (modify), `deploy/agent/entrypoint.sh`, `deploy/agent/stub-codex.mjs`, `scripts/build-agent-image.mjs` (create) | 4 | `deps` stage split, `agent` target, stub runtime, lockfile-keyed image build |
| `src/server/agents/task-container/image-tag.ts` (create) | 4 | Deterministic agent-image tag shared by build script and runtime |
| `src/server/agents/task-container/arguments.ts`, `container-launcher.ts`, `index.ts` (create) | 5 | Pure `docker run` argument builder; `ContainerAgentLauncher` |
| `src/server/agents/task-container/infrastructure.ts` (create) | 6 | Daemon check, networks, proxy container, orphan sweep |
| `tests/container/*.test.ts` (create), `package.json` (modify) | 6 | Docker-gated integration suite + `test:container`/`build:agent-image` scripts |
| `src/server/agents/task-fleet/types.ts`, `config.ts`, `runtime.ts` (modify) | 7 | Config v2 (`runtime`/`container` fields); container worker factory branch + image-identity pinning |
| `tests/container/board-e2e.test.ts` (create), `orchestrator-roadmap.md` (modify) | 8 | Exit-criterion e2e; roadmap status update |

---

### Task 1: Extract the shared agent-envelope module

**Files:**
- Create: `src/server/agents/task-worker/agent-envelope.ts`
- Modify: `src/server/agents/task-worker/contained-cli-launcher.ts`
- Test: existing `tests/server/agents/task-worker/contained-cli-launcher.test.ts` (unchanged — it is the behavioral lock)

This is a behavior-preserving move. `contained-cli-launcher.ts` currently owns code both launchers need. Move the following, verbatim except where a new signature is given, into `agent-envelope.ts`, and make `contained-cli-launcher.ts` import them; delete the originals there:

- `RESULT_SCHEMA` (and its imports from `#shared/task-board-contract`)
- `SECRET_PATTERNS`, `assertCredentialSafe`
- `AgentProcessError`
- `ActivityChannel`, `MAX_QUEUED_ACTIVITY`
- `boundedInteger`, `configText`, `delay`
- `providerEnvironment`
- `decodeJson`, `outputObject`, `providerResult`, `structuredOutcome` (needs `parseAgentRunOutcome` import from `./schema.js`)
- `role` → rename to exported `agentRole(request: AgentLaunchRequest): AgentRole`
- `prompt` → rename to exported `agentPrompt(request: AgentLaunchRequest): string`
- `codexArgs`/`claudeArgs` → re-signature as pure functions of explicit inputs (the container launcher passes a different working directory and schema path):

```typescript
export type AgentProvider = "codex" | "claude";

export interface ProviderArgumentOptions {
  readonly model: string;
  readonly workingDirectory: string;
  /** Absolute path of agent-result.schema.json as seen by the CLI process (codex only). */
  readonly schemaPath: string;
  /** Claude only: pass --bare when explicit API-key auth is available. */
  readonly bareApiKey: boolean;
}

export function codexProviderArgs(options: ProviderArgumentOptions, fixedRole: AgentRole): readonly string[]
export function claudeProviderArgs(options: ProviderArgumentOptions, fixedRole: AgentRole): readonly string[]
```

Body changes inside the moved functions, exactly these: `options.workingDirectory` stays; `RESULT_SCHEMA_PATH` becomes `options.schemaPath`; `role(request)` becomes the `fixedRole` parameter; the claude `--bare` condition `typeof options.environment?.ANTHROPIC_API_KEY === "string"` becomes `options.bareApiKey`.

`contained-cli-launcher.ts` keeps: `RESULT_SCHEMA_PATH`, `MAX_STDOUT_BYTES`, `MAX_STDERR_BYTES`, `GROUP_POLL_MS`, `groupPresent`, `signalGroup`, `terminateGroup`, `ContainedCliAgentLauncherOptions`, and the `ContainedCliAgentLauncher` class. In `launch()`, build args as:

```typescript
const fixedRole = agentRole(request);
const argumentOptions = {
  model: this.#options.model,
  workingDirectory: this.#options.workingDirectory,
  schemaPath: RESULT_SCHEMA_PATH,
  bareApiKey: typeof this.#options.environment.ANTHROPIC_API_KEY === "string",
};
const args = this.#options.provider === "codex"
  ? codexProviderArgs(argumentOptions, fixedRole)
  : claudeProviderArgs(argumentOptions, fixedRole);
const stdin = agentPrompt(request);
```

Compatibility re-exports at the bottom of `contained-cli-launcher.ts` (the schema-writer script and existing tests import from this module path):

```typescript
export { RESULT_SCHEMA, AgentProcessError } from "./agent-envelope.js";
```

- [ ] **Step 1: Confirm the behavioral lock is green before touching anything**

Run: `npm run test:runtime`
Expected: PASS (this is the baseline; if it fails, stop and report).

- [ ] **Step 2: Create `agent-envelope.ts` and slim `contained-cli-launcher.ts` as specified above**

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:runtime`
Expected: clean.

- [ ] **Step 4: Run the full runtime suite — the moved code must behave identically**

Run: `npm run test:runtime`
Expected: PASS, including `contained-cli-launcher.test.ts` (which asserts `RESULT_SCHEMA` still exports from the launcher module and that the generated `build/.../agent-result.schema.json` matches) — and `scripts/write-agent-result-schema.mjs` must keep working, which `build:runtime` (invoked by `test:runtime`) proves.

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/task-worker/agent-envelope.ts src/server/agents/task-worker/contained-cli-launcher.ts
git commit -m "refactor: extract shared agent-envelope module from the contained CLI launcher"
```

---

### Task 2: TaskWorkspaceManager + workspace-scoped launcher

**Files:**
- Create: `src/server/agents/task-workspace/manager.ts`
- Create: `src/server/agents/task-workspace/scoped-launcher.ts`
- Create: `src/server/agents/task-workspace/index.ts`
- Modify: `src/server/agents/task-worker/types.ts` (add `workspace` to `AgentLaunchRequest`)
- Modify: `package.json` (subpath imports)
- Test: `tests/server/agents/task-workspace/manager.test.ts`, `tests/server/agents/task-workspace/scoped-launcher.test.ts`

**Interfaces:**
- Consumes: `AgentLauncher`, `AgentLaunchRequest`, `AgentRunHandle`, `AgentRunOutcome` from `#server/agents/task-worker/types`; `AgentProcessError` from Task 1's module.
- Produces (Tasks 5, 7, 8 rely on these exact shapes):

```typescript
// types.ts addition
export interface AgentWorkspace { readonly path: string }
export interface AgentLaunchRequest {
  readonly runId: string;
  readonly wakeReason: TaskWakeReason;
  readonly context: BoundedAgentContext;
  /** Per-launch working tree. Absent for local-process lanes constructed with a fixed directory. */
  readonly workspace?: AgentWorkspace;
}

// manager.ts
export interface TaskWorkspaceManagerOptions {
  /** Directory that holds one sub-directory per task workspace. Created if missing. Absolute. */
  readonly workspaceRoot: string;
  /** The source repository workspaces are cloned from and harvested into. Absolute. */
  readonly repositoryPath: string;
  /** Failed workspaces kept for debugging; oldest pruned beyond this. Default 5. */
  readonly retainedLimit?: number;
}
export class TaskWorkspaceManager {
  constructor(options: TaskWorkspaceManagerOptions);
  /** Fresh clone + branch task/<key>; an existing dir for key is removed first (crash leftovers). Returns the workspace path. */
  create(key: string, baseRef?: string): Promise<string>;
  /** Host-side `git fetch <workspace> +task/<key>:task/<key>` into repositoryPath. */
  harvest(key: string): Promise<void>;
  /** Recursive delete; missing dir is success. */
  remove(key: string): Promise<void>;
  /** Rename to retained-<key>-<epochMs> and prune retained dirs beyond retainedLimit (oldest first, by name). */
  retain(key: string): Promise<void>;
  workspacePath(key: string): string;
}

// scoped-launcher.ts
export class WorkspaceScopedLauncher implements AgentLauncher {
  constructor(inner: AgentLauncher, manager: TaskWorkspaceManager);
  launch(request: AgentLaunchRequest): Promise<AgentRunHandle>;
}
```

`manager.ts` implementation:

```typescript
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { IDENTIFIER_PATTERN } from "#shared/task-board-contract";

const KEY = new RegExp(IDENTIFIER_PATTERN, "u");
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETAINED_LIMIT = 5;

export class TaskWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskWorkspaceError";
  }
}

function git(cwd: string | null, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      ...(cwd === null ? {} : { cwd }),
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new TaskWorkspaceError(`git ${args[0]} failed: ${stderr.slice(0, 2_000)}`, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}
```

Class body: the constructor validates both paths with `isAbsolute` (throw `TaskWorkspaceError` otherwise) and bounds `retainedLimit` to 0–64. `#key(key)` validates against `KEY` and rejects keys starting with `retained-` (they would collide with the retention namespace). Then:

```typescript
  workspacePath(key: string): string {
    return join(this.#workspaceRoot, this.#key(key));
  }

  async create(key: string, baseRef?: string): Promise<string> {
    const path = this.workspacePath(key);
    await mkdir(this.#workspaceRoot, { recursive: true });
    await rm(path, { recursive: true, force: true });
    await git(null, ["clone", "--no-hardlinks", this.#repositoryPath, path]);
    if (baseRef !== undefined) await git(path, ["switch", "--detach", baseRef]);
    await git(path, ["switch", "-c", `task/${this.#key(key)}`]);
    return path;
  }

  async harvest(key: string): Promise<void> {
    const branch = `task/${this.#key(key)}`;
    await git(this.#repositoryPath, ["fetch", this.workspacePath(key), `+${branch}:${branch}`]);
  }

  async remove(key: string): Promise<void> {
    await rm(this.workspacePath(key), { recursive: true, force: true });
  }

  async retain(key: string): Promise<void> {
    const path = this.workspacePath(key);
    try {
      await stat(path);
    } catch {
      return; // nothing to retain
    }
    await rename(path, join(this.#workspaceRoot, `retained-${this.#key(key)}-${Date.now()}`));
    const entries = (await readdir(this.#workspaceRoot)).filter((name) => name.startsWith("retained-")).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - this.#retainedLimit))) {
      await rm(join(this.#workspaceRoot, name), { recursive: true, force: true });
    }
  }
```

(`retained-<key>-<epochMs>` sorts lexicographically ≈ chronologically at same key; sorting the whole `retained-` set by name is sufficient for a debugging cache — note this in a code comment only if the sort choice needs defending, otherwise not at all.)

`scoped-launcher.ts` implementation — the workspace key is `request.context.taskId` (always a non-empty string in `BoundedAgentContext`):

```typescript
import type { AgentLauncher, AgentLaunchRequest, AgentRunHandle, AgentRunOutcome } from "#server/agents/task-worker/types";
import { TaskWorkspaceError } from "./manager.js";
import type { TaskWorkspaceManager } from "./manager.js";

export class WorkspaceScopedLauncher implements AgentLauncher {
  readonly #inner: AgentLauncher;
  readonly #manager: TaskWorkspaceManager;

  constructor(inner: AgentLauncher, manager: TaskWorkspaceManager) {
    this.#inner = inner;
    this.#manager = manager;
  }

  async launch(request: AgentLaunchRequest): Promise<AgentRunHandle> {
    const key = request.context.taskId;
    const path = await this.#manager.create(key);
    let handle: AgentRunHandle;
    try {
      handle = await this.#inner.launch({ ...request, workspace: { path } });
    } catch (error) {
      await this.#manager.retain(key);
      throw error;
    }
    const completion = handle.completion.then(
      async (outcome: AgentRunOutcome) => {
        if (outcome.status === "completed") {
          try {
            await this.#manager.harvest(key);
          } catch (error) {
            await this.#manager.retain(key);
            throw new TaskWorkspaceError("Run completed but its branch could not be harvested", { cause: error });
          }
          await this.#manager.remove(key);
        } else {
          await this.#manager.retain(key);
        }
        return outcome;
      },
      async (error: unknown) => {
        await this.#manager.retain(key);
        throw error;
      },
    );
    return Object.freeze({ completion, activity: handle.activity, interrupt: (reason: string) => handle.interrupt(reason) });
  }
}
```

(Non-`completed` terminal statuses — `failed`, `waiting_for_human` — retain the workspace; a follow-up wake gets a fresh clone, continuity flows through board messages. This matches the spec's retention rule.)

`index.ts`:

```typescript
export { TaskWorkspaceManager, TaskWorkspaceError } from "./manager.js";
export type { TaskWorkspaceManagerOptions } from "./manager.js";
export { WorkspaceScopedLauncher } from "./scoped-launcher.js";
```

`package.json` imports additions (alongside the existing `#server/agents/task-worker` entries):

```json
"#server/agents/task-workspace": "./build/server/agents/task-workspace/index.js",
"#server/agents/task-workspace/*": "./build/server/agents/task-workspace/*.js",
```

- [ ] **Step 1: Write the failing manager tests** — `tests/server/agents/task-workspace/manager.test.ts`. Reuse `tempRoot` from `../task-worker/helpers.js`. Build a fixture repo with `execFile` git commands (init, config user, one committed file). Tests:

```typescript
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TaskWorkspaceManager, TaskWorkspaceError } from "#server/agents/task-workspace";
import { tempRoot } from "../task-worker/helpers.js";

function run(cwd: string, command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function fixtureRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await run(root, "git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "readme.md"), "hello\n");
  await run(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await run(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return repo;
}

test("create clones without hardlinks, branches task/<key>, and is reset-idempotent", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = await manager.create("task-a");
  assert.equal(path, manager.workspacePath("task-a"));
  await access(join(path, ".git"));
  assert.equal((await run(path, "git", ["branch", "--show-current"])).trim(), "task/task-a");
  await writeFile(join(path, "leftover.txt"), "stale");
  const again = await manager.create("task-a");
  await assert.rejects(access(join(again, "leftover.txt")));
});

test("harvest publishes the task branch into the source repo and force-updates on re-harvest", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = await manager.create("task-b");
  await writeFile(join(path, "work.txt"), "done\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "work"]);
  await manager.harvest("task-b");
  const shown = await run(repo, "git", ["show", "task/task-b:work.txt"]);
  assert.equal(shown, "done\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "--amend", "-m", "rework"]);
  await manager.harvest("task-b");
  assert.match(await run(repo, "git", ["log", "-1", "--format=%s", "task/task-b"]), /rework/u);
});

test("a hook planted inside the workspace never executes on the host during harvest", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = await manager.create("task-c");
  const marker = join(root, "hook-ran");
  for (const hook of ["post-checkout", "post-commit", "reference-transaction", "post-update"]) {
    await writeFile(join(path, ".git", "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  await writeFile(join(path, "work.txt"), "x\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "work.txt"]);
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "x"]);
  await manager.harvest("task-c");
  await assert.rejects(access(marker), undefined, "workspace hooks must not run on the host");
});

test("remove is idempotent, retain caps the debugging cache, and bad inputs are rejected", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo, retainedLimit: 1 });
  await manager.remove("never-created");
  await manager.create("task-d");
  await manager.retain("task-d");
  await manager.create("task-e");
  await manager.retain("task-e");
  const { readdir } = await import("node:fs/promises");
  const retained = (await readdir(join(root, "ws"))).filter((name) => name.startsWith("retained-"));
  assert.equal(retained.length, 1);
  assert.match(retained[0] ?? "", /^retained-task-e-/u);
  await manager.retain("task-d"); // already gone — no-op
  assert.throws(() => new TaskWorkspaceManager({ workspaceRoot: "relative", repositoryPath: repo }), TaskWorkspaceError);
  await assert.rejects(manager.create("../escape"), TaskWorkspaceError);
  await assert.rejects(manager.create("retained-x"), TaskWorkspaceError);
});
```

- [ ] **Step 2: Write the failing scoped-launcher tests** — `tests/server/agents/task-workspace/scoped-launcher.test.ts`, using `FakeLauncher`, `completedOutcome`, `context`, `tempRoot` from `../task-worker/helpers.js` (read that file first for exact shapes; `FakeLauncher` records `requests` and pops queued `outcomes`). Assert: (a) inner launcher receives `workspace.path` equal to `manager.workspacePath(taskId)` and the directory exists at launch time; (b) a `completed` outcome harvests the branch into the fixture repo and removes the workspace dir; (c) a `failed` outcome retains (dir renamed to `retained-…`, branch NOT in the fixture repo); (d) inner `launch` throwing retains and rethrows; (e) `interrupt` passes through to the inner handle.

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:runtime`
Expected: FAIL — new test files cannot resolve `#server/agents/task-workspace`.

- [ ] **Step 4: Implement** `manager.ts`, `scoped-launcher.ts`, `index.ts`, the `types.ts` addition, and the `package.json` imports as specified above.

- [ ] **Step 5: Run to verify pass**

Run: `npm run typecheck:runtime && npm run test:runtime`
Expected: PASS, including all pre-existing suites.

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/task-workspace tests/server/agents/task-workspace src/server/agents/task-worker/types.ts package.json
git commit -m "feat: per-task isolated git workspaces behind a workspace-scoped launcher"
```

---

### Task 3: Egress proxy (CONNECT-only allowlist)

**Files:**
- Create: `src/server/agents/egress-proxy/proxy.ts`
- Create: `src/server/agents/egress-proxy/main.ts`
- Modify: `package.json` (subpath imports: `"#server/agents/egress-proxy/*": "./build/server/agents/egress-proxy/*.js"`)
- Test: `tests/server/agents/egress-proxy/proxy.test.ts`

**Interfaces:**
- Produces (Task 6's infrastructure and tests rely on):

```typescript
export interface EgressProxyOptions {
  readonly host: string;               // "0.0.0.0" in the container, "127.0.0.1" in tests
  readonly port: number;               // 0 = ephemeral (tests)
  readonly allowedHosts: readonly string[]; // exact hostnames, lowercase
  readonly allowedPorts?: readonly number[]; // default [443]
}
export interface EgressProxy {
  readonly port: number;
  close(): Promise<void>;
}
export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy>
```

`proxy.ts` implementation — `node:http` server that ONLY honors `CONNECT` (regular requests get `405`), destination must match the allowlist exactly (no suffix wildcards in v1 — every needed API host is known) and use an allowed port:

```typescript
import { createServer } from "node:http";
import { connect } from "node:net";

const DEFAULT_ALLOWED_PORTS = Object.freeze([443]);
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;

export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allowedHosts = new Set(options.allowedHosts.map((host) => {
    if (!HOSTNAME.test(host)) throw new Error(`Egress allowlist entry is invalid: ${host}`);
    return host;
  }));
  const allowedPorts = new Set(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
  const server = createServer((request, response) => {
    response.writeHead(405, { connection: "close" }).end();
  });
  server.on("connect", (request, clientSocket) => {
    const target = request.url ?? "";
    const match = /^([a-z0-9.-]+):(\d{1,5})$/u.exec(target.toLowerCase());
    const host = match?.[1];
    const port = match === null ? null : Number(match[2]);
    if (host === undefined || port === null || !allowedHosts.has(host) || !allowedPorts.has(port)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", drop);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Egress proxy failed to bind"));
        return;
      }
      resolve(Object.freeze({
        port: address.port,
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      }));
    });
  });
}
```

`main.ts` — container entrypoint, config from env, logs one startup line to stdout:

```typescript
import { startEgressProxy } from "./proxy.js";

const hosts = (process.env.STEWARD_EGRESS_ALLOWED_HOSTS ?? "")
  .split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
if (hosts.length === 0) throw new Error("STEWARD_EGRESS_ALLOWED_HOSTS must list at least one hostname");
const port = Number(process.env.STEWARD_EGRESS_PORT ?? "3128");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("STEWARD_EGRESS_PORT is invalid");
const proxy = await startEgressProxy({ host: "0.0.0.0", port, allowedHosts: hosts });
console.log(`steward-egress-proxy listening on ${proxy.port} for ${hosts.join(",")}`);
process.once("SIGTERM", () => { void proxy.close().then(() => process.exit(0)); });
```

- [ ] **Step 1: Write the failing tests** — `tests/server/agents/egress-proxy/proxy.test.ts`. Use a local `node:net` echo server as the "upstream", allowlist `localhost` with `allowedPorts: [echoPort]`, and a raw socket speaking CONNECT:

```typescript
import assert from "node:assert/strict";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import test from "node:test";
import { startEgressProxy } from "#server/agents/egress-proxy/proxy";

function tcpEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createTcpServer((socket) => socket.pipe(socket));
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as AddressInfo).port,
      close: () => server.close(),
    }));
  });
}

function connectThrough(proxyPort: number, target: string): Promise<{ head: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`);
    });
    socket.once("data", (chunk) => resolve({ head: chunk.toString("utf8"), socket }));
    socket.once("error", reject);
  });
}

test("allows CONNECT to an allowlisted host:port and relays bytes", async () => {
  const echo = await tcpEcho();
  const proxy = await startEgressProxy({ host: "127.0.0.1", port: 0, allowedHosts: ["localhost"], allowedPorts: [echo.port] });
  try {
    const { head, socket } = await connectThrough(proxy.port, `localhost:${echo.port}`);
    assert.match(head, /^HTTP\/1\.1 200/u);
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
      socket.write("ping");
    });
    assert.equal(reply, "ping");
    socket.destroy();
  } finally {
    await proxy.close();
    echo.close();
  }
});

test("refuses non-allowlisted hosts, non-allowlisted ports, and non-CONNECT requests", async () => {
  const echo = await tcpEcho();
  const proxy = await startEgressProxy({ host: "127.0.0.1", port: 0, allowedHosts: ["localhost"], allowedPorts: [echo.port] });
  try {
    assert.match((await connectThrough(proxy.port, "evil.example:443")).head, /^HTTP\/1\.1 403/u);
    assert.match((await connectThrough(proxy.port, `localhost:${echo.port + 1}`)).head, /^HTTP\/1\.1 403/u);
    const plain = await fetch(`http://127.0.0.1:${proxy.port}/anything`).catch(() => null);
    assert.equal(plain?.status, 405);
  } finally {
    await proxy.close();
    echo.close();
  }
});

test("rejects an invalid allowlist entry at startup", async () => {
  await assert.rejects(
    startEgressProxy({ host: "127.0.0.1", port: 0, allowedHosts: ["Bad Host!"] }),
    /allowlist entry is invalid/u,
  );
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test:runtime` → FAIL (unresolvable import).
- [ ] **Step 3: Implement** `proxy.ts`, `main.ts`, `package.json` imports.
- [ ] **Step 4: Run to verify pass** — `npm run typecheck:runtime && npm run test:runtime` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/agents/egress-proxy tests/server/agents/egress-proxy package.json
git commit -m "feat: CONNECT-only egress proxy with a hostname allowlist"
```

---

### Task 4: Dockerfile `agent` target, stub runtime, image build script

**Files:**
- Modify: `Dockerfile`
- Create: `deploy/agent/entrypoint.sh`, `deploy/agent/stub-codex.mjs`
- Create: `scripts/build-agent-image.mjs`
- Create: `src/server/agents/task-container/image-tag.ts` (+ `index.ts` exporting it; more exports join in Task 5)
- Modify: `package.json` (script `"build:agent-image": "npm run build:runtime && node scripts/build-agent-image.mjs"`, imports `"#server/agents/task-container": "./build/server/agents/task-container/index.js"`, `"#server/agents/task-container/*": "./build/server/agents/task-container/*.js"`)
- Test: `tests/server/agents/task-container/image-tag.test.ts` (dockerless); image build itself is **[orchestrator verify]**

**Interfaces:**
- Produces (Tasks 5–8 rely on): image name `steward-agent:<tag>`; labels `steward.cli.codex`, `steward.cli.claude`; stub at `/usr/local/bin/steward-stub`; baked schema at `/opt/steward/agent-result.schema.json`; baked deps at `/opt/steward/node_modules`; and

```typescript
// image-tag.ts
/** sha256 over package-lock.json, Dockerfile, and deploy/agent/* (name-prefixed), first 12 hex. */
export function computeAgentImageTag(rootDirectory: string): Promise<string>
export const AGENT_IMAGE_REPOSITORY = "steward-agent";
```

`image-tag.ts`:

```typescript
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const AGENT_IMAGE_REPOSITORY = "steward-agent";

export async function computeAgentImageTag(rootDirectory: string): Promise<string> {
  const hash = createHash("sha256");
  const agentDir = join(rootDirectory, "deploy", "agent");
  const files = [
    join(rootDirectory, "package-lock.json"),
    join(rootDirectory, "Dockerfile"),
    ...(await readdir(agentDir)).sort().map((name) => join(agentDir, name)),
  ];
  for (const file of files) {
    hash.update(file.slice(rootDirectory.length));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}
```

New `Dockerfile` (full content — replaces the current file; `build` and `runtime` stages keep their names and observable behavior):

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build

COPY . .
RUN npm run build

FROM caddy:2-alpine AS caddy

FROM node:24-alpine AS runtime

RUN apk add --no-cache su-exec tini

WORKDIR /app

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/build ./build
COPY --from=build /build/skills ./skills

RUN mkdir -p /srv/steward /var/lib/steward/private \
  && chown -R node:node /var/lib/steward \
  && chmod 0700 /var/lib/steward /var/lib/steward/private

COPY --from=build /build/dist /srv/steward
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/entrypoint.sh /app/deploy/entrypoint.sh

ENV NODE_ENV=production \
    STEWARD_TASK_BOARD_DB_PATH=/var/lib/steward/private/board.sqlite \
    STEWARD_TASK_BOARD_HOST=127.0.0.1 \
    STEWARD_TASK_BOARD_PORT=4318

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD wget -q -T 2 -O /dev/null http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "-g", "--", "/app/deploy/entrypoint.sh"]

FROM node:24-alpine AS agent

ARG CODEX_CLI_VERSION
ARG CLAUDE_CLI_VERSION

RUN apk add --no-cache git tini

RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}"

LABEL steward.cli.codex="${CODEX_CLI_VERSION}" \
      steward.cli.claude="${CLAUDE_CLI_VERSION}"

COPY --from=deps /build/node_modules /opt/steward/node_modules
COPY --from=build /build/build /opt/steward/build
COPY --from=build /build/build/server/agents/task-worker/agent-result.schema.json /opt/steward/agent-result.schema.json
COPY --chmod=0755 deploy/agent/stub-codex.mjs /usr/local/bin/steward-stub
COPY --chmod=0755 deploy/agent/entrypoint.sh /opt/steward/agent-entrypoint.sh

ENTRYPOINT ["/sbin/tini", "-g", "--", "/opt/steward/agent-entrypoint.sh"]
```

`deploy/agent/entrypoint.sh` — link the baked dependency tree into a mounted workspace whose lockfile matches (the mount is a fresh clone with no `node_modules`):

```sh
#!/bin/sh
set -eu
if [ -f /workspace/package.json ] && [ ! -e /workspace/node_modules ]; then
  ln -s /opt/steward/node_modules /workspace/node_modules
fi
exec "$@"
```

`deploy/agent/stub-codex.mjs` — a deterministic fake codex: accepts and ignores codex-style argv, reads the whole prompt from stdin, then behaves per `STEWARD_STUB_MODE` (`success` default | `invalid` | `hang` | `fail`). In `success` mode it commits a proof file on the current branch (proving the writable mounted workspace) and emits a codex-shaped JSONL envelope:

```javascript
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const mode = process.env.STEWARD_STUB_MODE ?? "success";
  if (mode === "hang") return; // never exits; the launcher's timeout/stop path reaps it
  if (mode === "fail") process.exit(2);
  if (mode === "invalid") {
    process.stdout.write("this is not a codex event stream\n");
    process.exit(0);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.name=steward-stub", "-c", "user.email=stub@steward.local", ...args], { stdio: "pipe" });
  writeFileSync("stub-proof.txt", `stub ran with ${input.length} prompt bytes\n`);
  git("add", "stub-proof.txt");
  git("commit", "-m", "stub: proof of containerized workspace execution");
  const result = {
    status: "completed",
    progress: ["Stub executed inside the task container."],
    result: "Stub committed stub-proof.txt on the task branch.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: null,
    workflowPlan: null,
    detail: "Deterministic stub run for container execution tests.",
  };
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
});
```

`scripts/build-agent-image.mjs` — resolve CLI versions, compute the tag, skip when present:

```javascript
import { execFileSync } from "node:child_process";
import { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "../build/server/agents/task-container/image-tag.js";

const root = new URL("..", import.meta.url).pathname;
const tag = await computeAgentImageTag(root);
const image = `${AGENT_IMAGE_REPOSITORY}:${tag}`;

try {
  execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  console.log(`agent image up to date: ${image}`);
  process.exit(0);
} catch {
  // fall through to build
}

const version = (pkg) => execFileSync("npm", ["view", pkg, "version"], { encoding: "utf8" }).trim();
const codexVersion = version("@openai/codex");
const claudeVersion = version("@anthropic-ai/claude-code");
console.log(`building ${image} (codex ${codexVersion}, claude ${claudeVersion})`);
execFileSync("docker", [
  "build", "--target", "agent",
  "--build-arg", `CODEX_CLI_VERSION=${codexVersion}`,
  "--build-arg", `CLAUDE_CLI_VERSION=${claudeVersion}`,
  "-t", image, root,
], { stdio: "inherit" });
```

- [ ] **Step 1: Write the failing tag test** — `tests/server/agents/task-container/image-tag.test.ts`: create a temp dir with fake `package-lock.json`, `Dockerfile`, `deploy/agent/a.sh`; assert the tag is 12 lowercase hex chars, stable across calls, changes when `package-lock.json` changes, and changes when a `deploy/agent` file changes.
- [ ] **Step 2: Run to verify failure** — `npm run test:runtime` → FAIL.
- [ ] **Step 3: Implement** all files above.
- [ ] **Step 4: Run dockerless suites** — `npm run typecheck:runtime && npm run test:runtime` → PASS.
- [ ] **Step 5 [orchestrator verify]: Build both images**

Run: `docker build --target runtime -t steward-prod-check .` — prod target still builds.
Run: `npm run build:agent-image` — agent image builds; re-run prints `agent image up to date` (this is the tag-skip proof).
Run: `docker run --rm -e STEWARD_STUB_MODE=fail steward-agent:<tag> steward-stub < /dev/null; echo $?` → prints 2 (stub is installed and mode-switching works; success-mode behavior needs a workspace and is covered by Task 6's gated tests).

- [ ] **Step 6: Commit**

```bash
git add Dockerfile deploy/agent scripts/build-agent-image.mjs src/server/agents/task-container tests/server/agents/task-container package.json
git commit -m "feat: agent image target with stub runtime and lockfile-keyed build"
```

---

### Task 5: ContainerAgentLauncher

**Files:**
- Create: `src/server/agents/task-container/arguments.ts`
- Create: `src/server/agents/task-container/container-launcher.ts`
- Modify: `src/server/agents/task-container/index.ts`
- Test: `tests/server/agents/task-container/arguments.test.ts` (dockerless)

**Interfaces:**
- Consumes: `agentPrompt`, `agentRole`, `codexProviderArgs`, `claudeProviderArgs`, `providerEnvironment`, `providerResult`, `structuredOutcome`, `assertCredentialSafe`, `ActivityChannel`, `AgentProcessError`, `boundedInteger`, `configText` from `#server/agents/task-worker/agent-envelope`; `AgentLauncher`/`AgentLaunchRequest`/`AgentRunHandle` from Task 2's types.
- Produces (Tasks 6–8 rely on):

```typescript
export interface ContainerAgentLauncherOptions {
  readonly provider: "codex" | "claude";
  readonly model: string;
  readonly image: string;
  /** Executable inside the image. Default: the provider name. Tests pass "steward-stub". */
  readonly agentCommand?: string;
  readonly networkName: string;          // the internal agents network
  readonly proxyUrl: string;             // http://steward-egress-proxy:3128
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;           // same bounds/defaults as the contained launcher
  readonly terminationGraceMs?: number;
  readonly dockerBinary?: string;        // default "docker"
  /** Extra -e KEY=VALUE pairs for the container (test hook, e.g. STEWARD_STUB_MODE). */
  readonly extraContainerEnv?: Readonly<Record<string, string>>;
}
export class ContainerAgentLauncher implements AgentLauncher {
  constructor(options: ContainerAgentLauncherOptions);
  launch(request: AgentLaunchRequest): Promise<AgentRunHandle>; // throws AgentProcessError if request.workspace is absent
}

// arguments.ts — pure, fully unit-testable
export interface ContainerRunPlan {
  readonly args: readonly string[];      // argv after "docker"
  readonly containerName: string;        // steward-task-<runId>
}
export function buildContainerRunPlan(input: {
  readonly options: Required<Pick<ContainerAgentLauncherOptions, "provider" | "model" | "image" | "networkName" | "proxyUrl">>
    & Pick<ContainerAgentLauncherOptions, "agentCommand" | "extraContainerEnv">;
  readonly runId: string;
  readonly taskId: string;
  readonly fixedRole: AgentRole;
  readonly workspacePath: string;
  readonly bareApiKey: boolean;
}): ContainerRunPlan
```

`buildContainerRunPlan` returns `containerName = "steward-task-" + runId` and args exactly:

```typescript
const cliArgs = input.options.provider === "codex"
  ? codexProviderArgs({ model, workingDirectory: "/workspace", schemaPath: "/opt/steward/agent-result.schema.json", bareApiKey }, fixedRole)
  : claudeProviderArgs({ model, workingDirectory: "/workspace", schemaPath: "/opt/steward/agent-result.schema.json", bareApiKey }, fixedRole);
const providerKeys = input.options.provider === "codex"
  ? ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ORGANIZATION", "OPENAI_PROJECT"]
  : ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"];
return {
  containerName,
  args: [
    "run", "--rm", "-i",
    "--name", containerName,
    "--label", `steward.task=${input.taskId}`,
    "--network", input.options.networkName,
    "--user", "node",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", "4g",
    "--pids-limit", "512",
    "-v", `${input.workspacePath}:/workspace:rw`,
    "-w", "/workspace",
    "-e", `HTTP_PROXY=${input.options.proxyUrl}`,
    "-e", `HTTPS_PROXY=${input.options.proxyUrl}`,
    "-e", `http_proxy=${input.options.proxyUrl}`,
    "-e", `https_proxy=${input.options.proxyUrl}`,
    "-e", "NO_PROXY=localhost,127.0.0.1",
    ...providerKeys.flatMap((key) => ["-e", key]), // bare names: values come from the docker client env, never argv
    ...Object.entries(input.options.extraContainerEnv ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    input.options.image,
    input.options.agentCommand ?? input.options.provider,
    ...cliArgs,
  ],
};
```

`container-launcher.ts` — mirrors the contained launcher's `launch()` shape (single-active guard, credential-safety check on context, stdin prompt, bounded stdout/stderr collection, `ActivityChannel` fed per line, timeout, envelope parse on close) with container-specific spawn and termination:

- Constructor: validate with `configText`/`boundedInteger` exactly as the contained launcher does (`model` ≤ 256, `image` ≤ 512, `timeoutMs` default 60 min bounds [1s, 24h], `terminationGraceMs` default 2 000 bounds [10, 60 000]); build `#environment = providerEnvironment(provider, options.environment ?? process.env)` and then a `#dockerEnvironment` = `#environment` plus passthrough of `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY` from the source env when set (the docker client needs them; the container never sees them).
- `launch(request)`: throw `AgentProcessError("Container launches require a per-launch workspace")` when `request.workspace === undefined`; verify the workspace directory exists (same `open(..., O_DIRECTORY)` probe as the contained launcher); `spawn(dockerBinary, plan.args, { env: #dockerEnvironment, stdio: ["pipe","pipe","pipe"] })` — NOT detached; write `agentPrompt(request)` to stdin; collect bounded stdout/stderr and publish activity exactly like the contained launcher (reuse `activityFromProviderLine` etc. from `./provider-activity.js` via the worker module — import path `#server/agents/task-worker/provider-activity` needs adding to package.json imports if not already resolvable; it is, via the `task-worker/*` wildcard).
- Termination (`#terminate()`, used by both the timeout and `interrupt`): run `docker stop -t <ceil(terminationGraceMs/1000)> <containerName>` via `execFile` (docker does SIGTERM → grace → SIGKILL); then poll `docker inspect --format {{.State.Running}} <containerName>` every 100 ms until it errors ("No such object" — `--rm` removed it) or reports `false`, bounded by 30 s; finally best-effort `docker rm -f <containerName>` (idempotent). Reject with `AgentProcessError("Task container could not be confirmed absent")` if still present at the deadline.
- On child `close`: same outcome logic as the contained launcher — nonzero exit without a prior failure ⇒ `AgentProcessError("Agent container exited unsuccessfully (<code>)")`; on success parse `structuredOutcome(providerResult(provider, stdout))` and `assertCredentialSafe` the stderr. When the docker client itself fails to spawn ⇒ `AgentProcessError("Unable to start the docker client", { cause })`.
- `interrupt(reason)` sets `failure ??= new AgentProcessError("Agent container was interrupted directly")` and awaits `#terminate()` — resolving only once the container is confirmed absent, honoring the `AgentRunHandle` contract.

`index.ts` grows to:

```typescript
export { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "./image-tag.js";
export { buildContainerRunPlan } from "./arguments.js";
export type { ContainerRunPlan } from "./arguments.js";
export { ContainerAgentLauncher } from "./container-launcher.js";
export type { ContainerAgentLauncherOptions } from "./container-launcher.js";
```

- [ ] **Step 1: Write the failing arguments tests** — `tests/server/agents/task-container/arguments.test.ts`. Assert for a codex plan: container name `steward-task-<runId>`; args begin `run --rm -i --name steward-task-<runId>`; the label is `steward.task=<taskId>`; `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user node`, `--memory 4g`, `--pids-limit 512` all present; the workspace mount is `<path>:/workspace:rw` and workdir `/workspace`; every provider key appears as a bare `-e NAME` (assert `args` contains `"-e", "OPENAI_API_KEY"` and does NOT contain any element matching `/OPENAI_API_KEY=/`); proxy env pairs present; image precedes the agent command; the CLI args include `--cd /workspace` and `--output-schema /opt/steward/agent-result.schema.json`; `agentCommand: "steward-stub"` replaces `codex`; `extraContainerEnv: { STEWARD_STUB_MODE: "fail" }` appends `-e STEWARD_STUB_MODE=fail`. For a claude plan: command defaults to `claude`, no `--output-schema` path is present in argv, and `--bare` tracks the `bareApiKey` input.
- [ ] **Step 2: Run to verify failure** — `npm run test:runtime` → FAIL.
- [ ] **Step 3: Implement** `arguments.ts`, `container-launcher.ts`, `index.ts`.
- [ ] **Step 4: Run dockerless suites** — `npm run typecheck:runtime && npm run test:runtime` → PASS. (The launcher class gets its behavioral coverage in Task 6's docker-gated tests; unit scope here is the pure plan builder plus constructor validation — add asserts that a bad `model`/`timeoutMs` throws and that `launch` without `workspace` rejects with `AgentProcessError`, using a launcher constructed with `dockerBinary: "/nonexistent"` so nothing real can spawn.)
- [ ] **Step 5: Commit**

```bash
git add src/server/agents/task-container tests/server/agents/task-container
git commit -m "feat: container-per-launch agent launcher over the docker CLI"
```

---

### Task 6: Container infrastructure + docker-gated integration suite

**Files:**
- Create: `src/server/agents/task-container/infrastructure.ts` (and export from `index.ts`)
- Create: `tests/container/helpers.ts`, `tests/container/agent-image.test.ts`, `tests/container/container-launcher.test.ts`
- Modify: `package.json` (scripts), `tsconfig.test.json` (include `tests/container/**/*.ts`)

**Interfaces:**
- Produces (Tasks 7–8 rely on):

```typescript
export const DEFAULT_ALLOWED_HOSTS = Object.freeze(["api.anthropic.com", "api.openai.com", "registry.npmjs.org"]);
export interface ContainerInfrastructureOptions {
  readonly image: string;                 // agent image (also runs the proxy)
  readonly allowedHosts: readonly string[];
  readonly dockerBinary?: string;         // default "docker"
  readonly agentNetwork?: string;         // default "steward-agents"
  readonly egressNetwork?: string;        // default "steward-egress"
  readonly proxyContainerName?: string;   // default "steward-egress-proxy"
  readonly proxyPort?: number;            // default 3128
}
export interface ContainerInfrastructure {
  readonly agentNetwork: string;
  readonly proxyUrl: string;              // http://<proxyContainerName>:<proxyPort>
}
export class ContainerInfrastructureError extends Error {}
/** Throws ContainerInfrastructureError with a start-Docker-Desktop hint when the daemon is unreachable. */
export function assertDockerAvailable(dockerBinary?: string): Promise<void>
/** Idempotent: daemon check; create networks; (re)start proxy when absent or its allowlist env differs; sweep orphaned steward.task containers. */
export function prepareContainerInfrastructure(options: ContainerInfrastructureOptions): Promise<ContainerInfrastructure>
```

Implementation notes (all via `execFile(dockerBinary, ...)` with a 30 s timeout, wrapped so failures throw `ContainerInfrastructureError` carrying trimmed stderr):

- `assertDockerAvailable`: `docker version --format {{.Server.Version}}`; on failure throw `` `Docker daemon unreachable — start Docker Desktop and retry (${detail})` ``.
- Networks: `docker network inspect <name>` → on failure `docker network create --internal steward-agents` / `docker network create steward-egress` (tolerate the "already exists" race by re-inspecting on create failure).
- Proxy: `docker inspect --format '{{.State.Running}}|{{range .Config.Env}}{{.}} {{end}}' <proxyContainerName>`; if missing, not running, or the `STEWARD_EGRESS_ALLOWED_HOSTS=` value ≠ the sorted, comma-joined allowlist → `docker rm -f <name>` then

```
docker run -d --restart unless-stopped --name <name>
  --network <agentNetwork>
  -e STEWARD_EGRESS_ALLOWED_HOSTS=<sorted,comma,list>
  -e STEWARD_EGRESS_PORT=<proxyPort>
  <image> node /opt/steward/build/server/agents/egress-proxy/main.js
```

  then `docker network connect <egressNetwork> <name>` (tolerate "already connected"). The proxy container carries NO model credentials.
- Sweep: `docker ps -aq --filter label=steward.task` → `docker rm -f` each id returned (at prepare time no lane is live, so every labeled container is an orphan).

`package.json` script changes:

```json
"test:runtime": "npm run build:runtime && npm run clean:tests && tsc -p tsconfig.test.json && node --test \".test-dist/tests/server/**/*.test.js\" \".test-dist/tests/shared/**/*.test.js\"",
"test:container": "npm run build:agent-image && npm run clean:tests && tsc -p tsconfig.test.json && node --test \".test-dist/tests/container/**/*.test.js\""
```

(`tsconfig.test.json` include becomes `["tests/server/**/*.ts", "tests/shared/**/*.ts", "tests/container/**/*.ts"]`. The runtime glob change is what keeps container tests out of `test:runtime` — verify by running it with Docker stopped.)

`tests/container/helpers.ts`:

```typescript
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "#server/agents/task-container";

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
  await docker(["image", "inspect", image]); // build:agent-image ran in the npm script; missing image is a hard fail
  return image;
}
```

`helpers.ts` additionally exports (used by both gated test files and Task 8):

```typescript
/** mkdtemp under os.tmpdir(). */
export function tempRoot(): Promise<string>
/** execFile git with cwd; rejects with trimmed stderr. */
export function runGit(cwd: string, args: readonly string[]): Promise<string>
/** git init -b main + one commit, identical to the Task 2 test fixture. Returns the repo path. */
export function fixtureRepo(root: string): Promise<string>
```

(Implement them by copying the `run`/`fixtureRepo` bodies from `tests/server/agents/task-workspace/manager.test.ts` — container tests must not import from `tests/server/`.)

- [ ] **Step 1: Write the failing gated tests.**

`tests/container/agent-image.test.ts`: `requireDocker()` first in every test. Assert: image exists with both `steward.cli.*` labels non-empty (`docker image inspect -f '{{index .Config.Labels "steward.cli.codex"}}'`); `docker run --rm <image> git --version` succeeds; `docker run --rm <image> ls /opt/steward/agent-result.schema.json /opt/steward/node_modules /usr/local/bin/steward-stub` succeeds; running as `--user node` reports uid 1000 (`id -u`).

`tests/container/container-launcher.test.ts` — the heart of the campaign. Fixture: temp git repo via `fixtureRepo`/`runGit`/`tempRoot` from `./helpers.js`, `TaskWorkspaceManager`, `prepareContainerInfrastructure({ image, allowedHosts: DEFAULT_ALLOWED_HOSTS })`, and a `ContainerAgentLauncher({ provider: "codex", model: "stub-model", image, agentCommand: "steward-stub", networkName, proxyUrl })` wrapped in `WorkspaceScopedLauncher`. Build an `AgentLaunchRequest` with the `context(...)` helper pattern from `tests/server/agents/task-worker/helpers.ts` (read it; copy the minimal context builder into container helpers — engineer role so the stub gets a writable sandbox posture). Tests:

1. **Stub round-trip**: `launch` → `completion` resolves `status: "completed"`; `git show task/<taskId>:stub-proof.txt` in the fixture repo succeeds (harvest happened); the workspace dir is gone; `docker ps -aq --filter label=steward.task` is empty.
2. **Egress is blocked**: run with `extraContainerEnv: { STEWARD_STUB_MODE: "fail" }` replaced by a dedicated probe — simpler: one test that runs `docker run --rm --network <agentNetwork> <image> node -e "fetch('https://example.com',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))"` and asserts exit code 1 (internal network has no route out), and a second probe through the proxy asserting the proxy REFUSES a non-allowlisted CONNECT: `docker run --rm --network <agentNetwork> -e HTTPS_PROXY=<proxyUrl> <image> node -e "fetch('https://example.com',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))"` → exit 1. (A positive allowlisted probe would need a real external endpoint; that lives in the manual smoke, not CI-shaped tests.)
3. **Death is uneventful**: launch with `extraContainerEnv: { STEWARD_STUB_MODE: "hang" }` and `timeoutMs: 120_000`; wait for `docker ps --filter name=steward-task-` to show the container, then `docker kill steward-task-<runId>`; `completion` rejects with `AgentProcessError` (nonzero exit); the workspace is retained (a `retained-<taskId>-*` dir exists); no container with the label remains.
4. **Interrupt tears down within grace**: same hang mode; call `handle.interrupt("test stop")`; the promise resolves only after `docker ps` no longer lists the container; `completion` rejects.

- [ ] **Step 2: Implement `infrastructure.ts`** and the script/tsconfig changes.
- [ ] **Step 3: Run dockerless suites** — `npm run typecheck:runtime && npm run test:runtime` → PASS (and confirm no `tests/container` file executed in the output).
- [ ] **Step 4 [orchestrator verify]: Run the gated suite** — `npm run test:container` → PASS with Docker Desktop running; with Docker stopped it must FAIL loudly at `build:agent-image`/`requireDocker`, not skip.
- [ ] **Step 5: Commit**

```bash
git add src/server/agents/task-container tests/container package.json tsconfig.test.json
git commit -m "feat: container infrastructure (networks, egress proxy, orphan sweep) with docker-gated tests"
```

---

### Task 7: Fleet config v2 + container lane factory

**Files:**
- Modify: `src/server/agents/task-fleet/types.ts`, `src/server/agents/task-fleet/config.ts`, `src/server/agents/task-fleet/runtime.ts`, `src/server/agents/task-fleet/index.ts`
- Test: extend `tests/server/agents/task-fleet/config.test.ts`; create `tests/server/agents/task-fleet/container-runtime.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 6 exports.
- Produces (Task 8 relies on):

```typescript
// types.ts additions
export type TaskFleetRuntimeKind = "local-process" | "container";
export interface TaskFleetContainerLaneConfig {
  readonly workspaceRoot: string;                 // absolute; per-task clones live here
  readonly image: string | undefined;             // default: steward-agent:<computed tag>
  readonly agentCommand: string | undefined;      // default: the provider; tests use steward-stub
  readonly extraAllowedHosts: readonly string[];  // appended to DEFAULT_ALLOWED_HOSTS
}
export interface TaskFleetAgentConfig {
  // ...existing fields unchanged...
  readonly runtime: TaskFleetRuntimeKind;                       // default "local-process"
  readonly container: TaskFleetContainerLaneConfig | undefined; // required iff runtime === "container"
}
```

`config.ts` changes, inside `agentConfig`: add `"runtime"` and `"container"` to the optional field list of the `exact()` call. Then:

```typescript
const runtime = item.runtime === undefined ? "local-process" : item.runtime;
if (runtime !== "local-process" && runtime !== "container") throw new Error(`${label}.runtime must be local-process or container`);
if (runtime === "container" && item.container === undefined) throw new Error(`${label}.container is required for container lanes`);
if (runtime !== "container" && item.container !== undefined) throw new Error(`${label}.container is only valid for container lanes`);
```

and a `containerConfig(value, label)` helper: `exact(value, ["workspaceRoot"], ["image", "agentCommand", "extraAllowedHosts"], label)`; `workspaceRoot` via `absolutePath`; `image`/`agentCommand` via `text(..., 512)` when present; `extraAllowedHosts` an array of ≤ 32 entries, each `text(..., 253)` matching `/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u`, else throw. For container lanes, `workingDirectory` is the repository path workspaces are cloned from — no parser change needed, but extend the doc comment on `TaskFleetAgentConfig.workingDirectory` in `types.ts` to say exactly that.

`runtime.ts` changes — `createTaskFleetWorker` branches on `config.runtime`:

```typescript
export const createTaskFleetWorker: TaskFleetWorkerFactory = async (config, boardUrl) => (
  config.runtime === "container"
    ? createContainerTaskFleetWorker(config, boardUrl)
    : createLocalProcessTaskFleetWorker(config, boardUrl) // the existing body, renamed
);

async function createContainerTaskFleetWorker(config: TaskFleetAgentConfig, boardUrl: string): Promise<ManagedTaskWorker> {
  const lane = config.container;
  if (lane === undefined) throw new Error("container lane config missing"); // parser guarantees; belt for direct construction
  const image = lane.image ?? `${AGENT_IMAGE_REPOSITORY}:${await computeAgentImageTag(process.cwd())}`;
  const infrastructure = await prepareContainerInfrastructure({
    image,
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...lane.extraAllowedHosts],
  });
  const runtimeVersion = await captureContainerRuntimeVersion(config.provider, image);
  const manager = new TaskWorkspaceManager({ workspaceRoot: lane.workspaceRoot, repositoryPath: config.workingDirectory });
  const launcher = new WorkspaceScopedLauncher(
    new ContainerAgentLauncher({
      provider: config.provider,
      model: config.model,
      image,
      ...(lane.agentCommand === undefined ? {} : { agentCommand: lane.agentCommand }),
      networkName: infrastructure.agentNetwork,
      proxyUrl: infrastructure.proxyUrl,
      ...(config.agentTimeoutMs === undefined ? {} : { timeoutMs: config.agentTimeoutMs }),
      ...(config.terminationGraceMs === undefined ? {} : { terminationGraceMs: config.terminationGraceMs }),
    }),
    manager,
  );
  const worker = await TaskWorker.create({
    identity: { workerId: config.workerId, agentId: config.agentId },
    statePath: config.statePath,
    board: new HttpTaskBoardClient({ baseUrl: boardUrl, token: config.token }),
    launcher,
    pinned: {
      runtime: config.provider,
      ...(runtimeVersion === null ? {} : { runtimeVersion }),
      model: config.model,
    },
    longPollMs: config.longPollMs,
  });
  return Object.freeze({
    run: (signal: AbortSignal) => worker.dispatchOnce(signal),
    hasActiveClaim: () => worker.hasActiveClaim(),
    quarantineActiveClaim: (detail: string, signal?: AbortSignal) => worker.quarantineActiveClaim(detail, signal),
    dropActiveClaim: (detail: string) => worker.dropActiveClaim(detail),
    reportLaneError: (detail: string | null, signal?: AbortSignal) => detail === null
      ? Promise.resolve()
      : worker.reportLaneError(detail, signal),
    close: () => worker.close(),
  });
}

/** `<cli label version>+<imageId12>` from `docker image inspect`; null when unreadable. */
export async function captureContainerRuntimeVersion(
  provider: TaskFleetProvider,
  image: string,
  runner: TaskFleetVersionRunner = runDockerInspect, // execFile("docker", ["image", "inspect", "-f", format, image])
): Promise<string | null>
```

`captureContainerRuntimeVersion` uses format `{{index .Config.Labels "steward.cli.<provider>"}}|{{.Id}}`, splits on `|`, takes label + `Id` with the `sha256:` prefix stripped and truncated to 12 chars, returns `` `${label}+${id12}` `` — with the same character/length hygiene as `captureTaskFleetRuntimeVersion` (reject control chars, cap 128, return null on any failure). Export it from `index.ts`.

- [ ] **Step 1: Write the failing config tests** (extend `config.test.ts`): a v1 config with no new fields still parses with `runtime: "local-process"` and `container: undefined`; a container lane parses with defaults applied; `runtime: "container"` without `container` throws; `container` on a local-process lane throws; a bad `extraAllowedHosts` entry (`"Bad Host!"`) throws; relative `workspaceRoot` throws; unknown field inside `container` throws.
- [ ] **Step 2: Write the failing factory tests** — `tests/server/agents/task-fleet/container-runtime.test.ts`: `captureContainerRuntimeVersion` with an injected fake runner returning `"1.2.3|sha256:abcdef0123456789abcdef\n"` → `"1.2.3+abcdef012345"`; fake runner throwing → null; fake runner returning control characters → null.
- [ ] **Step 3: Run to verify failure** — `npm run test:runtime` → FAIL.
- [ ] **Step 4: Implement** the three fleet files (+ `index.ts` re-exports for new types/functions).
- [ ] **Step 5: Run** — `npm run typecheck:runtime && npm run test:runtime` → PASS (all pre-existing fleet tests unchanged and green — the v1-compat assertion in Step 1 is the proof the parser stayed backward compatible).
- [ ] **Step 6: Commit**

```bash
git add src/server/agents/task-fleet tests/server/agents/task-fleet
git commit -m "feat: fleet config v2 with container lanes and image-identity pinning"
```

---

### Task 8: Exit-criterion e2e + roadmap update

**Files:**
- Create: `tests/container/board-e2e.test.ts`
- Create: `scripts/agent-container-smoke.mjs`
- Modify: `orchestrator-roadmap.md` (campaign 2 status), `docs/superpowers/plans/2026-08-15-orchestrator-c1-state-machine.md` (no content change — do NOT touch; listed only to say so)

**Interfaces:**
- Consumes: `createTaskBoardService` from `#server/task-board`; `createTaskFleetWorker`, `parseTaskFleetConfig` from `#server/agents/task-fleet`; Task 6 helpers.

The e2e mirrors `tests/server/agents/task-worker/http-board-integration.test.ts` (read it first — the `request`/`fixture`/`createTask` helpers there are the template): real HTTP board on an ephemeral loopback port, a project, an engineer agent, a human-assigned task — then a **container lane built by the real factory** claims and executes it with the stub.

```typescript
import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTaskBoardService } from "#server/task-board";
import { createTaskFleetWorker, parseTaskFleetConfig } from "#server/agents/task-fleet";
import { agentImage, docker, fixtureRepo, requireDocker, runGit, tempRoot } from "./helpers.js";
// plus a local `request` helper copied verbatim from tests/server/agents/task-worker/http-board-integration.test.ts

const HUMAN_TOKEN = "container-e2e-human-token-0123456789abcd";
const AGENT_TOKEN = "container-e2e-agent-token-0123456789abcd";

test("a board-claimed task executes in a disposable container against its own workspace", async () => {
  await requireDocker();
  const image = await agentImage();
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const service = await createTaskBoardService({
    dbPath: join(root, "board", "task-board.sqlite"),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:container-e2e",
    port: 0,
  });
  let worker: Awaited<ReturnType<typeof createTaskFleetWorker>> | null = null;
  try {
    const address = await service.start();
    const { project } = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, 201, {
      name: "Container execution", description: "Prove container-per-task execution end to end.",
    });
    await request(address.url, `/v1/projects/${project.projectId}/agents`, "POST", HUMAN_TOKEN, 201, {
      agentId: "container-engineer", role: "engineer", area: "execution",
      mission: "Prove containerized execution.", model: "stub-model", token: AGENT_TOKEN,
    });
    const { task } = await request(address.url, `/v1/projects/${project.projectId}/tasks`, "POST", HUMAN_TOKEN, 201, {
      parentTaskId: null, title: "Run inside a container",
      objective: "The stub commits a proof file on the task branch.",
      acceptanceCriteria: "task branch exists in the source repo with stub-proof.txt",
      workspaceRefs: [], assignedAgentId: "container-engineer", assignedRole: "engineer", expectedAgentMinutes: 15,
    });
    const config = parseTaskFleetConfig({
      version: 1,
      boardUrl: address.url,
      agents: [{
        workerId: "container-e2e-worker", agentId: "container-engineer", token: AGENT_TOKEN,
        provider: "codex", model: "stub-model",
        workingDirectory: repo, statePath: join(root, "worker", "journal.json"), longPollMs: 1000,
        runtime: "container",
        container: { workspaceRoot: join(root, "workspaces"), image, agentCommand: "steward-stub" },
      }],
    });
    worker = await createTaskFleetWorker(config.agents[0]!, config.boardUrl);
    assert.equal(await worker.run(new AbortController().signal), true, "the container lane claimed and settled the wake");

    // Board: run completed with a container-pinned identity
    const board = await request(address.url, `/v1/projects/${project.projectId}/board`, "GET", HUMAN_TOKEN, 200);
    const run = board.recentRuns.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.runtime, "codex");
    assert.match(run?.runtimeVersion ?? "", /\+[0-9a-f]{12}$/u);
    assert.equal(board.tasks.find((candidate) => candidate.taskId === task.taskId)?.status, "completed");

    // Repo: the branch was harvested with the stub's commit
    assert.match(await runGit(repo, ["show", `task/${task.taskId}:stub-proof.txt`]), /stub ran/u);

    // Host: workspace removed, no labeled container left
    await assert.rejects(access(join(root, "workspaces", task.taskId)));
    assert.deepEqual((await readdir(join(root, "workspaces"))).filter((name) => !name.startsWith("retained-")), []);
    assert.equal((await docker(["ps", "-aq", "--filter", "label=steward.task"])).trim(), "");
  } finally {
    await worker?.close();
    await service.close();
  }
});
```

`scripts/agent-container-smoke.mjs` (create in this task) — the spec's manual smoke for a REAL CLI through the proxy; run by the operator, never by CI. It takes the provider as argv, prepares infrastructure, and runs the real CLI in the agent container with a trivial prompt, inheriting the operator's API key:

```javascript
import { execFileSync } from "node:child_process";
import { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "../build/server/agents/task-container/image-tag.js";

const provider = process.argv[2];
if (provider !== "codex" && provider !== "claude") throw new Error("Usage: node scripts/agent-container-smoke.mjs codex|claude");
const key = provider === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
if (!process.env[key]) throw new Error(`${key} must be set for the smoke run`);
const root = new URL("..", import.meta.url).pathname;
const image = `${AGENT_IMAGE_REPOSITORY}:${await computeAgentImageTag(root)}`;
// Infrastructure (networks + proxy) must already exist — run npm run test:container once first, or any container lane.
const output = execFileSync("docker", [
  "run", "--rm", "-i", "--network", "steward-agents", "--user", "node", "--cap-drop", "ALL",
  "-e", `HTTPS_PROXY=http://steward-egress-proxy:3128`, "-e", `HTTP_PROXY=http://steward-egress-proxy:3128`,
  "-e", key,
  image,
  ...(provider === "codex"
    ? ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "--model", "gpt-5-codex", "-"]
    : ["claude", "--print", "--model", "claude-haiku-4-5-20251001"]),
], { input: "Reply with the single word: reachable", encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
console.log(output);
console.log(`smoke ${provider}: model API reachable through the egress proxy, proxy env honored`);
```

(This is the verification that each CLI honors proxy env vars — the risk the spec states explicitly. If a CLI ignores the proxy, this hangs or fails: that finding goes back into the spec's egress section rather than being patched silently.)

`orchestrator-roadmap.md` change: in the Campaigns section, annotate campaign 1 as shipped and campaign 2's entry with its spec/plan references — replace the campaign 1 and 2 lead-ins:

- `**1. Task record and state machine** *(§3; §15 item 1 delta)*` → `**1. Task record and state machine** *(shipped 2026-08-16; §3; §15 item 1 delta)*`
- `**2. Worktree + container execution** *(§10; item 2)*` → `**2. Worktree + container execution** *(spec/plan 2026-08-17, in flight; §10; item 2)*`

- [ ] **Step 1: Write the e2e** (it fails or errors until run under `test:container` with the full stack from Tasks 1–7 in place).
- [ ] **Step 2 [orchestrator verify]: Run the exit criterion** — `npm run test:container` → ALL container tests PASS including the e2e.
- [ ] **Step 3 [orchestrator verify]: Full regression** — `npm run typecheck:all && npm run test:all` → PASS.
- [ ] **Step 4: Update the roadmap lines** as above.
- [ ] **Step 5: Commit**

```bash
git add tests/container/board-e2e.test.ts orchestrator-roadmap.md
git commit -m "test: exit-criterion e2e — board-claimed task runs in a disposable container"
```

---

## Deferred / explicitly out of scope (do not build)

- Running the manual smoke (`scripts/agent-container-smoke.mjs`, created in Task 8): executed by the operator with real API keys after the campaign lands, once per CLI; its result (does each CLI honor proxy env vars?) is recorded back into the spec's egress section.
- `runtimes.yaml` capability profiles (campaign 8), `promptsSha` population (campaign 4), PR creation/repo-scoped git tokens (campaign 4), concurrency > 1 (campaign 7).
- Wiring any existing lane to `runtime: "container"` by default — mechanism + tests only, per the operator's scope decision.
