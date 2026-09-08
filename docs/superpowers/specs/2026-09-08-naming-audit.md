# Naming audit (roadmap 9.7) — what the words mean, and which ones lie

**Status** Draft · **Author** Claude (read-only audit) · **Date** 2026-09-08 · **Scope** naming
only, zero behaviour change. Supersedes `2026-08-28-naming-audit-design.md`, none of whose tiers
were executed (`docs/GLOSSARY.md` does not exist; `collaborators/runtime.ts`,
`merge-executor.ts`, `arguments.ts`, `tests/tooling/`, `docker_image/` are all unchanged).

## What this is about

Nexus Seventeen is a task board where a person files a request and short-lived Codex or Claude
agents carry it out. Its vocabulary grew one campaign at a time, and the same English words got
re-used at different layers. This audit asks one question of each word:

> **Would a reader who learned this word in one file be _wrong_ when they meet it in another?**

That question splits every finding in two, and the split is the whole point:

| Kind                                        | Example                                                                                         | Cost                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **One word, two concepts** — an _ambiguity_ | `provider` is both the Codex/Claude CLI **and** the upstream repository publishing an interface | A reader forms a false belief and acts on it. Real defect. |
| **Two words, one concept** — a _synonym_    | a fleet entry is called a "lane", a "worker" and an "agent"                                     | A reader is confused, then correct. Cosmetic.              |

Ranking by occurrence count would invert this: `stage` appears in 988 places and `host` in a
dozen, but both mislead, and one of the `host` pair is two lines from the other.

**Headline:** 11 genuine ambiguities, 7 synonym clusters, and roughly 90 identifiers that cannot
be renamed without a database or deployment migration. The worst single problem is the word
**task**, because it is user-facing, it means two different things on one screen, and the button
labelled "Add task" does not create a task.

---

## Part 1 — Ambiguities, ranked by reader harm

### A1. `task` — the button labelled "Add task" creates a **work item**

Two entities exist. A **`WorkItem`** is the human's request and its lifecycle (`work_items`,
`persistence/store.ts:422`). A **`BoardTask`** is one unit of agent work assigned to one agent
(`tasks`, `persistence/store.ts:633`). The UI calls both "task", on one page:

| UI string                                        | File:line                                      | Actually refers to                       |
| ------------------------------------------------ | ---------------------------------------------- | ---------------------------------------- |
| `aria-label="Add task"`                          | `src/web/BoardApp.tsx:960`                     | opens the **WorkItem** dialog            |
| `title="Add a task"`                             | `src/web/views/CreateDialogs.tsx:90`           | renders `<WorkItemForm>` (`:94`)         |
| `<FieldLabel>Task</FieldLabel>`, `"Submit task"` | `src/web/views/create/WorkItemForm.tsx:71,158` | `WorkItem.originalRequest`               |
| `Task List` heading                              | `src/web/BoardApp.tsx:946`                     | the **WorkItem** list                    |
| `Board tasks` heading                            | `src/web/BoardApp.tsx:1048`                    | the **BoardTask** list, ~100 lines below |
| `refinement: "Improving task"`                   | `src/web/model/work-item-labels.ts:83`         | a **WorkItem** stage pill                |

`src/web/views/TaskList.tsx` exports both `WorkItemRow` (`:69`) and `TaskRow` (`:257`) — the
collision in one file. The contract itself is infected: a work item's category field is
`WORK_ITEM_TASK_TYPES = ["standard", "onboarding"]` (`src/shared/task-board-contract/index.ts:194`),
so a _work item_ has a _task type_.

There is no consistent third word either. The same row is called four things across the app:
"task" (create), "Records a durable intake **request**" (`CreateDialogs.tsx:91`), "Automation
**intake**" (`BoardApp.tsx:1014`), "**Work-item** details" (`WorkItemDetail.tsx:604`).

### A2. `stage` — four enums, three sharing the same literal values

| Enum              | Values                                                                                                              | Defined                      | Persisted in                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| `WorkItemStage`   | refinement, project_resolution, research, planning, implementation, testing, verification, human_review, deployment | `index.ts:318`               | `work_items.current_stage`                         |
| `WorkflowStage`   | research, planning, implementation, testing, verification                                                           | `index.ts:345`               | `stage_attempts.stage` CHECK (`store.ts:120`)      |
| `TaskPhaseStage`  | research, planning, **execution**, testing, **review**, done                                                        | `index.ts:160`               | `task_phases.stage` CHECK (`store.ts:329`)         |
| UI "Stage" column | queued / running / blocked …                                                                                        | `ThreadPipelineTable.tsx:59` | nothing — it renders a **`TaskStatus`** (`:11-16`) |

The literals `research`, `planning` and `testing` are stored in two tables meaning two different
things, so a SQL reader joining or filtering on `stage` is wrong without knowing which table they
are in. `WorkflowStage` is a strict subset of `WorkItemStage`'s tokens with different authority,
and `TaskPhaseStage` renames two of them (`implementation`→`execution`,
`verification`→`review`) for no stated reason. The fourth row is the cheapest fix and the most
misleading: a column headed "Stage" showing values that are not stages.

**The values are pinned** (SQL `CHECK` constraints over live rows). Only the _type names_,
_parameter names_ and _labels_ are renameable.

### A3. `provider` — the AI CLI, and also the repository across the seam

Two unrelated concepts, and the less-known one is the _more_ common (~125 vs ~42 occurrences):

| Sense  | Meaning                                                                                                                                                                                       | Anchor                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | which coding CLI runs the agent (`codex` / `claude`)                                                                                                                                          | `TaskFleetProvider` `task-fleet/types.ts:3`; fleet key `config.ts:139,153`; `STEWARD_TASK_WORKER_PROVIDER`                                                                |
| **P2** | in a cross-repo decomposition, the **upstream repository/work item that publishes `docs/interface.md`**; its counterpart is the _consumer_ (`splitBy: "consumer" \| "phase"`, `index.ts:468`) | `MigrateInterfaceProvider` `decomposition-readiness.ts:21`; wire fields `CrossRepoContext.providerProjectId / providerWorkItemId / providerRepoName` `index.ts:1183-1187` |

P2 reaches the model: `config/prompts.md:14` tells an agent _"Integrate against the provider's
PUBLISHED interface … never read or modify the provider's source"_ — while that same agent is
configured with `"provider": "codex"`. Both a human reader and the model can misresolve it.

P2 is _correct_ usage (provider/consumer is the standard pairing for a published interface).
P1 is the one that should move.

### A4. `runtime` — three `runtime.ts` files, and two meanings in one JSON object

| #   | Meaning                                             | Anchor                                                                                                              | ≈    |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---- |
| R1  | the coding CLI behind a port                        | `RuntimeAdapter { readonly runtime: string }` `agents/runtime/adapter.ts:29-30`; data in `config/runtimes.json`     | ~285 |
| R2  | **where** a worker runs: local process or container | `TaskFleetRuntimeKind = "local-process" \| "container"` `task-fleet/types.ts:5`; branch `task-fleet/runtime.ts:268` | ~30  |
| R3  | the board's shared state/eventing object            | `class TaskBoardRuntime` `collaborators/runtime.ts:70`                                                              | ~732 |
| R4  | the run's provenance pin — **persisted**            | `runs.runtime`, `runs.runtime_version` `store.ts:784-785`; `AgentRun.runtime` `index.ts:1146`                       | ~124 |
| R5  | the server build target                             | `tsconfig.runtime.json`, `build:runtime`, `Dockerfile:16`                                                           | ~51  |

R3 is isolated (it imports nothing from `agents/`), so its 732 occurrences are the _least_
harmful. The harmful one is small and concentrated: **one fleet `agents[]` entry can read**

```json
{ "provider": "codex", "runtime": "container" }
```

where `provider` **is** the runtime (R1) and `runtime` is **not** (R2) — parsed side by side at
`task-fleet/config.ts:139-145`, in a file whose top level also carries `runtimesConfigPath`
(R1's profile file). `README.md:115-165` documents `provider` and `runtimesConfigPath` and never
documents the `runtime` key at all.

**A3 + A4 have one joint fix, and the direction is already decided by the database.** The DB
persists this concept as `runtime` (`runs.runtime`, R4). Reversing that is a migration; adopting
it is a rename. So `runtime` wins for the CLI, and `provider` is freed for its correct P2 sense.
The proof of how bad the split is, in five lines (`agents/task-worker/main.ts:22-31`):

```ts
const provider = required("STEWARD_TASK_WORKER_PROVIDER");
const adapter = defaultRuntimeRegistry().get(provider);
if (adapter === null) throw new Error(`Unknown runtime adapter: ${provider}`);
const profile = (await loadRuntimeProfiles(runtimesConfigPath)).runtimes.get(provider);
if (profile === undefined) throw new Error(`Unknown runtime profile: ${provider}`);
```

An operator types `provider` and every error they can hit says `runtime`.

### A5. `workspace` — three concepts, two of them on the same screen

| Sense | Meaning                                                            | Anchor                                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1    | a **per-task git clone** on the worker host                        | `TaskWorkspaceManagerOptions.workspaceRoot` — _"Directory that holds one sub-directory per task workspace"_ `task-workspace/manager.ts:13-15`                                                         |
| W2    | the **project's source directory**, chosen when creating a project | `workspacePath` state `create/ProjectForm.tsx:58`; metadata label `"Workspace"` `model/project-metadata.ts:23-25`                                                                                     |
| W3    | the **app's navigation shell**                                     | `WorkspaceFrame` — _"Frames the workspace: the navigation rail beside the routed page"_ `views/WorkspaceSidebar.tsx:1`; eyebrow `"Workspace, Project Overview"` `views/workspace/ProjectPage.tsx:231` |

W2 and W3 render on the same project page: the metadata chip says "Workspace" (the folder) and
the page eyebrow says "Workspace" (the shell). W2 is also stale — since campaign 16 the modelled
name for this is a **repository** (`repositories.path`, `store.ts:612-615`), and
`ProjectForm.tsx:1`'s own header already says _"Collects a new project's **repository path**"_
while every identifier below it says `workspacePath`.

### A6. `executor` — five senses, and two of the names are simply wrong

| Sense                                                                                 | Anchor                                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| who runs an automation stage (`agent_type` / `machine_verify` / `human` / `disabled`) | `AutomationStageExecutor` `index.ts:534-538`                                                     |
| **an `AgentProfile`** — the board's word for a freshly minted agent identity          | `createLazyExecutorInTransaction(...): AgentProfile` `collaborators/agent-identities.ts:151-155` |
| a git-merge callback type                                                             | `PipelineMergeExecutor = typeof mergePipelineBranch` `collaborators/projects.ts:123`             |
| a promise-chaining mutex                                                              | `SerialExecutor` `task-worker/worker.ts:42-60`                                                   |
| an injected `spawn`                                                                   | _"Command executor injection for tests"_ `verify/runner.ts:16-17`                                |

And `collaborators/merge-executor.ts` contains **no executor** — five pure git functions
(`mergePipelineBranch` `:136` et al.).

### A7. `intake` — five senses, and it is not a state

`WORK_ITEM_STATES` (`index.ts:197-213`) has no `intake`; nothing persists the word.

| Sense                                                                                                 | Anchor                                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| a **URL route** whose payload is a `workItemId` — `#/intake/<id>` is the work-item detail page        | `routing.ts:5,80-81,113-114`                                                  |
| a **claim-context boolean** meaning "this run is the work item's planning run"                        | `context.intake` `claim-projection.ts:31-33`; read at `agent-envelope.ts:559` |
| a **prompt-section name** (`intake`, `intake-return`, `onboarding-intake`)                            | `prompt-registry.ts:21-24`                                                    |
| **UI copy** for the work-item queue: _"New requests enter durable intake"_, _"This stops the intake"_ | `BoardApp.tsx:949`; `WorkItemDetail.tsx:1037`                                 |
| test/helper filenames                                                                                 | `tests/server/task-board/concurrent-intake-worker.ts`                         |

`onboarding` is **not** a rival phase — it is a work-item _type_ that rides inside intake. The
same planning task is inserted into both `work_item_planning_tasks` and
`work_item_onboarding_tasks` (`collaborators/work-items.ts:931,941`), both branches transition to
`"planning"` (`:951-959`), and `onboarding` only selects a different prompt _inside_ the intake
branch (`agent-envelope.ts:723`). The two words are not parallel parts of speech, which is why
"onboarding-intake" reads like a third concept.

### A8. `host` — the filesystem, and the network interface, ten lines apart

`src/server/task-board/main.ts`:

```ts
listenHost: (process.env.STEWARD_TASK_BOARD_HOST ?? "127.0.0.1") …   // :26  network
host: { homeDir, projectRoots }                                       // :35  filesystem
```

`TaskBoardOptions.host: TaskBoardHostOptions` is the project-picker's browsable roots
(`config.ts:10-13,22`), `listenHost` is the bind address (`:15,23`), and the operator env var
named `..._HOST` is the _network_ one. Small blast radius, but the wrong reading is immediate.

### A9. `phase` — two levels of the hierarchy, disjoint vocabularies

`WorkItemPhase = ["expand","migrate","contract"]` (`index.ts:215`, column `work_items.phase`) is a
decomposed child's role in an expand–migrate–contract split. `TaskPhase` (`task_phases`,
`store.ts:324`) is an agent-reported sub-step of a BoardTask — and it _contains a field called
`stage`_, so `phase.stage` crosses both ambiguities at once.

### A10. `schema` — neither `schema.ts` is a schema

| File                                      | Header / content                                                                             | The real thing                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/server/task-board/schema.ts:1`       | _"HTTP/request adapter for the shared task-board runtime validator"_ — 38 `parse*` functions | every `CREATE TABLE` lives in `persistence/store.ts` |
| `src/server/agents/task-worker/schema.ts` | claim/journal parsers (`parseTaskWakeClaim` `:31`)                                           | —                                                    |

Meanwhile `tests/server/task-board/fixtures/v25-schema.sql` _is_ a schema. A reader looking for
the database opens the file named for it and finds HTTP validation.

### A11. `run` — the agent run, and the verify run

`runs` / `AgentRun` is one agent invocation (`store.ts:768`, `index.ts:1133`). A **verify run** is
a detached test-suite execution with its own id space and directory
(`verify_attempts.verify_run_id`, `.verify-runs/`, `verify/runner.ts:256`). Different lifecycles,
same noun. Low harm — they never appear in the same file.

---

## Part 2 — Synonyms (two words, one concept)

These confuse but do not mislead. All are copy- or identifier-level.

| #   | The one concept                           | The words used for it                                                                                                                                                                               | Sharpest citation                                                                                                                           |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | one entry in the fleet's `agents[]` array | **lane** / **worker** / **agent**                                                                                                                                                                   | `views/TaskDetail.tsx:352` — _"Worker offline — the task will wait until its lane connects"_, describing a row the board calls an **agent** |
| S2  | that entry's identifier                   | `workerId` **and** `agentId`                                                                                                                                                                        | `model/lane-config.ts:22-23` emits `workerId: agent.id, agentId: agent.id`; the board's `ClaimRunRequest` never receives `workerId` at all  |
| S3  | one `work_items` row                      | task / request / intake / work item                                                                                                                                                                 | see A1                                                                                                                                      |
| S4  | a project's list of `BoardTask`s          | **thread**                                                                                                                                                                                          | `ThreadPipelineTable.tsx:39` "Active Thread Pipeline"; there is **no** `thread` type, table, field or route in `src/server` or `src/shared` |
| S5  | the directory holding a project's code    | `repositories.path` / `repoPath` (wire) / `workspacePath` (UI state) / `workingDirectory` (fleet) / `repositoryPath` (workspace manager)                                                            | `store.ts:615`, `validate/requests.ts:145`, `create/ProjectForm.tsx:58`, `task-fleet/types.ts:25`, `task-workspace/manager.ts:15`           |
| S6  | reaching a terminal state                 | chip `abandoned → "Cancelled"` vs notification `"Park auto-abandoned"`; `dead_letter → "Failed"` collides with a task's own `failed`                                                                | `model/work-item-labels.ts:24,63,64`                                                                                                        |
| S7  | the product                               | **Nexus Seventeen** (`README.md:1`, `index.html:10`) vs **Steward** (`docs/AGENT_SYSTEM.md:1` "Steward agent system", `main.ts:47` "Steward task board listening", `docker_image/entrypoint.sh:61`) | both doc sets publish to the same Outline                                                                                                   |

---

## Part 3 — Misleading names (a name that states something untrue)

These outrank cosmetic inconsistency: the name itself is the false claim.

| Name                                            | Claims           | Actually                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/verify/supervisor.ts`                   | supervises       | runs argv steps **sequentially**, stops at the first non-zero exit, writes `status.json` (`runSupervisor` `:106-138`). No restart, backoff or health monitoring. The code that _does_ supervise is `TaskFleet` (`fleet.ts:175-335`) — never called a supervisor. |
| `collaborators/merge-executor.ts`               | an executor      | five git functions (A6)                                                                                                                                                                                                                                          |
| `task-fleet/runtime.ts`                         | a runtime        | a **worker factory** — primary export `createTaskFleetWorker` (`:250`)                                                                                                                                                                                           |
| `task-container/arguments.ts`                   | arguments        | builds a `ContainerRunPlan` (`:28,33`)                                                                                                                                                                                                                           |
| `task-board/schema.ts`, `task-worker/schema.ts` | a schema         | request validators (A10)                                                                                                                                                                                                                                         |
| `collaborators/`                                | collaborators    | 7 of 21 files export none: `agent-identities`, `claim-projection`, `decomposition-readiness`, `interface-context`, `merge-executor`, `onboarding-check`, `runtime`                                                                                               |
| `tests/tooling/`                                | tests `tooling/` | three of its four suites test `scripts/` (`bootstrap-lib`, `export-documents`, `publish-docs-workflow`)                                                                                                                                                          |
| `views/TaskList.tsx`                            | a task list      | exports `WorkItemRow`, `TaskRow`, `EmptyState`, `RemovedTaskDetail`, `FormError`, `ActionErrorToasts`                                                                                                                                                            |
| `web/data/parse/scalars.ts`                     | —                | exports functions literally named `string`, `boolean`, `array`, `record` (`:56,73,85`), shadowing keywords; its mirror `shared/…/validate/scalars.ts` uses `stringValue`, `arrayOf`, `booleanValue` (`:66,186,221`)                                              |
| `isExplicitPointOfContact`                      | reads a flag     | matches `/(?:\bpoc\b\|point of contact)/i` against the agent's **free-text** id, name, area and mission (`model/workspace-model.ts:12,139`). Naming an agent "PoC tooling" silently makes it the board's point of contact.                                       |
| `docker_image/`                                 | —                | the only snake_case folder in the repo                                                                                                                                                                                                                           |

---

## Part 4 — What must not be renamed, and why

A rename that breaks a running deployment or an existing database is a **migration**, not a
mechanical task. Everything below is in that class.

### Would corrupt or orphan the production database

| Identifier                                                                             | Where                                                                                                                                                | Why it is a migration                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `steward.task-board/v1`                                                                | `TASK_BOARD_API_VERSION` `shared/…/index.ts:5`; written into artifact rows at `persistence/artifacts.ts:21` and 8 sites in `persistence/workflow.ts` | the string is inside already-stored JSON; changing it needs dual-read                                 |
| `system:steward-default`                                                               | seeded into `automation_configuration` and `board_pause` (`store.ts:583,596`); compared in the UI at `AutomationPage.tsx:253`                        | live rows; renaming makes "Starter configuration" stop matching                                       |
| `system:steward-review-workflow`, `steward:wakeup-retirement`                          | `collaborators/runtime.ts:66,920`                                                                                                                    | authorship values on live rows                                                                        |
| `cicada-steward` project key                                                           | `config/company-bootstrap.json:59`; `scripts/bootstrap-lib.mjs:61-62` derives `agentId = "<key>/<suffix>"`                                           | renaming silently re-keys every agent id and orphans Keychain-stored tokens                           |
| `twe_` / `twa_` / `tws_` id prefixes                                                   | minted `task-worker/worker.ts:147,163,180`; matched by SQL `GLOB 'twe_*'` `collaborators/runs.ts:1401,1420`                                          | persisted in `client_event_id`; the _literals_ can become named constants, the _values_ cannot change |
| every contract enum value                                                              | `WORK_ITEM_STATES`, `WORK_ITEM_STAGES`, `WORKFLOW_STAGES`, `TASK_PHASE_STAGES`, `PARK_CATEGORIES`, …                                                 | enforced by SQL `CHECK` constraints generated from them (`store.ts`)                                  |
| `repositories`, `work_nodes`, `stage_attempts`, `task_phases` … column and table names | `persistence/store.ts`                                                                                                                               | schema is at v28; renames need a migration step and a fixture refresh                                 |

### Would strand the deployment

| Identifier                                                                                                                                              | Where                                                                                                                                                                                                                          | Failure mode                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Dokploy volume `steward-data`                                                                                                                           | `docker-compose.dokploy.yml:25,40`; live volume is **`cicada-steward-3cmfas_steward-data`** (`docs/OUTLINE.md:40,44`)                                                                                                          | renaming the compose service or volume creates a **new empty volume** and silently abandons the production SQLite file |
| compose service `steward`                                                                                                                               | `docker-compose.dokploy.yml:5`, `docker-compose.dev.yml:4`                                                                                                                                                                     | the volume name above is derived from it                                                                               |
| `/var/lib/steward`, `/opt/steward`, `/srv/steward`                                                                                                      | `Dockerfile:27-31,59-64`; `docker_image/{Caddyfile:55,entrypoint.sh:7-9,agent/entrypoint.sh:5-8}`; **and host-side strings pointing into the image**: `task-container/arguments.ts:52`, `task-container/infrastructure.ts:282` | a stale image plus new code (or the reverse) fails at container start                                                  |
| image label `steward.cli.<runtime>`                                                                                                                     | written `Dockerfile:56-57`, read at runtime `task-fleet/runtime.ts:117`                                                                                                                                                        | a rebuilt reader against an old image returns a null version pin, silently                                             |
| container/network/label names `steward-agent`, `steward-agents`, `steward-egress`, `steward-egress-proxy`, `steward-task-<runId>`, `label=steward.task` | `task-container/image-tag.ts:5`, `infrastructure.ts:4-8,393`, `arguments.ts:46,69`; ready-message pair `egress-proxy/main.ts:11` ↔ `infrastructure.ts:8`                                                                       | renaming strands running containers and leaks orphans the reaper can no longer find                                    |
| Keychain service `cicada-steward-agent-token`                                                                                                           | `scripts/reconcile-bootstrap.mjs:21`                                                                                                                                                                                           | stored agent tokens become unreachable                                                                                 |
| host `steward.cicadasystem.com`                                                                                                                         | `reconcile-bootstrap.mjs:19`, `company-bootstrap.json:74`                                                                                                                                                                      | DNS/TLS/SSO change                                                                                                     |
| `.steward-data/`                                                                                                                                        | `README.md:80-111`, `.gitignore:9`, `fleet.example.json:17,27`, `model/lane-config.ts:28`                                                                                                                                      | every existing operator's local DB, `fleet.json` and worker journals                                                   |

### Operator contract — renameable only behind an alias window

**37 distinct `STEWARD_*` environment variables** outside tests (40 counting test-only ones) are
read across `src/`, `scripts/`, `playwright.config.ts` and the shipped stub; 14 in
`task-board/main.ts:16-34` and 13 in `task-worker/main.ts`. Two are set outside this repository
and must be changed there first:

- `STEWARD_TASK_BOARD_HUMAN_TOKEN` — injected by Caddy (`docker_image/Caddyfile:30,39`) and
  required by Dokploy (`docker-compose.dokploy.yml:14`). Rename one half and every board API call 401s.
- `STEWARD_OUTLINE_API_TOKEN` — a **GitHub Actions secret name** (`.github/workflows/publish-docs.yml:31`),
  whose exact YAML text is asserted by `tests/tooling/publish-docs-workflow.test.mjs:19`.

Two more are re-parsed off **already-running** containers, so a rename invalidates drift detection
against them: `STEWARD_EGRESS_ALLOWED_HOSTS`, `STEWARD_EGRESS_PORT`
(`task-container/infrastructure.ts:160-161,277-279`).

### Not env vars — markers that reach the model

`STEWARD_ESTIMATE_MINUTES`, `STEWARD_PHASE_JSON`, `STEWARD_SAFE_PHASE` are agent-stdout protocol
markers parsed at `agents/runtime/derive.ts:49,58,232` and instructed at `config/prompts.md:114-115`.
Renaming needs prompts and parser to change atomically and invalidates **24 lines across 12
golden prompt fixtures** in `tests/server/agents/task-worker/fixtures/agent-prompts/`.

### `package.json` `imports`

`#server/agents/task-{board,fleet,worker,container,workspace}/*` and `#shared/task-board-contract/*`
are string-matched subpath aliases (`package.json:6-21`). Dropping the `task-` folder prefix costs
four characters and breaks four aliases plus every import that uses them. **Not worth it.**

---

## Part 5 — Proposed rename tasks

Each is one reviewed mechanical task with `npm run typecheck:all` (plus, where noted, the web and
e2e suites) as the proof. Ordered so later tasks depend on earlier decisions, not the reverse.

| #      | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Ripple                                                                                                                                         | Risk                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **T0** | **`docs/GLOSSARY.md`** — one page defining: Work item · Task · Agent · Worker · Lane · Runtime · Provider (interface sense) · Stage (×3, scoped) · Phase (×2) · Workspace vs Repository · Run · Park→Abandon→Dead letter. Source of truth for T1–T6.                                                                                                                                                                                                                                                                                                                                                         | new file; publishes to Outline via `config/docs-publish.json`                                                                                  | none                                                                 |
| **T1** | **Decide the user's word for a `WorkItem`** (the one blocking decision). Recommended **"Request"**: it is already the wire field (`original_request`), already the UI heading ("Original request", `WorkItemDetail.tsx:658`), and it is the reader's word for what they typed. `BoardTask` keeps "task".                                                                                                                                                                                                                                                                                                     | decision only                                                                                                                                  | none                                                                 |
| **T2** | **Copy-only pass.** Apply T1 across ~30 UI strings; delete "thread" (S4) and the bare "intake" noun (A7) from copy; unify park/abandon/dead-letter labels (S6); rename the "Stage" column that shows a status (A2 row 4); one word per layer in agent/worker/lane status copy (S1).                                                                                                                                                                                                                                                                                                                          | ~30 strings in `src/web` + **36 lines in `tests/e2e/task-board.spec.ts` pinning "Add task" / "Add a task" / "Submit task"**                    | low, but the e2e suite must be re-run                                |
| **T3** | **`provider` → `runtime` on the operator surface**, with an alias window. Prerequisite inside the same task: rename the colliding fleet key `runtime` (local-process\|container) → **`launchMode`**, also aliased. Accept both old keys with a deprecation warning; honour `STEWARD_TASK_WORKER_PROVIDER` alongside a new `STEWARD_TASK_WORKER_RUNTIME`. Precedent: `promptsRoot`→`promptsFile`.                                                                                                                                                                                                             | 12 fleet/worker sites, `README.md:132,142,193`, `model/lane-config.ts:25` and its e2e assertion `task-board.spec.ts:1683`, `AgentPage.tsx:245` | **medium** — operator-facing; the alias window is what makes it safe |
| **T4** | **Free `provider` for its interface sense** (A3). With T3 done, `Provider*` in `decomposition-readiness.ts` and `CrossRepoContext.provider*` are unambiguous — **no rename needed**, only a glossary entry and a comment. Wire fields are persisted anyway.                                                                                                                                                                                                                                                                                                                                                  | zero code                                                                                                                                      | none                                                                 |
| **T5** | **Internal mechanical renames** (typecheck-proven, no behaviour): `collaborators/runtime.ts`→`board-runtime.ts` (17 importers); `task-fleet/runtime.ts`→`worker-factory.ts` (+ its two test files); `merge-executor.ts`→`pipeline-merge.ts`; `task-container/arguments.ts`→`run-plan.ts`; `verify/supervisor.ts`→`step-runner.ts`; `task-board/schema.ts`→`request-parsers.ts` and `task-worker/schema.ts`→`claim-parsers.ts`; `web/data/parse/scalars.ts` primitives→`parseString`/`parseBoolean`/… ; `TaskBoardOptions.host`→`hostPaths`; `twe_/twa_/tws_` literals→exported constants (values unchanged). | ~25 files touched; the three `runtime.ts` renames are import-only                                                                              | low                                                                  |
| **T6** | **Disambiguate `stage` and `workspace` at the type/param/label level** (values unchanged): `WorkflowStage`→`NodeStage`, `TaskPhaseStage`→`PhaseStep`; parameters named `stage` gain their scope; W2 `workspacePath`→`repositoryPath` in the create flow to match `repositories.path` and the wire's `repoPath`; W3 `WorkspaceFrame`→`AppFrame`, `views/workspace/`→`views/pages/`.                                                                                                                                                                                                                           | `stage`: ~40 type/param sites out of 988 occurrences; `workspace`: ~35 of 352                                                                  | low, but **must not touch enum values**                              |
| **T7** | **Split `collaborators/`** — move the 7 non-collaborator files to `task-board/` root or a new `domain/`. Largest diff, least reader value; do last or not at all.                                                                                                                                                                                                                                                                                                                                                                                                                                            | 7 files + importers                                                                                                                            | low                                                                  |

**Deliberately not proposed:** the `task-` folder prefix (breaks four `package.json` aliases for
four characters); `docker_image/`→`docker-image/` (touches Dockerfile `COPY` paths for a
cosmetic hyphen); any `steward`→`nexus` rename in deployment, DB or env identifiers (Part 4);
`runtime` in `build:runtime` / `tsconfig.runtime.json` / the Dockerfile stage (standard Node
idiom, never adjacent to R1–R4); `node` (`WorkNode` vs DOM `Node` vs the binary — separated by
file); `role` (`AgentRole` vs the ARIA attribute — separated by syntax).

### Recommended

**Do T0, T1, T2, T3, T5.** These are the ones where a reader is currently _wrong_ rather than
merely confused: the button that creates the wrong noun, the operator key whose error messages
use the other word, and the five file names that state something untrue. T0 and T2 need no code
review beyond copy; T5 is a typecheck away from proven; T3 is the only one carrying operator risk
and the alias window contains it.

**Do T6 if a campaign is already touching those files**, not on its own — `stage` is the second
worst ambiguity but its values are pinned, so the fix is partial by construction and the diff is
wide.

**Do not do T4 or T7 as work.** T4 becomes free once T3 lands. T7 is a 7-file move that improves
no reader's understanding of what the code does.

**Honest non-findings.** The repo's naming discipline is better than the occurrence counts
suggest: `parse*`/`load*`/`read*` are cleanly split, `*InTransaction` is never violated, and
`agents/verify/` and `docs-publish/` have no internal collisions at all. `fleet` and `supervisor`
each have exactly one meaning. The `steward` residue — 112 files — is almost
entirely _pinned or cosmetic_, and renaming it buys no reader anything; the only part worth doing
is S7, making the two product names agree in prose (`docs/AGENT_SYSTEM.md:1`, `task-board/main.ts:47`,
`docker_image/entrypoint.sh:61-91`), which is copy, not a rename.

---

## Corrections to the 2026-08-28 audit

| Claim there                                                             | Status                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _"`provider` survives only as an operator alias for `runtime`"_ (`:14`) | **False.** The dominant sense is the interface publisher in cross-repo decomposition (~125 vs ~42) — A3.                                                                                   |
| T3: _"fleet key `runtime` (accept `provider`…)"_ (`:36`)                | **Would create a collision.** `runtime` is _already_ a fleet key meaning local-process vs container (`config.ts:140-145`). T3 above adds the `launchMode` rename that makes it safe.       |
| _"`TaskBoardClient`×2→`BoardApiClient`/`WorkerBoardClient`"_ (`:34`)    | **Stale.** There is one `TaskBoardClient` (`web/data/client.ts:150`); the worker's is already distinctly named `HttpTaskBoardClient` (`http-board-client.ts:318`).                         |
| _"`runtime` means three things"_ (`:12`)                                | Undercounts: five, and it mis-describes `task-fleet/runtime.ts` as "the container engine" when it is a worker factory.                                                                     |
| Missed entirely                                                         | `stage` (A2), `workspace` (A5), `phase` (A9), `schema` (A10), `host` (A8), the `supervisor`/`TaskFleet` inversion, and the repository-path synonym set introduced by campaigns 16–18 (S5). |

---

## Alternatives considered

**Rename `runtime` → `provider` instead (make the code follow the operator).** Rejected: the
database already persists this concept as `runs.runtime` / `runs.runtime_version`
(`store.ts:784-785`) and the operator's own profile file is `config/runtimes.json`. Going the
other way turns a rename into a migration, and it would leave `provider` overloaded with its
correct interface-publisher sense.

**Rename the interface-publisher `provider` (P2) instead, to `upstream`.** Rejected:
provider/consumer is the standard pairing for a published interface and the codebase already
carries `splitBy: "consumer"` (`index.ts:468`). Moving the _newer, smaller_ sense (P1, ~42 sites,
one operator key) is cheaper and more correct than moving the older, larger, domain-accurate one.

**Rename the contract enums so `stage` means one thing.** Rejected: `WORK_ITEM_STAGES`,
`WORKFLOW_STAGES` and `TASK_PHASE_STAGES` are compiled directly into SQL `CHECK` constraints
(`store.ts:120,329`) over live rows. T6 fixes the _names around_ the values, which is where a
reader actually gets misled.

**Rename `steward` → `nexus` everywhere now.** Rejected as a naming task; it is an infrastructure
migration. Part 4 lists ~90 identifiers where the rename is a volume swap, a dual-read window, an
image rebuild or a Keychain re-key. Nothing about it improves a reader's understanding, and the
compose volume alone would silently abandon the production database.

**Adopt an ESLint naming-convention rule to enforce this (the prior audit's D2).** Rejected:
roadmap 11 already answered it — _"ratcheted by a tooling test, not eslint — the repository has no
eslint"_ (`orchestrator-roadmap.md:267`). The equivalent here is a `tests/tooling` grep asserting
no duplicate basename means two things (`runtime.ts`, `schema.ts`) and that
`docs/GLOSSARY.md` lists every word used in more than one layer. Cheaper, and consistent with the
existing `code-style.test.mjs` ratchet.

**Do nothing.** Coherent for most of this list, and the right answer for S7, T4 and T7. It is not
the right answer for A1: "Add task" creating a work item is a defect a first-time user hits in
the first sixty seconds, and no amount of familiarity makes the sentence true.
