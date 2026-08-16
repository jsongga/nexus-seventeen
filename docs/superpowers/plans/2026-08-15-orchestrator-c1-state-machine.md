# Orchestrator C1 — State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the orchestrator work-item state machine (13 states, legal-transition enforcement, transition log), run heartbeats with a stale-run sweep, claim-time pinning, and forward-tolerant web enum parsing — per `docs/superpowers/specs/2026-08-15-orchestrator-c1-state-machine-design.md`.

**Architecture:** Contract-first: the state vocabulary and transition table live in `#shared/task-board-contract` and flow into SQL CHECKs, validators, and web types. One server helper performs every work-item state write. v19 rebuilds `work_items` (v13→v14 pattern), adds `work_item_transitions`, and adds nullable run columns. The sweep reuses `settleActiveRunInTransaction`.

**Tech Stack:** existing board stack (node:sqlite, node --test, vitest, Playwright).

## Global Constraints

- `WORK_ITEM_STATES` (exact order): `["queued","planning","plan_approval","designing","implementing","verifying","reviewing","fixing","final_approval","merged","parked","abandoned","dead_letter"]`. Terminals: `merged | abandoned | dead_letter`, CHECK-coupled to `ended_at IS NOT NULL` (non-terminals to `ended_at IS NULL`), exactly replacing today's coupling at fixture v18:409-412.
- Transition table (single source `WORK_ITEM_TRANSITIONS`); `P = ["parked","abandoned","dead_letter"]` shorthand — every non-terminal also has its P edges (parked's P edges are `abandoned`,`dead_letter` only):
  `queued→[planning]+P` · `planning→[plan_approval]+P` · `plan_approval→[designing,implementing,planning]+P` · `designing→[implementing]+P` · `implementing→[verifying,merged]+P` · `verifying→[reviewing,fixing]+P` · `reviewing→[fixing,planning,final_approval,merged]+P` · `fixing→[verifying]+P` · `final_approval→[merged,fixing,implementing]+P` · `parked→[planning,implementing,abandoned,dead_letter]` · `merged→[]` · `abandoned→[]` · `dead_letter→[]`.
  The `implementing→merged` and `reviewing→merged` edges are legacy-completion edges for today's flow; comment them `// legacy completion — removed when campaign 4's pipeline drives final_approval`.
- v19 state mapping (migration CASE, and the same map reused by writer rewrites): `submitted→queued`; `needs_input→parked`; `completed→merged`; `failed→dead_letter`; `cancelled→abandoned`; `waiting_for_human_review`×`human_review`→`final_approval`, ×else→`plan_approval`; `processing`×`implementation|deployment`→`implementing`, ×`testing`→`verifying`, ×`verification`→`reviewing`, ×else→`planning`; `ELSE 'planning'`.
- New error code (contract, alphabetical): `WORK_ITEM_ILLEGAL_TRANSITION` (409).
- `work_item_transitions` DDL: `work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT, sequence INTEGER NOT NULL CHECK (sequence >= 1), from_state TEXT CHECK (from_state IS NULL OR from_state IN (…WORK_ITEM_STATES…)), to_state TEXT NOT NULL CHECK (to_state IN (…WORK_ITEM_STATES…)), actor_type TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')), actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (work_item_id, sequence)` — STRICT, enum lists via `sqlStringList(WORK_ITEM_STATES)`.
- Runs additive columns (all nullable TEXT): `heartbeat_at`, `runtime`, `runtime_version`, `model`, `prompts_sha`.
- Heartbeat route: `POST /v1/runs/:id/heartbeat`, agent credential with the run's own agent + credential-version fencing exactly like the settle route's auth; 404 unknown run, 409 `RUN_NOT_ACTIVE` if not `status='active'`; sets `heartbeat_at`; idempotent; NO version bump, NO event.
- Sweep predicate: `status='active' AND COALESCE(heartbeat_at, started_at) < cutoff`, cutoff = now − `heartbeatTimeoutSeconds` (config; default 300; env `STEWARD_TASK_BOARD_HEARTBEAT_TIMEOUT_SECONDS`; `0` disables). Settle each with the existing `settleActiveRunInTransaction`, outcome `interrupted`, result `"run heartbeat lost"`. Interval: `reconcileIntervalSeconds` (default 60; env `STEWARD_TASK_BOARD_RECONCILE_INTERVAL_SECONDS`; `0` disables); also once at `TaskBoard.open` beside `reconcileWorkflows` (board.ts:100).
- Pinned claim block: optional `pinned { runtime, runtimeVersion, model, promptsSha }`, each string 1–128 chars, no `\r`/`\n`; unknown keys rejected; stored verbatim; claim replay returns the ORIGINAL pinned values (claim_result_json dedupe already guarantees this — do not re-store on replay).
- Browser-profile tolerance: ONLY `tasks[].status` and `workItems[].state` parse unknown strings to `'unrecognized'`; strict profile still throws. Web view vocabulary gains `unrecognized` with copy "Unknown state — refresh the app"; zero affordances.
- View labels: queued "Queued" · planning "Planning" · plan_approval "Plan review" · designing "Design" · implementing "Implementing" · verifying "Verifying" · reviewing "Reviewing" · fixing "Fixing" · final_approval "Final review" · merged "Done" · parked "Parked" · abandoned "Cancelled" · dead_letter "Failed".
- Every task: `npm run typecheck:all` + its suite green before commit. Codex sandbox cannot bind listeners — controller re-runs HTTP/e2e outside.

---

### Task 1: Contract vocabulary and transition table

**Files:**
- Modify: `src/shared/task-board-contract/index.ts` (WORK_ITEM_STATES :114, TASK_BOARD_ERROR_CODES :3, doc block :38-52)
- Modify: `src/shared/task-board-contract/validate.ts` (only if any message pins old state names — grep `submitted|needs_input|waiting_for_human_review` and update)
- Test: `tests/shared/task-board-contract/unions.test.ts` (:25-29 vocabulary pins) + new transition tests in the same file or sibling

**Interfaces (produces):**
```ts
export const WORK_ITEM_STATES = [/* 13 values, Global Constraints order */] as const;
export type WorkItemState = typeof WORK_ITEM_STATES[number];
export const WORK_ITEM_TERMINAL_STATES = ["merged","abandoned","dead_letter"] as const;
export function isTerminalWorkItemState(state: WorkItemState): boolean;
export const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemState, readonly WorkItemState[]>>;
export function isWorkItemTransitionAllowed(from: WorkItemState, to: WorkItemState): boolean;
```
plus `WORK_ITEM_ILLEGAL_TRANSITION` in `TASK_BOARD_ERROR_CODES`.

- [ ] **Step 1: failing tests** — in the unions test file: exact 13-value array equality; terminals absorbing (`WORK_ITEM_TRANSITIONS[t].length === 0`); every non-terminal reaches `abandoned` and `dead_letter`; every state except `queued` is some edge's target and every non-terminal has ≥1 edge (reachability/liveness); spot-pin the reverse edges `reviewing→planning`, `fixing→verifying`, `final_approval→implementing`, `parked→implementing`; `isWorkItemTransitionAllowed('merged','planning') === false`.
- [ ] **Step 2: run to fail** — `npm run test:runtime` (unions test compiles against missing exports).
- [ ] **Step 3: implement** exactly per Global Constraints (transition table literal, helpers trivial lookups). Update the index.ts doc block to list `work_item_transitions` among CHECK-backed tables.
- [ ] **Step 4: green** — unions test passes; `typecheck:all` will FAIL repo-wide (store CHECKs, web) — expected; record the failure list in the report; Tasks 2 and 7 burn it down. The task gate is: unions tests green + `tsc -p tsconfig.bootstrap.json` green.
- [ ] **Step 5: commit** `feat: orchestrator work-item state vocabulary and transition table`

### Task 2: v19 migration, golden fixture, drift tests

**Files:**
- Modify: `src/server/task-board/persistence/store.ts` (SCHEMA_VERSION :28 → 19; base SCHEMA work_items block :~430s + new table + runs block :467-486; new `migrateVersion18To19` after :710; ladder :998-1006; runner after :1018)
- Create: `tests/server/task-board/fixtures/v19-schema.sql`
- Modify: `tests/server/task-board/contract-drift.test.ts` (golden retarget :81-90; CHECK-fragment pairs :92-130 — update the work-items pair and add `work_item_transitions` pairs; add v18→v19 test mirroring :132-163; keep the v17 chain test asserting final version 19)
- Modify: `tests/server/task-board/board.test.ts` (`user_version === 18` assertions at :5949, :5989, :6026, :6065 → 19)

**Interfaces:** consumes Task 1's constants. Produces the v19 schema every later task builds on.

- [ ] **Step 1: base SCHEMA.** work_items `state` CHECK and terminal-coupling CHECK use the new vocabulary via `sqlStringList`; append the `work_item_transitions` table (Global Constraints DDL) after work_items; add the five runs columns to the runs CREATE.
- [ ] **Step 2: `migrateVersion18To19(db)`** — guard on missing `work_items` table → `PRAGMA user_version = 19` only. Else, v13→v14 pattern: `PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;` create `work_items_v19` with the new DDL; `INSERT … SELECT` all columns with the mapping CASE (Global Constraints) replacing `state`; drop/rename; recreate work_items indexes (copy names from the v18 fixture); create `work_item_transitions`; seed `INSERT INTO work_item_transitions SELECT work_item_id, 1, NULL, state, 'system', 'system:migration', updated_at FROM work_items;`; `ALTER TABLE runs ADD COLUMN …` ×5 (guard with `hasColumns`); `PRAGMA foreign_key_check` → `DATABASE_MIGRATION_FOREIGN_KEY_FAILED`; `PRAGMA user_version = 19; COMMIT;` finally FK ON.
- [ ] **Step 3: migration test** — seed a v18 DB (exec `fixtures/v18-schema.sql` re-sorted like :139-144, `user_version = 18`) with one work-item row per mapping cell: `submitted`, `needs_input`, `completed`, `failed`, `cancelled`, `waiting_for_human_review×human_review`, `waiting_for_human_review×planning`, `processing×implementation`, `processing×deployment`, `processing×testing`, `processing×verification`, `processing×refinement`, `processing×NULL` (terminal rows get `ended_at`). Open the store; assert version 19, each row's migrated state, one seeded transition row per item with `from_state IS NULL` and `to_state` = migrated state, and empty `foreign_key_check`.
- [ ] **Step 4: regenerate the golden fixture** — run the store fresh, dump via the test's own `frozenSchema()` shape, write `fixtures/v19-schema.sql`, retarget the byte-identity test; update CHECK-fragment pairs.
- [ ] **Step 5: green** — `npm run test:runtime` (all suites; note web still red on vocabulary until Task 7 — web is vitest, not in this command) and `npm run typecheck:runtime`.
- [ ] **Step 6: commit** `feat: v19 — work-item pipeline states, transition log, run heartbeat and pinning columns`

### Task 3: Transition helper and writer rewrites

**Files:**
- Create: `src/server/task-board/collaborators/work-item-transitions.ts`
- Modify: `src/server/task-board/collaborators/work-items.ts` (:140 insert, :261 start-planning, :288 update, :396 cancel), `runs.ts` (:535 question→parked), `runtime.ts` (:272 stage progression)
- Test: `tests/server/task-board/work-item-transitions.test.ts` (+ existing work-item tests updated to the new vocabulary)

**Interfaces (produces):**
```ts
export interface WorkItemTransitionRequest {
  workItemId: string; to: WorkItemState;
  actorType: "human" | "agent" | "system"; actorId: string;
  now: string;                       // ISO timestamp from the caller's clock
  endedAt?: string;                  // required iff `to` is terminal
  cancelledReason?: string | null;   // abandoned only
  currentStage?: WorkItemStage | null; // when the caller also moves the stage
}
export function transitionWorkItemInTransaction(store: TaskBoardStore, request: WorkItemTransitionRequest): { fromState: WorkItemState; version: number };
```
Behavior: read current `state`,`version` (row must exist → existing not-found error); no-op returns early if `to === from` AND no stage/reason change requested (idempotent); else `isWorkItemTransitionAllowed(from, to)` or throw `conflict(WORK_ITEM_ILLEGAL_TRANSITION, \`work item cannot move ${from} -> ${to}\`)`; single UPDATE bumping `version+1`, setting `ended_at`/`cancelled_reason`/`current_stage` per request; INSERT the transition row with `sequence = 1 + COALESCE(MAX(sequence),0)`. Must be called inside an existing store transaction (same discipline as the other `*InTransaction` helpers).

- [ ] **Step 1: failing tests** — legality matrix (allowed edge succeeds with version bump + appended row; illegal edge → `WORK_ITEM_ILLEGAL_TRANSITION` and NO row/version change; terminal target requires `endedAt`, non-terminal forbids it — assert both violations throw); idempotent same-state no-op appends nothing; sequence increments 1,2,3 under successive transitions.
- [ ] **Step 2: implement the helper.**
- [ ] **Step 3: rewrite the writers** — create inserts `queued` + `NULL→queued` transition (actor = creator); start-planning → helper `to:'planning', currentStage:'planning'`; question path → `to:'parked'`; answer/resume path (grep for the writer that returns `needs_input` items to `processing`) → `to:'planning'` or the stage-mapped state via the shared stage→state map (export `workItemStateForStage(stage)` from the helper module implementing the Global Constraints mapping's `processing×stage` rows); cancel → `to:'abandoned', endedAt, cancelledReason`; runtime stage progression (:272) → stage-mapped state, completion → `merged` (legal via the legacy edges), failure → `dead_letter`. Delete all raw `UPDATE work_items SET state=` statements — the helper is the only state writer (grep proves zero remaining). Also extend the server's work-item DETAIL envelope (the single-item read path, not the list) with `transitions: [{ fromState, toState, actorType, actorId, createdAt }]` ordered by sequence — Task 7 adds it to the shared validator field list, Task 8 asserts it over HTTP.
- [ ] **Step 4: update existing runtime/work-item tests** to the new vocabulary (mechanical: old state string → mapped new string; the intake HTTP tests assert `state` values in envelopes).
- [ ] **Step 5: green** — `npm run test:runtime`, `npm run typecheck:runtime`.
- [ ] **Step 6: commit** `feat: single transition helper enforces the work-item state machine`

### Task 4: Heartbeat route, stale-run sweep, reconcile interval

**Files:**
- Modify: `src/server/task-board/collaborators/runs.ts` (heartbeat write + `reconcileStaleRuns`), `board.ts` (public method + startup call beside :100), `service.ts` (route + interval timer + close handling), `config.ts` (+`heartbeatTimeoutSeconds`, `reconcileIntervalSeconds`, bounded non-negative ints), `main.ts` (env)
- Test: `tests/server/task-board/heartbeat.test.ts`

**Interfaces:** `board.heartbeatRun(runId, agentAuth)` per the settle route's auth shape; `board.reconcileStaleRuns(): number` (settled count) — later tasks and tests call it synchronously.

- [ ] **Step 1: failing tests** — heartbeat: unknown run 404; settled run 409 `RUN_NOT_ACTIVE`; wrong agent / stale credential version → the same errors the settle route gives; success sets `heartbeat_at`, second call moves it, `version`/events untouched. Sweep: active run with `started_at` older than timeout and no heartbeat → settled `interrupted`, result `"run heartbeat lost"`, task `interrupted` (recoverable), workflow repair invoked (assert via the same observable the settle tests use); recent heartbeat survives; timeout 0 → sweep returns 0 and touches nothing; sweep is idempotent (second call 0).
- [ ] **Step 2: implement** — write path + sweep (`SELECT run_id FROM runs WHERE status='active' AND COALESCE(heartbeat_at, started_at) < ?`, settle each in its own transaction via `settleActiveRunInTransaction`, count). Config/env per Global Constraints. Service: `setInterval` when `reconcileIntervalSeconds > 0` calling `board.reconcileStaleRuns()` + `reconcileWorkflowsBestEffort()`, `unref()`d, cleared in `close()`; startup call in `TaskBoard.open`.
- [ ] **Step 3: HTTP route** — `POST /v1/runs/:id/heartbeat` beside the settle route, same body-less shape, `sendJson(response, 200, { run: … })` with the run envelope (heartbeat fields included once Task 5 extends the envelope — until then return `{ ok: true }`; Task 5 flips it, note in report).
- [ ] **Step 4: green** — `npm run test:runtime` (listener tests EPERM in sandbox — controller verifies), `typecheck:runtime`.
- [ ] **Step 5: commit** `feat: run heartbeats and the stale-run sweep`

### Task 5: Claim-time pinning

**Files:**
- Modify: `src/shared/task-board-contract/index.ts` (ClaimRequest type + run envelope fields), `validate.ts` (claim parser + run entity field list :~parseRun), `src/server/task-board/schema.ts` (parseClaim), `collaborators/runs.ts` (claim insert + envelope), `service.ts` (only if envelope assembly lives there)
- Test: extend `tests/server/task-board/host-routes.test.ts`-style HTTP coverage in the existing claim/settle test file + validator unit tests

**Interfaces:** claim request gains `pinned?: { runtime?: string; runtimeVersion?: string; model?: string; promptsSha?: string }`; run envelopes gain nullable `runtime`, `runtimeVersion`, `model`, `promptsSha`, `heartbeatAt` (this task also adds `heartbeat_at` to the envelope and flips Task 4's route to return `{ run }`).

- [ ] **Step 1: failing tests** — parser: unknown key inside `pinned` rejected; 129-char value rejected; `\n` rejected; absent block fine. Claim: pinned values stored and echoed; replayed duplicate claim (existing dedupe test pattern) echoes ORIGINAL values even when the replay sends different ones; run envelope carries nulls when unpinned.
- [ ] **Step 2: implement.** Envelope: extend the run entity field list in validate.ts (closed-world — both profiles).
- [ ] **Step 3: green** — `test:runtime` + `typecheck:all` (web parses run envelopes through shared validate — the field-list change must not break web tests; run `npm run test:web` too).
- [ ] **Step 4: commit** `feat: claims pin runtime, model, and prompts identity`

### Task 6: Worker heartbeat timer and pinned claims

**Files:**
- Modify: `src/server/agents/task-worker/http-board-client.ts` (claim call + `heartbeatRun`), `worker.ts` (timer around the run-watch loop), `src/server/agents/task-fleet/` lane config plumbing (runtime version capture at lane start: run `<cli> --version`, first line, best-effort null)
- Test: existing worker/fleet suites (`tests/server/agents/…`) extended

**Interfaces:** consumes Task 5's `pinned` block and Task 4's route.

- [ ] **Step 1: failing tests** — worker sends `pinned.runtime` = its configured CLI kind and `pinned.runtimeVersion` when the launcher reports one; heartbeat POSTs recur while a run is watched (fake timers, assert ≥2 calls at 30 s cadence) and stop after settle; heartbeat HTTP failure logs and does not kill the lane.
- [ ] **Step 2: implement** — 30 s `setInterval` started when the worker begins watching an active run, cleared on settle/interrupt/close; version capture once per lane start.
- [ ] **Step 3: green** — `npm run test:runtime`, `typecheck:all`.
- [ ] **Step 4: commit** `feat: workers heartbeat their runs and pin claim identity`

### Task 7: Web vocabulary migration and forward tolerance

**Files:**
- Modify: `src/shared/task-board-contract/validate.ts` (browser-profile tolerance for `tasks[].status` + `workItems[].state`; work-item detail envelope gains `transitions` array in the field list), `src/web/task-board/data/wire.ts`, `types.ts`, `model/project.ts` (+ every view consuming work-item states — grep old strings: `submitted|needs_input|waiting_for_human_review|processing`), `model/task-recovery.ts` (unrecognized → null affordances already falls out of `contractStatus`), `views/ThreadPipelineTable.tsx` and intake views (label map per Global Constraints)
- Test: `wire.test.ts` (:84 auto-updates), new tolerance tests in the contract validate tests, updated view tests

**Interfaces:** view unions gain `'unrecognized'`; `parseWorkItemTransitions` on the detail parse path (typed, undisplayed this campaign).

- [ ] **Step 1: failing tests** — strict profile rejects `state:"zzz"` (existing behavior pinned); browser profile parses it to `'unrecognized'` for both fields; view label map exhaustiveness is a compile-time `Record<WorkItemState | 'unrecognized', string>`; recovery affordances for an `unrecognized` task status are null.
- [ ] **Step 2: implement** — tolerance via the existing option-profile mechanism in validate.ts (a `tolerantEnums` flag on the browser profile consulted by `entityMember` for exactly those two field paths); vocabulary swap everywhere; "Unknown state — refresh the app" badge copy.
- [ ] **Step 3: green** — `npm run test:web`, `npm run typecheck:all`, `npm run build`.
- [ ] **Step 4: commit** `feat: pipeline vocabulary in the web app with forward-tolerant parsing`

### Task 8: E2e vocabulary, transitions exposure test, campaign verification

**Files:**
- Modify: `tests/e2e/task-board.spec.ts` (fixture `state` values → new vocabulary; assertion copy per label map)
- Modify: whichever HTTP test asserts the work-item detail envelope — add `transitions` array assertions (seeded item: one `NULL→queued` row after create, second row after a transition)
- Test: full verification

- [ ] **Step 1: update e2e fixtures/assertions** (grep `submitted|processing|needs_input|waiting_for_human_review` in tests/e2e).
- [ ] **Step 2: transitions envelope HTTP assertions.**
- [ ] **Step 3: full verification** — `npm test`, `npm run typecheck:all`, `npm run test:e2e`, `npm run build` all green (controller runs e2e/listener suites outside the sandbox).
- [ ] **Step 4: commit** `test: e2e and envelope coverage for the pipeline state machine`
