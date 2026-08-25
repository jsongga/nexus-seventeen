# Second Runtime + Onboarding Task Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate vendor CLI knowledge behind runtime adapters emitting an internal event schema, add capability profiles and prompts-as-files (wiring `promptsSha`), and ship onboarding as a run-once-per-project pipeline task type — proven by a claude-lane onboarding e2e and a synthetic third-runtime e2e.

**Architecture:** New `src/server/agents/runtime/` package: `RuntimeEvent` union + `RuntimeAdapter` interface + codex/claude adapters extracted behavior-preserving from `agent-envelope.ts`/`provider-activity.ts`, an injectable registry, and vendor-neutral derivation. Launchers stream `RuntimeEvent`s; the worker derives labels/estimates/phases. Capability data moves to `config/runtimes.json`; prompt prose moves to `prompts/*.md` hashed into the claim pin. Onboarding = contract `taskType` + v24 link table + onboarding prompts + settle-time deliverable validation + gap-report artifact.

**Tech Stack:** TypeScript / Node 24, better-sqlite3, node:test runtime suite, vitest web suite. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-second-runtime-onboarding-design.md` (seam facts: `.superpowers/sdd/campaign8-exploration.md`)

## Global Constraints

- **No new dependencies; JSON config only** (no YAML). Config loaders follow `src/server/agents/task-fleet/config.ts` discipline: O_NOFOLLOW, size-bounded (≤1 MiB), hand-rolled validators, fail-closed.
- **Behavior-preserving extraction**: Tasks 1–2 and 4 must keep every existing assertion passing — assertions may relocate, never weaken. Task 4 requires byte-identical assembled prompts (golden snapshot before refactor).
- **Schema v24 is additive-only**: `CREATE TABLE IF NOT EXISTS` + index, no CHECK rebuild. Golden fixture `tests/server/task-board/fixtures/v23-schema.sql` (dump of current v23) + migration assertions in the existing drift/migration suites.
- **Forward-tolerant web parsing** for any new enum value (unknown `taskType` renders, never crashes).
- **`redactForPersistence` at every new durable free-text ingress** (`src/server/shared/redact.ts`) — the gap report artifact ingress in Task 6 explicitly.
- **`structuredOutcome` stays strict**: any RESULT_SCHEMA addition is `optional` + explicitly validated; unknown keys still rejected.
- **Gate per task** (run outside any implementer sandbox): `npm run typecheck:all && npm run test:all`. Docker tier (`npm run test:container`) and Playwright run at campaign close.
- **Never push to GitHub.** Implementers do not commit; the controller stages and commits.
- Contract enums live in `src/shared/task-board-contract/index.ts` and are single-sourced into SQL CHECKs via the existing `sqlStringList` pattern — but Task 5's new table needs no CHECK (values validated in code).

---

### Task 1: Runtime adapter modules + internal event schema (pure, parity-tested)

Create the `runtime/` package alongside the existing vendor code without changing any consumer. Old and new implementations coexist; parity tests prove equivalence line-for-line. Nothing outside the new package + its tests changes except adding exports.

**Files:**
- Create: `src/server/agents/runtime/events.ts`, `src/server/agents/runtime/adapter.ts`, `src/server/agents/runtime/codex.ts`, `src/server/agents/runtime/claude.ts`, `src/server/agents/runtime/registry.ts`, `src/server/agents/runtime/derive.ts`
- Read (source of extracted logic, unchanged in this task): `src/server/agents/task-worker/agent-envelope.ts` (`codexProviderArgs`, `claudeProviderArgs`, `providerEnvironment`, `providerResult`), `src/server/agents/task-worker/provider-activity.ts` (`activityFromProviderLine`, `estimateMinutesFromProviderLine`, `phaseSignalFromProviderLine`, `LivePhaseSignal`)
- Test: `tests/server/agents/runtime/adapters.test.ts`, `tests/server/agents/runtime/derive.test.ts`

**Interfaces:**
- Produces (later tasks consume verbatim):
  ```ts
  // events.ts
  export type RuntimeEvent =
    | { readonly type: "stage_started" }
    | { readonly type: "message_delta"; readonly text: string }
    | { readonly type: "tool_call"; readonly name: string; readonly detail: string }
    | { readonly type: "tool_result"; readonly name: string; readonly output: string }
    | { readonly type: "stage_finished" }
    | { readonly type: "error"; readonly detail: string };
  // adapter.ts
  export interface RuntimeAdapter {
    readonly runtime: string;
    args(options: ProviderArgumentOptions, role: AgentRole): readonly string[];
    environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    events(line: string): readonly RuntimeEvent[];
    result(stdout: string): unknown;
  }
  // codex.ts / claude.ts
  export const codexAdapter: RuntimeAdapter;   // runtime: "codex"
  export const claudeAdapter: RuntimeAdapter;  // runtime: "claude"
  // registry.ts
  export interface RuntimeRegistry { get(id: string): RuntimeAdapter | null; ids(): readonly string[]; }
  export function runtimeRegistry(adapters: readonly RuntimeAdapter[]): RuntimeRegistry;
  export function defaultRuntimeRegistry(): RuntimeRegistry;  // codex + claude
  // derive.ts (logic ported from provider-activity.ts marker scanning)
  export function activityFromEvent(event: RuntimeEvent): string | null;
  export function estimateMinutesFromEvent(event: RuntimeEvent): number | null;
  export function phaseSignalFromEvent(event: RuntimeEvent): LivePhaseSignal | null;  // re-export LivePhaseSignal from derive.ts
  ```

**Event mapping rules** (from the as-built vendor parsing — see exploration §1 "Live activity" and "Output parsing"):
- codex: process-start sentinel line (first parsed JSONL object) → `stage_started` once; `item.completed` with `item.type==="agent_message"` → `message_delta{text}`; `item.started`/`item.completed` with `item.type==="command_execution"` → `tool_call{name:"command", detail:<command>}` / `tool_result{name:"command", output:<aggregated_output>}`; `turn.completed` → `stage_finished`; `turn.failed`/`error` → `error{detail}`. Unparseable lines → `[]`.
- claude: `type:"system" subtype:"init"` → `stage_started`; assistant text deltas → `message_delta`; assistant `tool_use` → `tool_call{name, detail:<input summary>}`; `type:"user"` `message.content[].tool_result` → `tool_result{name:"tool", output:<content>}`; `type:"result"` → `stage_finished`; error-shaped results → `error`. Unparseable lines → `[]`.
- The exact field paths come from the current `provider-activity.ts` branches — port them, do not re-derive from vendor docs.

**Steps:**
- [ ] Write parity tests first, using representative captured lines for each vendor (take the fixture lines already used by `tests/server/agents/task-worker/` suites; add lines for estimate marker `STEWARD_ESTIMATE_MINUTES=7`, phase marker `STEWARD_PHASE_JSON={...}`, plain command output, agent message, turn/result terminals, error terminals). For each line L and provider P assert:
  - `activityFromProviderLine(P, L) === (adapter.events(L).map(activityFromEvent).find(v => v !== null) ?? null)`
  - same equivalence for `estimateMinutesFromProviderLine` / `estimateMinutesFromEvent` and `phaseSignalFromProviderLine` / `phaseSignalFromEvent` (deep-equal signals)
  - `adapter.args(options, role)` deep-equals `codexProviderArgs(options, role)` / `claudeProviderArgs(options, role)` for every role in `AGENT_ROLES`
  - `adapter.environment(src)` deep-equals `providerEnvironment(P, src)`
  - `adapter.result(stdout)` deep-equals `providerResult(P, stdout)` for success fixtures and throws where `providerResult` throws
- [ ] Run the new tests; they fail (modules absent).
- [ ] Implement the six modules by porting logic (adapters may call small shared helpers; do not import from `provider-activity.ts` — copy, because Task 2 deletes it).
- [ ] Event-shape unit tests: each mapping rule above gets a direct assertion (line → expected `RuntimeEvent[]`).
- [ ] `npm run typecheck:all && npm run test:all` → green (old suites untouched).

---

### Task 2: Rewire launchers and worker onto adapters; delete vendor branching

**Files:**
- Modify: `src/server/agents/task-worker/types.ts` (`AgentRunHandle.activity: AsyncIterable<RuntimeEvent>`), `src/server/agents/task-worker/contained-cli-launcher.ts` (options `provider` → `adapter: RuntimeAdapter`; spawn command = `adapter.runtime`; per-line `adapter.events(line)` pumped into `activity`), `src/server/agents/task-container/container-launcher.ts` + `src/server/agents/task-container/arguments.ts` (same swap; container command default `agentCommand ?? adapter.runtime`), `src/server/agents/task-worker/worker.ts` (`#forwardActivity` consumes `RuntimeEvent`s: `activityFromEvent` → `ActivityBuffer` → `appendRunOutput`; `estimateMinutesFromEvent` → `updateTaskEstimate`; `phaseSignalFromEvent` → phase APIs; `error` events feed failure detail), `src/server/agents/task-fleet/runtime.ts` (`createTaskFleetWorker` resolves the adapter from an injectable `RuntimeRegistry` option, default `defaultRuntimeRegistry()`, by `config.provider`; unknown id → construction error), `src/server/agents/task-worker/agent-envelope.ts` (delete `codexProviderArgs`, `claudeProviderArgs`, `providerEnvironment`, `providerResult` — adapters own them)
- Delete: `src/server/agents/task-worker/provider-activity.ts` (move `ActivityBuffer`, `estimateActivity`, `phaseActivity`, `LivePhaseSignal` into `src/server/agents/runtime/derive.ts`; update the Task 1 re-export to the real home)
- Test: update `tests/server/agents/task-worker/contained-cli-launcher.test.ts`, `.../worker.test.ts`, `.../helpers.ts` (in-memory launcher doubles emit `RuntimeEvent`s), `tests/server/agents/task-container/container-launcher.test.ts`, `tests/server/agents/task-fleet/{runtime,fleet}.test.ts`; delete `provider-activity` parity halves from Task 1 tests (keep the event-shape assertions — they are now the only spec)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `ContainedCliAgentLauncherOptions.adapter: RuntimeAdapter` (replaces `provider`); `ContainerAgentLauncherOptions.adapter: RuntimeAdapter`; `CreateTaskFleetWorkerOptions.registry?: RuntimeRegistry`. `AgentRunHandle.activity: AsyncIterable<RuntimeEvent>`.

**Steps:**
- [ ] Update the in-memory launcher double in `tests/server/agents/task-worker/helpers.ts` to emit `RuntimeEvent`s; adjust worker tests to assert the same persisted labels/estimates/phases as today (the derived strings must not change — `ActivityBuffer` output identical).
- [ ] Rewire both launchers: replace the `observeLine` triple with a single per-line `adapter.events(line)` pump; keep byte caps, group-kill, stdin prompt, timeout semantics untouched. Terminal path calls `adapter.result(stdout)` then `structuredOutcome` exactly where `providerResult` was called.
- [ ] Rewire `createTaskFleetWorker`; `parseTaskFleetConfig` keeps the `"codex"|"claude"` validation this task (Task 3 relaxes it).
- [ ] Delete `provider-activity.ts` and the dead `agent-envelope.ts` exports; sweep compile errors (the exploration prices ~10 files touching `AgentProvider` — mechanical).
- [ ] `npm run typecheck:all && npm run test:all` → green. The pipeline e2e (codex-shaped fake CLIs) passing unchanged is the behavior-preservation proof.

---

### Task 3: Capability profiles (`config/runtimes.json`)

**Files:**
- Create: `src/server/agents/runtime/profiles.ts`, `config/runtimes.json`
- Modify: `src/server/agents/runtime/adapter.ts` + `codex.ts` + `claude.ts` (`args(options, role, profile: RuntimeProfile)`: sandbox level read from `profile.roles[role].sandbox`; missing role entry or unknown sandbox value → throw `RuntimeCapabilityError`), `src/server/agents/task-fleet/config.ts` (`provider: string` — closed union dropped; new optional `runtimesConfigPath: string`), `src/server/agents/task-fleet/main.ts` (resolve default `config/runtimes.json` from cwd), `src/server/agents/task-fleet/runtime.ts` (load profiles once; construction error if `config.provider` ∉ registry ∩ profiles; pass profile into launcher options; spawn command = `profile.binary`; version capture label parameterized by runtime id), `src/server/agents/task-worker/contained-cli-launcher.ts` + `container-launcher.ts` (options gain `profile: RuntimeProfile`, forwarded to `adapter.args`), `src/server/agents/task-fleet/errors.ts` or wherever `classifyTaskFleetError` lives (`RuntimeCapabilityError` classifies **POISONED** — quarantine, never hot-retry)
- Test: `tests/server/agents/runtime/profiles.test.ts`, update `tests/server/agents/task-fleet/{config,runtime}.test.ts`, launcher tests gain a capability-error case

**Interfaces:**
- Produces:
  ```ts
  export interface RuntimeRoleProfile { readonly sandbox: string }
  export interface RuntimeProfile {
    readonly runtime: string; readonly binary: string; readonly permissionModel: string;
    readonly roles: Readonly<Partial<Record<AgentRole, RuntimeRoleProfile>>>;
    readonly mcp: boolean; readonly toolCallGranularity: string; readonly contextNotes: string;
  }
  export interface RuntimeProfiles { readonly version: 1; readonly runtimes: ReadonlyMap<string, RuntimeProfile> }
  export function parseRuntimeProfiles(value: unknown): RuntimeProfiles;
  export async function loadRuntimeProfiles(path: string): Promise<RuntimeProfiles>;  // O_NOFOLLOW, ≤1 MiB
  export class RuntimeCapabilityError extends Error { readonly runtime: string; readonly role: string }
  ```
- `config/runtimes.json` content: exactly the spec's block (codex: binary `codex`, permissionModel `cli-sandbox-flags`, roles engineer/workspace-write, verifier/read-only, manager/read-only, mcp false, granularity `command`; claude: binary `claude`, permissionModel `permission-modes`, roles engineer/acceptEdits, verifier/dontAsk, manager/plan, mcp true, granularity `tool`).

**Steps:**
- [ ] Failing tests: `parseRuntimeProfiles` accepts the shipped file; rejects unknown version, missing binary, non-record roles, unknown role key, empty sandbox; `loadRuntimeProfiles` rejects >1 MiB and symlinks (copy the fleet-config test patterns).
- [ ] Implement loader; commit shipped `config/runtimes.json`.
- [ ] Failing tests: codex adapter args for engineer under a profile with sandbox `read-only` actually emits `--sandbox read-only` (profile drives argv); missing role entry throws `RuntimeCapabilityError`; `classifyTaskFleetError(new RuntimeCapabilityError(...))` → POISONED; `createTaskFleetWorker` with provider `"ghost"` fails construction naming the missing profile.
- [ ] Implement: thread profile through fleet → launcher → adapter; sandbox hard-coding in adapters replaced by profile lookup (default file preserves today's exact argv — assert codex/claude argv unchanged under the shipped profiles).
- [ ] `npm run typecheck:all && npm run test:all` → green.

---

### Task 4: Prompts as files + `promptsSha` pinning

**Files:**
- Create: `prompts/*.md` (one file per fixed-prose block in `agentPrompt()` — the role/mode blocks: intake, engineer, engineer-fix (fix-round block), reviewer (pipelineReview), verifier, designer, oversight, pipeline-implementation, plus the shared trailer block; final file list = whatever split reproduces the assembly byte-identically, each file named for its branch), `src/server/agents/task-worker/prompt-registry.ts`
- Modify: `src/server/agents/task-worker/agent-envelope.ts` (`agentPrompt(request, prompts: PromptRegistry)`; fixed prose comes from `prompts.render(name, vars)`; dynamic data — context JSON, plan rendering, bright-line interpolation — stays in code), both launchers (options gain `prompts: PromptRegistry`, used at stdin write), `src/server/agents/task-fleet/runtime.ts` + `config.ts` + `main.ts` (`promptsRoot?: string`, default `<cwd>/prompts`; registry loaded once per lane; `promptsSha` included in the pin passed to `TaskWorker`), `src/server/agents/task-worker/types.ts` (`ClaimedRunPinning` gains `promptsSha: string | null`), worker claim path (send `promptsSha` in `ClaimRunPinning`; divergence on replay = existing `run_pinning_diverged` diagnostic, now covering prompts)
- Test: `tests/server/agents/task-worker/prompt-registry.test.ts`, golden-snapshot test in `tests/server/agents/task-worker/agent-envelope-pipeline.test.ts` (see steps), update fleet/worker tests for the pin

**Interfaces:**
- Produces:
  ```ts
  export class PromptRegistry {
    static loadSync(root: string): PromptRegistry;    // *.md, ≤64 KiB each, sha256 per file
    get promptsSha(): string;                          // sha256 over sorted (name, digest) pairs
    render(name: string, vars: Readonly<Record<string, string>>): string;  // {{placeholder}}; throws on unknown name, unknown placeholder in vars, unfilled placeholder in template
  }
  ```
- Consumes: launcher/fleet option threading from Tasks 2–3.

**Steps:**
- [ ] **Golden first**: add a snapshot test capturing `agentPrompt(request)` output for a context matrix (manager intake; engineer pipeline-implementation with declared scope + bright lines; engineer fix round; verifier machine; reviewer with prior findings; designer hazardous; oversight) using the current literal implementation. Store snapshots as fixture files.
- [ ] Failing registry tests: load/digest determinism (same files → same sha; renamed file → different sha), size cap, unknown-name throw, unfilled-placeholder throw, unknown-var throw.
- [ ] Implement `PromptRegistry`; extract prose into `prompts/*.md` with `{{placeholder}}` slots; rewrite `agentPrompt` to assemble via `render`.
- [ ] Snapshot test passes **byte-identical** against the pre-refactor fixtures.
- [ ] Pin wiring: fleet computes `promptsSha` at lane construction and passes it through `ClaimRunPinning`; assert a production-path claim (fleet runtime test or worker test) now carries a non-null `promptsSha` and that it lands in the `runs.prompts_sha` column (board test); replayed claim with a different sha logs `run_pinning_diverged`.
- [ ] `npm run typecheck:all && npm run test:all` → green.

---

### Task 5: Onboarding intake — contract, schema v24, planning branch, prompts, UI

**Files:**
- Modify: `src/shared/task-board-contract/index.ts` (`export const WORK_ITEM_TASK_TYPES = ["standard", "onboarding"] as const;` + `WorkItemTaskType`; `CreateWorkItemRequest` gains `taskType?: WorkItemTaskType`; `WorkItem` view gains `taskType: WorkItemTaskType`; `BoundedAgentContext` gains `onboarding?: true`; parse/serialize helpers updated), `src/server/task-board/persistence/store.ts` (SCHEMA_VERSION 24; additive block:
  ```sql
  CREATE TABLE IF NOT EXISTS work_item_onboarding_tasks (
    work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id),
    project_id   TEXT NOT NULL REFERENCES projects(project_id),
    task_id      TEXT NOT NULL REFERENCES tasks(task_id),
    created_at   TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS onboarding_once_per_project ON work_item_onboarding_tasks(project_id);
  ```
  ), `src/server/task-board/collaborators/work-items.ts` (createWorkItem accepts `taskType`; onboarding requires a `projectTarget` resolving to an existing project → else typed 400 `ONBOARDING_PROJECT_REQUIRED`; existing link row for the project → typed 409 `ONBOARDING_EXISTS`; link row inserted in the create transaction; planning task objective `Onboard project: <name>` and acceptance criteria instructing a single-node v2 plan whose declared scope covers `README.md`, `docs/**`, and the Dockerfile and whose criteria name the §6 deliverables; claim context gains `onboarding: true`), `src/server/task-board/service.ts` (route passes `taskType`; work-item reads join the link table to populate `taskType`), `src/server/agents/task-worker/agent-envelope.ts` (+ `prompts/onboarding-intake.md`, `prompts/onboarding-engineer.md`: when context carries `onboarding`, intake uses onboarding-intake (plan the §6 deliverable node), and pipeline-implementation uses onboarding-engineer — instructions to create the five doc slots create-if-missing with §2 headings, write the fenced ```json VerifyContract block into `docs/workflow.md` mapping the repo's layout, add an `agent` Dockerfile target when a Dockerfile exists, and return a `gapReport` markdown field listing everything not producible, always including branch protection while GitHub is deferred), `src/server/agents/task-worker/types.ts` + context validation (accept `onboarding`), web: `src/web/task-board/views/CreateDialogs.tsx` (task-type select, default standard) + the model parse (unknown `taskType` string tolerated, rendered verbatim)
- Create: `tests/server/task-board/fixtures/v23-schema.sql` (dump of current schema before this migration — follow the v22 fixture's generation comment)
- Test: `tests/server/task-board/onboarding-intake.test.ts` (+ drift/migration suite updates, `contract-drift.test.ts` columns, web vitest for the select + tolerant parse)

**Interfaces:**
- Consumes: `PromptRegistry` (Task 4).
- Produces: `WORK_ITEM_TASK_TYPES`, `WorkItemTaskType`, `WorkItem.taskType`, `BoundedAgentContext.onboarding`, error codes `ONBOARDING_PROJECT_REQUIRED` (400) and `ONBOARDING_EXISTS` (409), table `work_item_onboarding_tasks`, prompt names `onboarding-intake` / `onboarding-engineer`. Task 6 keys its settle branch off the link table.

**Steps:**
- [ ] Failing tests: onboarding create without project target → 400; with unknown project → 400; second onboarding for same project → 409 (first row survives); successful create writes the link row, `WorkItem.taskType === "onboarding"`, planning task objective/criteria match the strings above, claim context (via the existing claim test helpers) carries `onboarding: true`; standard items unchanged (`taskType === "standard"`, no row).
- [ ] Migration tests: v23 fixture upgrades cleanly; fresh create and upgraded DB agree (existing drift-suite pattern); `contract-drift.test.ts` covers the new table.
- [ ] Implement contract + schema + collaborator + service + prompts + web.
- [ ] `npm run typecheck:all && npm run test:all` → green.

---

### Task 6: Onboarding settle validation + gap-report artifact + surfacing

**Files:**
- Modify: `src/server/agents/task-worker/agent-envelope.ts` (RESULT_SCHEMA gains optional `gapReport: string`; `structuredOutcome` accepts and threads it — `AgentRunOutcome` gains `gapReport?: string`; regenerate `scripts/write-agent-result-schema.mjs` output), `src/server/task-board/collaborators/runs.ts` (in `settleActiveRunInTransaction`, at the same phase as `scopeCheckForSettlement` (`runs.ts:760/781`): when the settling attempt's work item has a `work_item_onboarding_tasks` row and the stage is `implementation` with outcome `completed`, run onboarding deliverable validation; any failure → structured settlement error `ONBOARDING_DELIVERABLES_MISSING` with a detail listing every missing item, same rejection shape as `WORKFLOW_PLAN_REQUIRED` so the normal fix loop engages), new helper `src/server/task-board/collaborators/onboarding-check.ts`:
  ```ts
  export interface OnboardingCheckResult { readonly ok: boolean; readonly missing: readonly string[] }
  export function onboardingDeliverablesCheck(repoPath: string, branch: string, gapReport: string | undefined): OnboardingCheckResult
  ```
  — checks via `git show <branch>:<path>` (spawn like the scope check does): `README.md`, `docs/architecture.md`, `docs/interface.md`, `docs/dependencies.md`, `docs/workflow.md` exist non-empty; `docs/decisions/` non-empty via `git ls-tree`; `parseVerifyContract(workflowMd)` (`src/server/agents/verify/contract.ts:136`) parses; `gapReport` is a non-empty string. Each failure appends a human-readable line to `missing`.
- Modify: gap-report persistence — on successful onboarding-implementation settle, write `ArtifactStore.create` (`src/server/task-board/persistence/artifacts.ts`) with media `text/markdown`, content `redactForPersistence(gapReport)`, linked to project/node/task; emit a `project_events` row (`event_type: "node_completed"` already fires — add summary mention `onboarding gap report recorded`) — reuse the existing event helper, no new event type. Surface: work-item detail response includes `gapReportArtifactId: string | null` for onboarding items; web work-item detail view renders a "Gap report" section fetching the artifact content through the existing artifact content route (add `GET /v1/artifacts/:artifactId/content` to `service.ts` only if no content route exists yet — check `service.ts` first).
- Test: `tests/server/task-board/onboarding-settle.test.ts`, web vitest for the gap-report section

**Interfaces:**
- Consumes: link table + context flag (Task 5), `parseVerifyContract`, `ArtifactStore`, `redactForPersistence`.
- Produces: settlement error code `ONBOARDING_DELIVERABLES_MISSING`; `gapReport` in RESULT_SCHEMA/`AgentRunOutcome`; `gapReportArtifactId` on onboarding work-item detail. Task 7's arc asserts all three.

**Steps:**
- [ ] Failing tests (fixture git repo + boardFixture): settle of an onboarding implementation attempt missing `docs/interface.md` → rejected `ONBOARDING_DELIVERABLES_MISSING` naming it, attempt enters the normal fix path; unparseable workflow.md contract → rejected naming the parse error; empty/absent `gapReport` → rejected; complete deliverables → settles, artifact exists with redacted markdown content, `gapReportArtifactId` populated, standard items bypass the branch entirely.
- [ ] Implement `onboarding-check.ts`, the settle branch, RESULT_SCHEMA addition, artifact write, route/read surfacing, web section.
- [ ] `npm run typecheck:all && npm run test:all` → green.

---

### Task 7: E2E arcs — claude-lane onboarding + synthetic third runtime

**Files:**
- Create: `tests/server/task-board/onboarding-e2e.test.ts` (arc 1), `tests/server/task-board/runtime-e2e.test.ts` (arc 2)
- Modify: `tests/server/task-board/helpers.ts` (or the e2e's local helpers): claude-shaped fake CLI sources — `claudeManagerCliSource`, `claudeOnboardingEngineerCliSource`, `claudeVerifierCliSource` emitting stream-json (`{"type":"system","subtype":"init"}`, tool_result progress lines, terminal `{"type":"result","structured_output":{...}}`) via `fakeCli(root, "claude", source)`; the onboarding engineer source creates the five doc slots + valid fenced VerifyContract + `agent` Dockerfile target in `process.cwd()`, commits, and returns a result with a non-empty `gapReport` (listing branch protection)

**Interfaces:**
- Consumes: everything. No new production code — if an arc exposes a product defect, fix it in the task that owns the seam and note it in the report.

**Steps:**
- [ ] **Arc 1 (both roadmap exits' onboarding half + second runtime):** build a fixture *external* repo (fresh git repo with a `package.json`, one source file, a Dockerfile without an `agent` target, no docs/) — not the board's own repo. Register it as a project; create an onboarding work item; run fleet lanes configured `provider: "claude"` under the shipped `config/runtimes.json`; drive: planning (claude manager) → plan gate confirm → implementation (claude onboarding engineer writes deliverables) → settle validation passes → machine verify green **using the contract the engineer just wrote** (its rules must map `docs/**` and `Dockerfile` to `none`/`fixed` actions) → review/verification per template → final approval → merged. Assert: merged branch contains the five slots + decisions ADR + agent Dockerfile target; `parseVerifyContract` parses the merged workflow.md; gap-report artifact exists and mentions branch protection; `runs.runtime === "claude"` and `runs.prompts_sha` non-null on every claim.
- [ ] **Arc 2 (one-adapter-one-profile exit):** define, entirely inside the test file: `acmeAdapter: RuntimeAdapter` (runtime `"acme"`, distinct line protocol — e.g. `EVT {"kind":"call","cmd":...}` lines and terminal `RESULT {...}` — mapped to `RuntimeEvent`s) and a temp runtimes config = shipped profiles + an `acme` entry (binary `acme`, roles for all three). PATH-shim `fakeCli(root, "acme", …)` sources speaking that protocol. Run a **standard** work item end to end (plan → gate → implement → verify → review → approve → merge) with lanes on `provider: "acme"`, registry `runtimeRegistry([codexAdapter, claudeAdapter, acmeAdapter])`. The test adds ONE adapter object + ONE profile entry and no other production change — that is the exit criterion, executable. Assert merged + `runs.runtime === "acme"`.
- [ ] `npm run typecheck:all && npm run test:all` → green.

---

## Self-review

- **Spec coverage:** internal event schema + adapters (T1–2), profiles + fail-closed capability (T3, launch-time POISONED per the fleet-config reality — spec amendment at close), prompts-as-files + promptsSha (T4), onboarding intake/uniqueness/prompts (T5), §6 deliverables + validation + gap report (T6), both exit-criteria arcs (T7). Deferred per spec: durable event journal, real third vendor, branch protection, live Cicada onboarding.
- **Placeholder scan:** clean — extraction tasks intentionally reference the as-built code being moved (with file:line anchors) rather than restating it; parity/golden tests pin equivalence.
- **Type consistency:** `RuntimeAdapter.args` gains its `profile` param in T3 (T1 defines the two-arg form; T3 explicitly changes it) — the one deliberate signature evolution; all other names verified consistent across tasks.
