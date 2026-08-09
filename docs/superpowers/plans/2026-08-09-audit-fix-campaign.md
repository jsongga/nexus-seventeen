# Audit-Fix Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model for THIS plan (overrides defaults):** Codex implements each task (`codex exec --sandbox workspace-write`, backgrounded, stdin `</dev/null`, never commits). Claude curates each task brief from this plan, reviews every diff (Claude reviewer subagent + `codex review` in parallel), then stages and commits. One task per Codex invocation, sequential — Codex runs in the working tree, so no parallel implementation.

**Goal:** Fix all findings from the 2026-08-08 five-reviewer audit (spec: `docs/superpowers/specs/2026-08-09-audit-fix-campaign-design.md`).

**Architecture:** Six ordered streams — CI safety net (E1), server atomicity (A), fleet resilience (B), operator-loop closure (C), web data-layer correctness (D), contract consolidation (E2). Server principle: validate before committing; retries repair rather than skip. Web principle: errors are per-action and durable; user input survives polls.

**Tech Stack:** TypeScript 5.7, React 19, Node 22/24, `node:sqlite`, vitest (`src/web`), node:test (`tests/` → `.test-dist`), Playwright.

## Global Constraints

- Never commit from inside Codex; Claude stages/commits after review. Branch: `audit-fixes`.
- Every task ends with `npm run typecheck:all` green plus the suites named in the task.
- Codex sandbox has **no network**: no npm installs, no `gh`. All deps are vendored already.
- New error codes/enums go in `src/shared/task-board-contract/index.ts` first, never inline.
- Do not touch `dist/`, `build/`, `.test-dist/`, `node_modules/`.
- Audit line numbers are as-of `c71f1e3`; verify against current code before editing.
- Behavior changes to server endpoints must keep the wire contract backward-compatible for one release unless the task says otherwise (additive fields OK, repurposed fields not).

---

### Task E1: CI safety net

**Files:**
- Modify: `package.json` (scripts), `.github/workflows/test.yml`, `tsconfig.test.json`
- Create: `tests/e2e/tsconfig.json`
- Test: existing suites; `npm run test:bootstrap`; `vitest run tooling`

**Interfaces:** Produces: `test:all` = web + tooling + runtime + bootstrap; `typecheck:all` also checks `tests/e2e`.

- [ ] Add `test:tooling`: `vitest run tooling` (vite-security tests currently never run in CI — `vitest.config.ts` includes them but `test:web` globs only `src/web`). Add to `test:all`.
- [ ] Add `test:bootstrap` to `test:all`.
- [ ] Create `tests/e2e/tsconfig.json` extending the app config (`module`/`moduleResolution` matching Playwright usage, `types: ["node"]`, no emit); add to root `tsconfig.json` references or a `typecheck:e2e` script wired into `typecheck:all`. Fix any type errors it exposes (expect selector/helper rot; fix the tests, not the types).
- [ ] CI: node matrix `[22, 24]` in `.github/workflows/test.yml`.
- [ ] Fix `tsconfig.test.json` `rootDir`/`include` so `src/` is not double-compiled into `.test-dist/src` (tests already import `#server/*` → `build/`). Verify `.test-dist/src` no longer appears after `test:runtime`.
- [ ] De-alias build scripts: `build` runs the real sequence; delete `build:all` or make the chain honest (`build:web` = web only).
- [ ] Verify: full `npm test`, `npm run typecheck:all`, and confirm in CI config that all suites are invoked.

### Task A1: Atomic run settlement with retry-repair

**Files:**
- Modify: `src/server/task-board/collaborators/runs.ts` (settleRun: validation order, txn boundary, duplicate path), `src/server/task-board/persistence/workflow.ts` (settleAttempt callable inside an open txn)
- Test: `tests/server/task-board/board.test.ts` (new failure-boundary section)

**Interfaces:** Produces: `settleRun` — all handoff/plan validation (outcome mismatch `HANDOFF_OUTCOME_MISMATCH`, artifacts `HANDOFF_ARTIFACT_INVALID`, `WORKFLOW_PLAN_REQUIRED`) throws **before** any write; run/task terminal writes + workflow settlement commit in **one** transaction; duplicate settle requests verify the workflow half applied and repair it if a legacy/crashed row left it undone.

- [ ] Write failing tests first: (1) settle with contradictory handoff (`status:"failed"`, `handoff.outcome:"passed"`) → 400 AND run still `active`, task unchanged, node still `active` — currently the run commits before the 400; (2) duplicate settle after simulated partial state (run terminal, node `active`) → repairs node; (3) happy path unchanged.
- [ ] Restructure settleRun per Interfaces. `proposeWorkflowForAgent` moves inside the same transaction (it currently commits separately before the settle txn — spec "Ordering/visibility").
- [ ] Run `npm run test:runtime`; verify the new tests pass and no existing settle tests break.

### Task A2: Claim payload built before the claim commits

**Files:**
- Modify: `src/server/task-board/collaborators/runs.ts` (claimRun), `src/server/task-board/persistence/workflow.ts` (claimContext inside txn)
- Test: `tests/server/task-board/board.test.ts`

**Interfaces:** Produces: `claimRun` — `claimContext` (incl. `SKILL_DIGEST_CHANGED` check) evaluated inside the claim transaction; on 409 nothing is committed: no run row, wakeup still claimable, task status unchanged.

- [ ] Failing test: change a skill file digest after plan confirmation, then claim → 409 AND wakeup remains claimable AND no active run exists (currently the claim commits then 409s, deadlocking the agent).
- [ ] Move payload construction inside the txn; response assembled from data captured in-txn.
- [ ] `npm run test:runtime` green.

### Task A3: Atomic work-item planning + duplicate-POST repair

**Files:**
- Modify: `src/server/task-board/collaborators/work-items.ts` (startWorkItemPlanning single-txn), `src/server/task-board/service.ts` (duplicate path repair)
- Test: `tests/server/task-board/board.test.ts`

**Interfaces:** Produces: work item + planning task + `work_item_planning_tasks` link + `state='processing'` in one transaction; `POST /v1/work-items` with `duplicate: true` re-runs `startWorkItemPlanning` when the item is `submitted` with no planning link.

- [ ] Failing tests: (1) inject a throw between task-create and link (temporary test hook or direct persistence call) → whole planning txn rolls back, item stays `submitted`; (2) duplicate POST for a linkless `submitted` item → planning starts; (3) settleRun for a planning task whose link exists → no `WORKFLOW_PLAN_NOT_ALLOWED` regression.
- [ ] Implement; `npm run test:runtime` green.

### Task A4: Crash-safe node activation + reconciler

**Files:**
- Modify: `src/server/task-board/collaborators/projects.ts` (activateWorkflowNode atomic; reconcileWorkflows), `src/server/task-board/persistence/workflow.ts` (persisted `blocked` node state), `src/server/task-board/board.ts` or `main.ts` (reconcile on startup)
- Test: `tests/server/task-board/board.test.ts`

**Interfaces:** Produces: `activateWorkflowNode` — `createTask` + `linkAttempt` one transaction; nodes with no compatible agent persist state `blocked` (not just a `node_blocked` event); `reconcileWorkflows(projectId?)` re-activates `ready`/`blocked` nodes, called at board startup, after confirm, after settle, and after agent creation (`collaborators/agents.ts`).

- [ ] Failing tests: (1) confirm with zero compatible agents → node persisted `blocked`; creating a compatible agent → node activates with task + attempt link; (2) simulated crash (ready node, no task) → startup reconcile activates it; (3) task exists but attempt link missing → reconcile links or recreates coherently.
- [ ] Implement; `npm run test:runtime` green. (C3 lazy identities builds on the agent-creation hook.)

### Task A5: Worker output normalization + interrupt correctness

**Files:**
- Modify: `src/server/agents/task-worker/worker.ts` (outbound normalization; interrupt settlement cache; shutdown path), `src/server/agents/task-worker/contained-cli-launcher.ts` (terminate-then-scrub)
- Test: `tests/server/agents/` worker tests

**Interfaces:** Produces: every outbound prose field normalized `\r\n?` → `\n` in one place before POST (kills the CR poison pill — worker `prose()` accepts CR, board `text()` rejects it); `interrupt(reason)` always terminates the process group, scrubbing credentials from the *reported* reason only; a failed interrupt settlement is not cached as permanently failed; fleet shutdown never dies on an unhandled interrupt rejection.

- [ ] Failing tests: (1) provider result containing `\r\n` → settle POST body contains only `\n` and settles clean; (2) interrupt with a reason matching the credential patterns → process group still terminated, journal/board reason shows `[redacted]`; (3) interrupt settlement rejection → retry re-attempts (cache cleared); (4) shutdown with a failing terminate → orderly, no unhandled rejection.
- [ ] Implement; `npm run test:runtime` green.

### Task A6: Board HTTP hygiene bundle

**Files:**
- Modify: `src/server/task-board/service.ts` (plans/confirm validation; route-segment decoding), `src/server/task-board/schema.ts` (parseConfirmPlanRevisionRequest), `src/server/task-board/persistence/workflow.ts` (SSE after commit; ended-item guard), `src/server/task-board/collaborators/projects.ts` (event wiring), `src/shared/task-board-contract/index.ts` (error codes `WORK_ITEM_ENDED`, `INVALID_IDENTIFIER` if absent)
- Test: `tests/server/task-board/board.test.ts`, HTTP-level tests

**Interfaces:** Produces: `POST /v1/plans/:id/confirm` body schema-validated (null body → 400 not 500); confirming a plan whose work item ended → 409 `WORK_ITEM_ENDED` (`ended_at IS NULL` guard added to the confirm UPDATE); workflow events queue during the txn and emit after commit with listener errors swallowed (copy `documents.ts:225-238` pattern); route params percent-decoded once with malformed encoding → 400 (agent `bot@host` can claim via `/agents/bot%40host/runs/claim`).

- [ ] Failing tests for each of the four behaviors, then implement; `npm run test:runtime` green.

### Task A7: Recovery state machine + endpoints

**Files:**
- Modify: `src/server/task-board/collaborators/tasks.ts` + `runs.ts` (transitions), `src/server/task-board/service.ts` (routes), `src/shared/task-board-contract/index.ts` (requests + `TASK_TERMINAL` code)
- Test: `tests/server/task-board/board.test.ts`

**Interfaces:** Produces target state machine: `failed`/`blocked`/`interrupted` are *recoverable*: `POST /v1/tasks/:id/retry` (same agent → wakeup `resumed`), `POST /v1/tasks/:id/assign` extended to allow reassignment from recoverable states (new agent → wakeup `assigned`), `POST /v1/tasks/:id/backlog` (unassign, status back to backlog). `completed`/`cancelled` are hard-terminal: recovery attempts AND resume → 409 `TASK_TERMINAL` (today resume creates a wakeup that is silently retired as `task_terminal` — a false success).

- [ ] Failing tests: each recoverable transition works end-to-end (wakeup claimable, run startable); each hard-terminal attempt → 409 and **no wakeup row created**; resume of an active task unchanged.
- [ ] Implement; `npm run test:runtime` green.

### Task B1: Fleet quarantine policy

**Files:**
- Modify: `src/server/agents/task-fleet/runtime.ts` (error classification), `src/server/agents/task-fleet/fleet.ts` (lane loop), `src/server/task-board/persistence/store.ts` + contract (agents `last_error` column, additive), board settle path for lane-reported failures
- Test: `tests/server/agents/` fleet tests

**Interfaces:** Produces: transient errors (network, 408/425/429/5xx, journal EIO) → capped exponential backoff (1s → 60s, jitter, reset on success), lane never parks; non-transient errors → settle the claim as `failed` on the board (scrubbed error summary), record agent `last_error`, continue to next wakeup. `agents.last_error` (nullable text) surfaces in the snapshot payload additively.

- [ ] Failing tests: (1) two consecutive 503s then success → lane claims again, backoff observed and reset; (2) a 400 on settle → claim settled failed, `last_error` set, lane alive and claiming; (3) journal write EIO → transient path, not park.
- [ ] Implement; `npm run test:runtime` green.

### Task C1: Remove "Auto" project target

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx` (intake form), `src/server/task-board/collaborators/work-items.ts` + `schema.ts` (reject `projectTarget: auto` with 400 `PROJECT_REQUIRED` — additive error code), contract
- Test: vitest model/wire tests; one e2e intake assertion; board tests for the 400

**Interfaces:** Produces: intake form requires an explicit project (submit disabled until chosen; no "Auto" option); server rejects `auto` so stale clients get a clear error instead of a forever-`submitted` item.

- [ ] Tests first (web + server), implement, `npm run test:web && npm run test:runtime` green, update the e2e intake flow.

### Task C2: Work-item detail view

**Files:**
- Create: `src/web/task-board/views/WorkItemDetail.tsx`, `src/web/task-board/model/work-item-detail.ts` (+ `.test.ts`)
- Modify: `src/web/task-board/BoardApp.tsx` (rows clickable, pane wiring), `src/web/task-board/data/client.ts` (cancel/archive ops; salvage `getProjectWorkflow`/`confirmWorkflow` from parked-only status), `src/web/task-board/routing/routing.ts` (work-item id in hash), server: `service.ts` PATCH work-item extensions for cancel/archive (`archived_at` column, additive)
- Delete: `src/web/task-board/parked/` (after salvaging; its tests currently run in CI for unreachable code)
- Test: model unit tests; board tests for cancel/archive; e2e: submit → answer planning question → confirm plan → archive

**Interfaces:** Consumes: A3/A4/A6 (planning links, blocked-state, plans/confirm validation). Produces: clicking a work-item row opens a detail pane (task-detail pattern): status timeline, the planning task's pending question with answer box (routes through existing task `answerQuestion`), proposed plan with confirm/reject, cancel for non-terminal items, archive for terminal ones; archived items leave the default list.

- [ ] Model tests first (state derivation: which affordances for which item state), then UI, then server ops with board tests, then e2e; delete `parked/` last and confirm `vitest list src/web` shows no parked tests.

### Task C3: Lazy identities + lane-config surfacing + token rotation

**Files:**
- Modify: `src/server/task-board/collaborators/work-items.ts` (auto-create sole manager on first work item), `src/server/task-board/collaborators/projects.ts` (auto-create engineer when a confirmed plan lacks a compatible agent — hooks into A4's reconciler), `src/server/task-board/collaborators/agents.ts` + `service.ts` (token rotation endpoint `POST /v1/agents/:id/rotate-token`), web: agent page lane-config panel (id/token/workdir, copy-paste block shown once on creation/rotation), remove the sessionStorage-token dead-end in `BoardApp.tsx` add-project flow
- Test: board tests (manager auto-created exactly once, race-safe under duplicate POSTs; engineer auto-created on confirm; rotation invalidates old token); web model tests; e2e: add project → submit work item → see manager identity + lane config appear

**Interfaces:** Consumes: A4 reconciler, C2 detail view. Produces: no silent-null planning (manager always exists by the time planning starts); no invisible credentials (config panel + rotation); add-project creates the project only — no eager agents.

- [ ] Tests first; server then web; suites green.

### Task C4: Recovery UI

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx` TaskDetail (Reassign/Retry/Return-to-backlog for failed/blocked/interrupted; agent picker for reassign), `src/web/task-board/data/client.ts` (retry/backlog calls; assign extension)
- Test: vitest for affordance logic; e2e: fail a task → reassign → resumes under new agent

**Interfaces:** Consumes: A7 endpoints. Produces: no dead-end recovery states; buttons disabled states explained inline (e.g. "no other eligible agents").

### Task C5: Error pipeline separation

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx` (split `error` state: `connectivityDown` boolean driven only by snapshot fetch failures; per-action mutation errors as dismissible toasts via a small `useActionErrors` hook; poll success clears only connectivity), `src/web/components/ui.tsx` (toast outside dialogs)
- Test: vitest on the hook + `mutate` wrapper; e2e: failed assign shows persistent actionable error while board stays clearly connected

**Interfaces:** Produces: `mutate` returns `{ok, error}`; **every** submit path checks `ok` before clearing input (the answer-wipe at `BoardApp.tsx:433` becomes impossible by construction); "Task board unavailable" appears only when the snapshot fetch itself fails.

### Task C6: Input safety + task routing

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx` (remove the reset-on-`defaultAgentId` effect — key form state to task id; "task removed" placeholder instead of `allTasks[0]` fallback), `src/web/task-board/routing/routing.ts` + `useHashRoute.ts` (selected task id in hash: `#/tasks/<id>`; Back closes detail), `src/web/components/dialog-stack.ts` + `ui.tsx` (dirty-guard on Escape/backdrop: confirm before discarding non-empty form state)
- Test: routing unit tests (deep link, back, invalid id); vitest for dirty-guard; e2e: type answer → poll assigns agent elsewhere → text survives; refresh restores open task

**Interfaces:** Consumes: C5's mutate contract. Produces: drafts survive polls; deep-linkable task detail; dirty dialogs prompt before discard (Documents-page pattern, `document-drafts.ts:127-136`, generalized).

### Task C7: Flow polish bundle

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx` (assignment shows worker-connection state + offline warning — data already in `model/project.ts` `workerConnection`), `src/web/task-board/views/WorkspacePages.tsx` ("Pause Agents" → "Interrupt all" with confirmation dialog; respect `explicitPointOfContact` in AgentPage), `src/web/task-board/project/ThreadPipelineTable.tsx` (shared status vocabulary, drop Merged/Changes-Requested), empty-state + project-path validation copy
- Test: vitest where logic changes (POC selection, status labels); e2e spot-checks

**Interfaces:** Produces: consistent Interrupt naming everywhere; assignment warns "worker offline — task will wait"; first-run empty state links Add-project; path field shows "must be an absolute path" inline; POC behavior no longer depends on creation order.

### Task D1: Numeric timestamps

**Files:**
- Modify: `src/web/task-board/data/parse.ts` (timestamp fields → `{iso: string, ms: number}` or parallel `*Ms` fields at the parse boundary), all comparison sites (`model/project.ts:88-90`, `model/workspace-model.ts:176,207,246`, `views/WorkspacePages.tsx:96,369`, `views/DocumentsPage.tsx:129`, `BoardApp.tsx:739`)
- Test: existing model tests extended with mixed-precision/mixed-offset fixtures (`.500Z` vs `Z` vs `+02:00`)

**Interfaces:** Produces: all ordering numeric; no string comparison of timestamps anywhere (grep gate: no `.localeCompare` or `<`/`>` on raw timestamp strings).

### Task D2: Polling and pagination discipline

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx` (poll skips when a refresh is in flight — no abort; mutation refreshes take priority), `src/web/task-board/data/client.ts` (message page size from contract constant), `src/shared/task-board-contract/index.ts` (`TASK_MESSAGE_PAGE_SIZE`), server list endpoint uses the same constant, `src/web/task-board/views/AutomationPage.tsx` + `model/automation-model.ts` (save bumps `loadSequence`; reconcile rejects remote versions older than saved)
- Test: vitest: poll-vs-refresh race (fake timers), automation save-then-stale-load, pagination boundary at exactly one page

**Interfaces:** Produces: mutations' refreshes never cancelled by polls; a stale GET can never clobber a newer save; page-size single-sourced.

### Task D3: Web data-layer fixes bundle

**Files:**
- Modify: `src/web/task-board/data/client.ts` (SSE framing unified with the document-stream parser — CRLF + optional-space `data:`; extract one shared frame parser), `src/web/task-board/views/WorkspacePages.tsx` (artifact object-URL revoke on post-cleanup resolution; per-artifact failure doesn't blank all previews), `src/web/task-board/data/parse.ts` (missing `orderKey` → parse error, remove `index * 1024` synthesis), `src/web/task-board/model/project.ts` (run/event join prefers events with `taskId`/`wakeReason`; taskless runs kept)
- Test: wire/parse tests (CRLF frames, missing orderKey rejection); model tests (join preference; taskless run retained); leak test with resolved-after-cleanup blob

### Task E2a: Constants derived from the contract

**Files:**
- Modify: `src/shared/task-board-contract/index.ts` (export `IDENTIFIER_PATTERN`, page sizes; ensure `AGENT_ROLES`/`WAKEUP_REASONS` complete), consumers: `src/web/task-board/types.ts` (types derived `typeof X[number]`, delete hand-copied unions), `src/server/agents/task-worker/types.ts` (delete `TASK_WAKE_REASONS` clone), `src/server/task-board/schema.ts` + `src/server/agents/task-worker/schema.ts` (validators consume the constants), `src/server/task-board/persistence/store.ts` (SQL CHECKs generated from the arrays), `contained-cli-launcher.ts` (RESULT_SCHEMA references), unify `agent-result.schema.json` to one source (generate the JSON file from the inline schema at build, or import the JSON as the single source — pick one, delete the other copy + the `cp` step if generated into `build/`)
- Test: a contract-drift test: every validator's accepted enum set === the contract array; schema-copy equality test replaced by single-source

**Interfaces:** Produces: adding one enum member touches exactly one file and the compiler/tests flag every consumer.

### Task E2b: Unified runtime validator

**Files:**
- Create: `src/shared/task-board-contract/validate.ts` (composable validators: `exact()`, `text()`, `prose()`, `identifier()`, per-message parsers — the union of the three implementations' strictest behaviors, CR policy per A5: board-side `text()` stays strict, worker normalizes)
- Modify: `src/web/task-board/data/parse.ts`, `src/server/task-board/schema.ts`, `src/server/agents/task-worker/schema.ts`, `src/server/agents/task-worker/http-board-client.ts` → thin adapters over the shared validator
- Test: move the strongest cases from all three existing test suites onto the shared validator; adapters keep endpoint-specific tests

**Interfaces:** Consumes: E2a. Produces: one validation implementation; the three files shrink to adapters. **Run last-but-one; full `npm test` + e2e must be green before and after.**

### Task E2c: Structural splits

**Files:**
- Modify: split `src/web/task-board/data/client.ts` → `client.ts` (API calls), `sse.ts` (shared frame parser from D3), `storage-lease.ts`, `concurrency.ts`, `uuid.ts`; finish `BoardApp.tsx` migration into `views/`/`model/` (TaskRow/TaskDetail/forms out; root component keeps composition + top-level state only)
- Test: pure moves — suites stay green; no behavior change permitted in this task

**Interfaces:** Consumes: everything prior (do last). Produces: no file in `src/web/task-board` over ~400 lines except generated/test files.

---

## Self-review notes

- Spec coverage: every spec bullet maps to a task (E1→Task E1; Stream A→A1-A7; B→B1; C→C1-C7; D→D1-D3; E2→E2a-c). Out-of-scope items excluded.
- Dependencies: A4→C3, A7→C4, C5→C6, D3→E2c (shared SSE parser), E2a→E2b. Otherwise sequential in listed order.
- Naming pinned: error codes `WORK_ITEM_ENDED`, `TASK_TERMINAL`, `PROJECT_REQUIRED`, `INVALID_IDENTIFIER`; endpoints `/v1/tasks/:id/retry`, `/v1/tasks/:id/backlog`, `/v1/agents/:id/rotate-token`; constants `TASK_MESSAGE_PAGE_SIZE`, `IDENTIFIER_PATTERN`; column `agents.last_error`, `work_items.archived_at`.
