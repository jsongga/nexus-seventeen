# Orchestrator campaign 2 — worktree + container execution

Status: Approved in brainstorming (operator picked mechanism+tests scope,
stub-runtime e2e, isolated-clone workspaces; spec open for review)
Author: Claude, from `orchestrator-design.md` §10 and `orchestrator-roadmap.md`
campaign 2
Date: 2026-08-17
Scope: per-task isolated git workspaces, a Docker `agent` image target, a
container-per-task launcher behind the existing runtime-adapter seam, and a
proxy-enforced egress allowlist — proven by tests, with lanes untouched as the
local-process path

## Summary

Today an agent run is a detached process group on the operator's host:
`ContainedCliAgentLauncher` spawns `codex`/`claude` off `PATH` with inherited
API keys, provider sandbox flags as the only containment, and a working
directory fixed per lane by hand
(`src/server/agents/task-worker/contained-cli-launcher.ts`). This campaign
adds the missing execution substrate from §10: each task gets its own
disposable git workspace and its own disposable Docker container, behind the
same `AgentLauncher` / `TaskFleetWorkerFactory` seam the fleet already uses.

**Scope decision (operator, 2026-08-17): mechanism + tests only.** Lanes keep
running as the local-process path; nothing is rewired to containers by
default. Campaign 4's pipeline is the first real consumer. Exit: the e2e
below is green — a board-claimed task executes in a real container against
its own workspace, and killing the container mid-run settles cleanly with no
orphaned container or workspace.

**Workspace decision (operator, 2026-08-17): isolated clone, not a literal
`git worktree`.** A worktree shares the main repo's `.git` (objects, refs,
hooks, config), so the container would need it mounted read-write, and a
compromised agent could plant hooks that execute on the host's next git
command. A local `git clone --no-hardlinks` per task is self-contained: the
container sees only its clone, and the host takes results back via fetch
(which runs no hooks from the remote side). This deviates from §10's
"worktree" wording deliberately — the intent (isolated checkout + branch per
task) is kept; the sharing mechanism that made worktrees cheap is exactly the
part that is unsafe across a container boundary. `--no-hardlinks` matters:
hardlinked objects would let the container corrupt the main repo's object
files through the shared inode.

## What exists / what changes

| Piece | Today | This campaign |
| --- | --- | --- |
| Launcher | Host process group, provider sandbox flags (`contained-cli-launcher.ts`) | Unchanged; a sibling `ContainerAgentLauncher` implements the same interface |
| Working directory | Fixed per launcher instance at construction | `launch()` gains a per-launch `workspace`; local-process lanes pass their configured directory through it |
| Git handling | None (zero worktree/branch code in `src/`) | `WorkspaceManager`: clone per task, `task/<id>` branch, harvest by fetch, idempotent remove |
| Docker | Declarative only (prod `Dockerfile`, compose); no invocation from code | `agent` image target + `docker` CLI invocation from the launcher (no new npm dependency) |
| Egress | Asymmetric: Codex lanes network-off, Claude lanes no policy | Container path: internal-only network + proxy sidecar with a domain allowlist, uniform per config |
| Config | Fleet JSON v1, closed-world parser (`task-fleet/config.ts`) | v2: optional `runtime` + `container` fields; old configs parse unchanged |

## Components

### WorkspaceManager (host-side)

- `create(taskId, repoPath, baseRef)` → `git clone --no-hardlinks` of
  `repoPath` into `<workspaceRoot>/<taskId>`, checked out at `baseRef`, then
  `git switch -c task/<taskId>`. Returns the absolute workspace path. Fails
  before any board state is touched.
- `harvest(taskId, repoPath)` → in the source repo,
  `git fetch <workspacePath> task/<taskId>:task/<taskId>`. Fetch executes no
  hooks from the fetched side and verifies object hashes; the branch then
  exists in the main repo for humans (or campaign 4's PR flow) to use.
- `remove(taskId)` → recursive delete, idempotent (missing workspace is
  success).
- Workspace root is configurable, defaults outside any repo (under the
  board's private state directory). Successful runs are harvested then
  removed; failed runs keep their workspace under a bounded retention
  (default: the 5 most recent failures, oldest evicted) for debugging.

### ContainerAgentLauncher

Implements `AgentLauncher` (`src/server/agents/task-worker/types.ts`). Shells
out to the `docker` CLI via the same spawn discipline as today — the repo has
three runtime dependencies and container control does not justify a fourth.

Per launch, `docker run` with:

- `--rm`, `--label steward.task=<id>` — teardown is `docker stop` mapped onto
  today's grace→kill semantics (`terminationGraceMs`); `--rm` reaps the
  container, and fleet startup sweeps any orphaned `steward.task`-labeled
  containers so a dead container or dead worker leaves nothing behind.
- The task workspace bind-mounted read-write at a fixed in-container path;
  non-root user (reusing the image's `node` user), `--cap-drop ALL`,
  `--security-opt no-new-privileges`, memory and pids limits.
- Environment built by the existing from-scratch allowlist
  (`providerEnvironment()` extracted to a shared module): model credentials
  only. The board token never enters the container — the invariant in
  `task-worker/types.ts` stands.
- Internal-only network plus `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` pointing
  at the egress proxy (below).
- Prompt on stdin, the strict JSON result envelope on stdout, exactly today's
  contract. Envelope parsing, `RESULT_SCHEMA` validation, and
  secret-pattern scrubbing move from `contained-cli-launcher.ts` into a
  shared module consumed by both launchers — no duplication.
- Provider sandbox flags stay on inside the container as defense-in-depth,
  with one change: the network posture comes from the egress allowlist, not
  from Codex's blanket network-off (which today is the *only* egress control,
  and which Claude lanes never had).

One `docker run` per `launch()`. Since one claim is one launch until campaign
4 introduces stages, container-per-launch *is* container-per-task; if stages
later want a shared container, the adapter seam is where that changes.

### Launcher interface change (the invasive one)

`AgentLaunchRequest` gains `workspace: { path }`. Today `workingDirectory` is
fixed at launcher construction — incompatible with per-task checkouts. The
worker resolves the workspace after claim and before launch, and
harvests/removes after settle. Local-process lanes pass their configured
directory as the workspace, so the existing flow is unchanged in behavior.
This is the single change that touches existing code paths; everything else
is additive.

### Egress allowlist (proxy sidecar)

Two Docker networks: `steward-agents` (`internal: true` — no route out) and
`steward-egress`. One long-lived proxy container sits on both and enforces a
domain allowlist at HTTP CONNECT level — no TLS interception. Agent
containers join only the internal network; the proxy is their only way out.
The launcher lazily ensures networks and proxy exist. Default allowlist:
model API domains for the configured providers plus `registry.npmjs.org`;
config can extend it per lane.

Stated honestly: this is domain-level control that depends on the CLI
honoring proxy environment variables. That holds for npm and is verified for
each CLI by the manual smoke (below); the stub e2e independently asserts the
network posture (direct egress fails, allowlisted egress via proxy
succeeds). Kernel-level per-domain filtering is not available without root on
Docker Desktop for macOS; this is the strongest portable mechanism.

### Agent image

The prod `Dockerfile`'s `build` stage currently runs `npm ci` and
`npm run build` in one layer — first, split a shared `deps` stage
(`package.json` + lockfile → `npm ci`) that both prod and agent branch from,
per §10's shared-lower-layers requirement. The new `agent` target:

- `node:24-alpine` + `deps`, keeping dev dependencies; adds `git`, both CLIs
  (`@openai/codex`, `@anthropic-ai/claude-code`), and the deterministic stub
  runtime; CLI versions recorded as image labels at build.
- Non-root (`node`), writable `/tmp`, no prod `ENV`/`EXPOSE`/entrypoint.
- `scripts/build-agent-image` tags the image with the lockfile hash and skips
  the build when that tag already exists — §10's "rebuild when the lockfile
  changes."

### Fleet config v2

`task-fleet/config.ts`'s closed-world parser rejects unknown fields, so v2
adds them as *optional*: per-agent `runtime: "local-process" | "container"`
(absent → `local-process`; existing v1 files parse unchanged) and a
`container` block (image override, workspace root, extra allowlist domains).
Container lanes fail fast at fleet start with a clear operator message when
the Docker daemon is unreachable — matching the fleet's existing
all-lanes-construct-or-abort posture. Full `runtimes.yaml` capability
profiles (§11) wait for campaign 8, when a second adapter makes them real;
inventing the schema now with one consumer would be speculation.

## Pinning and observability

Container lanes pin exactly what executes: `runtime` stays the provider name,
`runtimeVersion` becomes `<cliVersion>+<imageDigest12>` (CLI version from the
image label, digest from the resolved image) so a rebuilt image is a visible
identity change under C1's replay-immutable pinning. `promptsSha` stays
unfed — that slot belongs to campaign 4's prompt files. Container lifecycle
moments (image resolved, container started, teardown begun) surface through
the existing sanitized bounded activity labels; raw docker output never
crosses, same as raw provider payloads today.

## Error handling

- **Timeout / interrupt** → `docker stop` with the configured grace, then
  kill; same observable outcomes as the process-group path.
- **Container dies mid-run** → the launcher's completion promise rejects into
  the existing error-settle path; `--rm` plus the label sweep guarantees no
  residue. "The container's death is uneventful" is the roadmap's exit
  wording and is asserted by a test.
- **Worker dies** → C1's heartbeat sweep already settles the run (heartbeats
  are host-side, unchanged); the labeled-container sweep at next fleet start
  removes the orphan.
- **Workspace create fails** → launch fails before any run state exists;
  the claim settles as error through the existing path.
- **Docker daemon down** → container lanes refuse to start, loudly, at fleet
  construction; local-process lanes are unaffected.

## Testing

- **Unit** (always run): WorkspaceManager against temp git repos
  (create/branch/harvest/remove, hook-file planted in clone never executes on
  host during harvest); fleet config v2 parsing including v1 files unchanged;
  `docker run` argument construction as a pure function (mounts, env
  allowlist, limits, labels, proxy env).
- **Integration** (`npm run test:container`, requires daemon; skips loudly,
  never silently): agent image builds and tag-skip works; stub runs in a
  container and round-trips the envelope; direct egress from the agent
  network fails while an allowlisted domain via the proxy succeeds;
  `docker kill` mid-run yields the error outcome and no leftover container.
- **E2e** (same gate): full board + fleet with one container lane — a wake is
  claimed, the stub executes in a real container against the task clone, the
  envelope settles the run, the `task/<id>` branch is harvested into the
  source repo, workspace and container are gone. This is the campaign's exit
  criterion.
- **Manual smoke** (script, run once per CLI): a real Codex or Claude call
  inside the container, verifying model-API reachability through the proxy
  and each CLI's proxy honoring. Not in CI; costs tokens.

The stub runtime is a small executable baked into the image that reads the
stdin context and emits a deterministic valid envelope (plus modes for
misbehavior: invalid envelope, hang, nonzero exit) — the same seam the
launcher tests use today, now exercised across a real container boundary.

## Alternatives considered

- **Literal `git worktree` + main `.git` mounted read-write** (§10's
  wording): cheapest disk and trivially harvested, but commits write shared
  objects and refs, so the mount must be read-write, and hook/config tampering
  in the shared `.git` escalates to host code execution. Rejected for the
  container boundary; recorded as the deliberate deviation above.
- **Hardlinked local clone** (`git clone` default on same filesystem):
  near-instant, but shared inodes let the container corrupt main-repo object
  files. `--no-hardlinks` costs seconds on this repo; revisit per-repo at
  campaign 8 onboarding if a large product repo makes copies painful.
- **Worker inside the container** (container polls the board itself): puts
  the board token inside the containment boundary, breaking the standing
  invariant that it never reaches the agent process. Rejected.
- **Long-lived container per task + `docker exec` per stage**: more faithful
  to "container per task" once stages exist, but stages don't until campaign
  4, and artifacts are filesystem-based in the workspace (which outlives the
  container) — so exec adds lifecycle states for no present benefit. The
  adapter seam permits this change later without touching callers.
- **dockerode / testcontainers dependency**: richer API, but the repo runs on
  three runtime dependencies by policy and the launcher needs only
  run/stop/ps/build with strict argument control.
- **iptables / pf-based egress control**: kernel-enforced and
  domain-agnostic, but requires root on the host or CAP_NET_ADMIN in
  containers; not portable to Docker Desktop on macOS, where the daemon runs
  in a hidden VM. Proxy + internal network is the strongest portable option.
- **YAML `config/runtimes.yaml` now** (§11's eventual shape): would add a
  YAML dependency and invent a multi-runtime schema with a single consumer.
  The versioned fleet JSON already has the load/validate rigor; capability
  profiles land in campaign 8 with the second adapter.
