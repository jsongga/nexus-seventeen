# Campaign 7 — Scheduling + Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disjoint pipeline items run in parallel while overlapping ones hold automatically; runaway stages/tasks are suspended and parked by wall-clock caps; a kill switch drains claims and freezes in-flight work resumable; a pending final approval withdraws when the base branch advances.

**Architecture:** The serial guard is replaced by a scope-overlap hold at the node-activation chokepoint (`blocked` + `node_blocked` = an idempotent, reconciler-self-releasing hold — no new node state). A new *suspend* settle variant (run settles interrupted, node blocked with `node_blocked` not `stage_failed`, no attempt/dead-letter accounting) is shared by the cap sweep and the kill switch, avoiding the discovered trap where interrupted settles strand nodes and burn attempts. Concurrency > 1 comes from idle-preferred agent selection within a role. Base movement is a poller reusing the merge executor's valid-target rules, riding the final-approval return machinery with `base_sha` re-anchored. Schema v23 rebuilds the two CHECK-backed ledger tables to admit new enum members and adds a `board_pause` singleton.

**Tech Stack:** Node 24 / TypeScript, SQLite single-sourced schema (v22 → v23), `node:test` runtime suite, vitest web suite, existing collaborator/transaction patterns.

**Spec:** `docs/superpowers/specs/2026-08-21-scheduling-budgets-design.md` (read it — the seam facts and traps it cites were verified 2026-08-21; re-grep if a line drifted).

## Global Constraints

- **Schema v23 in ONE migration** (Task 1): REBUILD `park_records` + `notifications` per the established CHECK-rebuild shape (`migrateVersion13To14` / `18To19` precedents: `PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;` → create `_v23` tables with new CHECKs → `INSERT ... SELECT ... ORDER BY rowid` → drop/rename → recreate unique indexes → `PRAGMA foreign_key_check` → `user_version = 23; COMMIT;` with ROLLBACK guard) plus additive `board_pause`. Later tasks add no schema.
- **Never** add members to `WORKFLOW_STAGES` / `WORK_ITEM_STATES` / `WORK_NODE_STATES` / `PLAN_REVISION_STATES` / `REVIEW_FINDING_*`. The new members go ONLY to `PARK_CATEGORIES` and `NOTIFICATION_KINDS` (rebuilt in Task 1).
- **System actors may not settle `completed`** (`runs.ts` guard). New actors verbatim: `system:stage-cap`, `system:task-cap`, `system:kill-switch`, `system:base-branch-poll`.
- **Every work-item state write** via `transitionWorkItemInTransaction` (parks carry `park: { category, reason }`); durable writes ride `store.transaction` with afterCommit side effects; sweeps use per-item transactions that re-assert preconditions and never throw out of timers.
- **HTTP conventions** per `service.ts` (regex route + method guard, `noQuery`, named parsers, registered error codes, human auth, CAS `version` guards). Config knobs via `boundedInteger` + `STEWARD_TASK_BOARD_*` env in `main.ts`; timer floors 60 s; `0` disables.
- **Git safety:** array-args execFile, no shell, `-c core.fsmonitor= -c core.hooksPath=`; injectable runners for tests.
- **No new npm deps.** Inner loop `npm run verify:fast -- --base HEAD`; gate `npm run typecheck:runtime && npm run test:runtime`; web tasks also `npm run typecheck:all && npm run test:web`. Exact strings (actors, reasons, summaries, prefixes, error codes) are contracts — copy verbatim.
- **Sandbox note (Codex):** loopback listeners may be blocked (`EPERM`) — note per test; the controller re-runs gates outside. Do NOT commit or touch `.git`.
- **Fix-diff packages include untracked files** (controller-side note; implementers just report new files explicitly).

## File Map (created/modified per task)

| Task | Server | Contract/Schema | Web | Tests |
| --- | --- | --- | --- | --- |
| 1 schema+knobs | persistence/store.ts (v23), config.ts, main.ts | index.ts, validate.ts | parse.ts projections, labels | contract, drift (freeze v22 fixture), config |
| 2 overlap gating | collaborators/scope-check.ts, projects.ts (activation), persistence/workflow.ts (guard deletion) | SCOPE_HOLD_SUMMARY_PREFIX | — | predicate, hold/release integration |
| 3 concurrency | collaborators/projects.ts (agent pick), agent-identities.ts | — | — | selection units, two-identity integration |
| 4 suspend+kill switch | collaborators/runs.ts, persistence/workflow.ts (suspend node path), new collaborators/board-pause.ts, verify-attempts.ts (start gate), service.ts, board.ts, schema.ts | BoardPause type; error code | — | suspend semantics, pause gate, endpoints |
| 5 cap sweeps | new collaborators/wall-clock.ts, service.ts (timer), board.ts | — | — | clock units, sweep integration |
| 6 withdrawal poller | new collaborators/base-branch-poll.ts, persistence/workflow.ts (actor threading, base_sha update), projects.ts, service.ts (timer), board.ts | — | — | poller units, withdrawal integration |
| 7 closer unification | collaborators/work-items.ts, park-lifecycle.ts, work-item-transitions.ts | — | — | closer units, cancel/auto-abandon integration |
| 8 web+e2e+roadmap | — | — | WorkspaceSidebar/BoardApp (pause), labels | pipeline e2e arcs; roadmap edit |

---

### Task 1: Schema v23, contract enums, board_pause, cap knobs

**Files:**
- Modify: `src/shared/task-board-contract/index.ts`, `validate.ts`; `src/server/task-board/persistence/store.ts` (SCHEMA_VERSION 22 → 23; `migrateVersion22To23`); `src/server/task-board/config.ts`, `main.ts`; `src/web/task-board/data/parse.ts` (loose projections), `src/web/task-board/model/*labels*` (category/kind labels)
- Test: `tests/shared/task-board-contract/`; `tests/server/task-board/contract-drift.test.ts` (freeze `fixtures/v22-schema.sql`, extend the frozen-projection loop to 22, v22→v23 replay preserving rows THROUGH the rebuild, CHECK byte-equality); config tests

**Interfaces — Produces (exact; later tasks consume):**

```typescript
// PARK_CATEGORIES gains, in order after the existing seven:
"stage_cap_exceeded", "task_cap_exceeded", "base_diverged"
// NOTIFICATION_KINDS gains, after the existing two:
"cap_parked", "final_approval_withdrawn"
export interface BoardPause { readonly paused: boolean; readonly reason: string | null; readonly version: number; readonly updatedAt: string; readonly updatedBy: string }
export const SCOPE_HOLD_SUMMARY_PREFIX = "scope-hold: ";
// TASK_BOARD_ERROR_CODES += "TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT"
// config: stageCapSeconds (default 3_600), taskCapSeconds (default 10_800); 0 disables; floor 60 non-zero; taskCapSeconds >= stageCapSeconds when both non-zero else INVALID_CONFIGURATION; env STEWARD_TASK_BOARD_STAGE_CAP_SECONDS / STEWARD_TASK_BOARD_TASK_CAP_SECONDS
```

```sql
CREATE TABLE IF NOT EXISTS board_pause (
  pause_id TEXT PRIMARY KEY CHECK (pause_id = 'board'),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  reason TEXT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
) STRICT;
INSERT INTO board_pause(pause_id, paused, reason, version, updated_at, updated_by)
  VALUES ('board', 0, NULL, 1, '1970-01-01T00:00:00.000Z', 'system:steward-default');
```

(Seeded-in-DDL singleton per the `automation_configuration` precedent; the migration installs it AND the base DDL carries it. The two rebuilt tables keep byte-identical column lists; only the CHECK lists widen — new members appended so existing rows copy unchanged. Recreate `notifications`' `sequence` UNIQUE + `dedupe_key` UNIQUE; `park_records` has no extra indexes.)

Validators: `parseBoardPause` (strict + loose); category/kind label maps in the web get the five new members (tolerant enums already bucket unknowns for old tabs).

Steps: failing tests (drift replay: seed v22 rows in both tables incl. every OLD enum member → migrate → rows byte-survive and NEW members insert; old members still valid; board_pause seeded row present + CHECK-pinned id; config bounds incl. cross-knob invariant and floor-60 acceptance) → implement → gate. Commit (controller): `feat: cap knobs, board pause, extended park and notification enums (schema v23)`.

---

### Task 2: Scope-overlap gating replaces the serial guard

**Files:**
- Modify: `src/server/task-board/collaborators/scope-check.ts` (+predicate), `src/server/task-board/collaborators/projects.ts` (`activateWorkflowNode` — insert the hold between stage resolution and agent resolution, ~:630-674), `src/server/task-board/persistence/workflow.ts` (DELETE `assertPipelineSerialAvailability` :248-265 and both call sites :691, :725)
- Test: `tests/server/task-board/collaborators/scope-check.test.ts` (or the file holding its units); integration in `final-approval.test.ts` (replace the serial-guard test) + a new hold/release case

**Interfaces — Produces:**

```typescript
// scope-check.ts (reuse the existing prefix normalization; empty prefix throws):
export function declaredScopesOverlap(a: readonly string[], b: readonly string[]): boolean;
// true iff any pair x∈a, y∈b: x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
```

**Behavior:**

- In `activateWorkflowNode`, for a node whose plan is pipeline-shaped: query other work items in the project with `pipeline_branch IS NOT NULL`, state IN `('implementing','verifying','reviewing','fixing','designing','final_approval','parked')`, join their confirmed revisions' `declared_scope_json`; if any overlaps this item's declared scope → `blockNodeInTransaction(nodeId, `${SCOPE_HOLD_SUMMARY_PREFIX}overlaps ${otherWorkItemId}`)` and return. Re-holding no-ops (existing `WHERE state='ready'` semantics); the reconciler retries blocked-with-`node_blocked`-latest candidates every tick and after every settle, and activation re-checks the overlap each pass — release is automatic.
- Delete the serial guard + its two call sites; `TASK_BOARD_PIPELINE_SERIAL_CONFLICT` stays registered (comment: retired campaign 7) but is no longer thrown. Update `final-approval.test.ts:1326-1340` from "second confirm 409s" to "second confirm succeeds; its node holds with the scope-hold summary".

Tests: predicate table (equal, parent/child nesting both directions, disjoint siblings, trailing-slash normalization, multi-prefix any-pair; scopes are already validated non-empty elsewhere — empty input throws per the existing normalization). Integration: two pipeline items, overlapping scopes → item B's implementation node blocked with summary exactly `scope-hold: overlaps <A>`; A merges → `reconcileWorkflowsBestEffort` → B activates and proceeds; disjoint scopes → both nodes activate immediately; a PARKED A still holds B (parked in-flight set). Commit (controller): `feat: scope-overlap hold at activation replaces the serial pipeline guard`.

---

### Task 3: Concurrency > 1 — idle-preferred agent selection

**Files:**
- Modify: `src/server/task-board/collaborators/projects.ts` (:674-692 agent resolution), `src/server/task-board/collaborators/agent-identities.ts` (:73-87 `createLazyManagerInTransaction`), `src/server/agents/task-fleet/fleet.example.json` (+ a commented second engineer lane showing the pattern)
- Test: selection units + a two-identity integration

**Behavior:**

- Agent resolution becomes idle-preferred: first
  `SELECT * FROM agents WHERE project_id=? AND role=? AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.agent_id=agents.agent_id AND runs.status='active') AND NOT EXISTS (<pending live wakeup for agents.agent_id — the exact predicate the claim candidate query uses: wakeups.claimed_at IS NULL, task status IN ('queued','blocked') or taskless, not retired>) ORDER BY created_at, agent_id LIMIT 1`;
  fall back to the existing oldest-identity query when no idle agent exists (single-lane behavior byte-identical). Factor the pending-wakeup EXISTS into one shared SQL fragment/helper reused by both this and `agentFromRow`'s status derivation if trivially extractable — do not fork the predicate.
- `createLazyManagerInTransaction`: when multiple managers exist, return the OLDEST (`ORDER BY created_at, agent_id LIMIT 1`) instead of null.

Tests: with two engineer identities — idle one chosen while the other has an active run; both busy → oldest (current behavior); wakeup-pending (unclaimed) identity is NOT idle; manager duplicate → planning starts with the oldest manager (was: null/broken). Integration: two work items (disjoint scopes, Task 2 landed), two engineer identities → both implementation tasks dispatch to DIFFERENT agents. Commit (controller): `feat: idle-preferred agent selection within a role`.

---

### Task 4: Suspend settle, board pause, kill-switch endpoints

**Files:**
- Create: `src/server/task-board/collaborators/board-pause.ts`
- Modify: `src/server/task-board/collaborators/runs.ts` (suspend + claim gate at the first line of candidate selection ~:330), `src/server/task-board/persistence/workflow.ts` (+`suspendAttemptNodeInTransaction`), `src/server/task-board/collaborators/verify-attempts.ts` (skip `#start` while paused — rows stay `starting` and start after resume), `service.ts` (routes), `board.ts`, `schema.ts`
- Test: suspend semantics; pause gate; endpoint CAS; resume kick

**Interfaces — Produces:**

```typescript
// board-pause.ts:
getBoardPause(): BoardPause;
setBoardPause(input: { paused: boolean; reason: string | null; version: number; actor: string }): BoardPause; // CAS else 409 TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT
isBoardPaused(): boolean; // cheap single-row read
// runs.ts:
suspendActiveRunInTransaction(runId: string, reason: string, actor: SettlementActor): { workItemId: string | null; projectId: string } | null; // null when run not active
suspendAllActiveRuns(reason: string, actor: SettlementActor): number; // per-run transactions
// workflow.ts:
suspendAttemptNodeInTransaction(taskId: string, reason: string): void; // node → blocked + node_blocked event (NOT stage_failed); no attempt/cap/dead-letter accounting; work item state untouched
// HTTP (human): GET /v1/board/pause → BoardPause; POST /v1/board/pause { reason: string(1..500) | null, version }; POST /v1/board/resume { version }
```

**Behavior:**

- `suspendActiveRunInTransaction`: re-check `status='active'`; settle the run `interrupted` with `result: reason` and the given system actor via the EXISTING run-settle plumbing BUT routed so the workflow side calls `suspendAttemptNodeInTransaction` instead of `settleAttemptInternal`'s fail branch (add a settle option threaded from the suspend entry point — the guard "system actors may not settle completed" untouched; pending wakeups for the task are retired as on any interrupt). Planning/design runs (no node) are NOT suspended by the kill switch — a suspend would park the item via the existing non-completed-settle branch, contradicting "pause freezes resumable"; they are short and run to completion (the Task 5 cap sweep bounds them via runs.started_at). `suspendAllActiveRuns` therefore selects only stage-attempt runs of pipeline items.
- Pause: `POST /v1/board/pause` sets the row, then `suspendAllActiveRuns("board paused: " + (reason ?? "kill switch"), {type:"system", id:"system:kill-switch"})`. Claims: first line of claim candidate selection → `if (isBoardPaused()) return null;` (yields the existing 204/long-poll behavior). Verify sweep: `#start` (and the failed_to_start restart) no-op while paused; running verify polls continue to settle.
- Resume: clears the flag, then `wakeupEvents` emit for every agent with a pending live wakeup + `reconcileWorkflowsBestEffort()`.
- Pausing an already-paused board with correct version no-ops (idempotent, version still bumps only on change — decide: version bumps on every accepted POST; simplest and CAS-consistent).

Tests: suspend on an active implementation run → run `interrupted` actor `system:kill-switch`, node `blocked` with `node_blocked` (NOT `stage_failed`), item state unchanged, NO dead-letter even at attempt 3, reconciler re-activates the node after resume and the next claim links attempt N+1; suspend on a settled run → null no-op; pause → claim returns null/204 for an agent with pending work; verify `starting` row does not start while paused, starts after resume; endpoints: CAS conflict 409, wrong-version resume 409, pause state round-trips; resume emits wakeups (agent long-poll unblocks). Commit (controller): `feat: suspend settle, board pause, and the kill switch`.

---

### Task 5: Wall-clock cap sweeps

**Files:**
- Create: `src/server/task-board/collaborators/wall-clock.ts`
- Modify: `service.ts` (timer beside the park sweep, reconcile cadence, `.unref()`, cleared in close), `board.ts`
- Test: clock units (injected rows), sweep integration (driven clock)

**Interfaces — Produces:**

```typescript
// wall-clock.ts:
stageElapsedSeconds(db, nodeId: string, now: string): number | null;   // now - MAX(project_events.created_at WHERE node_id=? AND event_type IN ('stage_started','stage_retry_ready')); null when no event
taskActiveSeconds(db, workItemId: string, now: string): number;        // sum of intervals in states implementing|verifying|reviewing|fixing|designing walked from work_item_transitions (ordered by sequence; the current open interval closes at `now`)
sweepWallClockCaps(now: string): { suspended: number; parked: number };
```

**Behavior:** for each ACTIVE run belonging to a pipeline work item (join runs → tasks → stage_attempts → nodes → confirmed plan → item; plus planning/design runs of pipeline items via their link tables, whose stage clock is `runs.started_at`):

- stage clock over `stageCapSeconds` (>0) → in one per-item transaction (re-checking the run is still active and the item state unchanged): `suspendActiveRunInTransaction(runId, reason, {type:"system", id:"system:stage-cap"})` then park the item — `transitionWorkItemInTransaction(... to: "parked", park: { category: "stage_cap_exceeded", reason }, actorType: "system", actorId: "system:stage-cap", currentStage: <current>)` — reason verbatim: `` `stage cap exceeded: ${stage} ran ${elapsed}s (cap ${cap}s)` ``; notification kind `cap_parked`, dedupe `cap_parked:<workItemId>:<attemptOrRunId>`, summary `` `Work item parked: ${reason}` ``.
- else task clock over `taskCapSeconds` (>0) → same shape with category `task_cap_exceeded`, actor `system:task-cap`, reason `` `task cap exceeded: ${elapsed}s agent-active (cap ${cap}s)` ``.
- Both disabled → sweep no-ops. Sweep failures logged per item, never thrown.

Tests: clock units — stage entry from `stage_started` then later `stage_retry_ready` (uses the LATEST); task clock sums only agent-active states across a park/resume history and closes the open interval at `now`; gates/parked time excluded. Sweep integration (injectable `now`): a stage 3 601 s old with an active run → run suspended (node_blocked), item parked `stage_cap_exceeded` with the exact reason, notification written once (second sweep dedupes); task-cap case; caps 0 → untouched; a run that settles between candidate query and transaction → no-op. Commit (controller): `feat: wall-clock cap sweeps park runaway stages and tasks`.

---

### Task 6: Base-branch withdrawal poller

**Files:**
- Create: `src/server/task-board/collaborators/base-branch-poll.ts`
- Modify: `src/server/task-board/persistence/workflow.ts` (`returnFinalApprovalToImplementationInTransaction` gains `actorType: "human" | "system"` — today hard-coded at the transition write; and an optional `newBaseSha` that updates `work_items.base_sha` in the same transaction), `src/server/task-board/collaborators/projects.ts` (expose a locked entry point mirroring reject-final's), `service.ts` (timer), `board.ts`
- Test: poller units (injected git runner), withdrawal integration on fixture repos

**Interfaces — Produces:**

```typescript
// base-branch-poll.ts:
sweepBaseBranch(now: string): { withdrawn: number; diverged: number };
```

**Behavior:** for each work item in `final_approval` with `pipeline_branch IS NOT NULL`:

- Resolve the project repo path; read `HEAD` via the injectable neutralized runner. **Valid-target check first** (reuse/extract the merge executor's rules — not detached, not the item's task branch, not `task/*`, clean tree): invalid → no-op (never withdraw on transient operator checkout state).
- `HEAD === base_sha` → no-op. Else if `git merge-base --is-ancestor <base_sha> <HEAD>` → **withdraw** under `withFinalApprovalLock`: re-read state + version inside the lock; call the return machinery with note verbatim `` `base branch advanced to ${head}; rebase onto it and re-verify` ``, target state via the fix-aware mapping (as the merge-conflict path does), `gateAction: null`, `actorType: "system"`, actor `system:base-branch-poll`, `newBaseSha: head`; then notification kind `final_approval_withdrawn`, dedupe `final_approval_withdrawn:<workItemId>:<head>`, summary `` `Final approval withdrawn: base branch advanced to ${head.slice(0, 10)}` ``; `activateWorkflowNodes(readyNodes)` after commit.
- Else (base not an ancestor — history rewritten) → park with category `base_diverged`, reason verbatim `` `base branch history rewritten (was ${baseSha}, now ${head})` ``, actor `system:base-branch-poll` (suspend any active run first — there should be none in `final_approval`, assert not).
- Timer beside the others (reconcile cadence). Races with a concurrent approve-merge resolve via the lock + state re-check (loser no-ops).

Tests: unit with fake git — equal shas no-op; advanced head withdraws once (second sweep: item no longer in final_approval → no-op); detached/task-branch/dirty target no-ops; rewritten history parks `base_diverged`. Integration on fixture repos: item at final_approval → commit to the fixture's main → sweep → item back to `implementing` (clean history) with the note as handoff, `base_sha` updated to the new head, notification present; then the engineer stub rebases (merge or reset for the fixture), verify green, review passes, approve-merge lands BOTH changes on main (proving the re-anchored base composes with scope check + merge). Commit (controller): `feat: base-branch poller withdraws pending final approvals`.

---

### Task 7: Task-closing unification + park-exit actor type

**Files:**
- Modify: `src/server/task-board/collaborators/work-items.ts` (factor `closeWorkItemWorkInTransaction` from cancel's steps; extend to design + stage tasks), `src/server/task-board/collaborators/park-lifecycle.ts` (auto-abandon calls it), `src/server/task-board/collaborators/work-item-transitions.ts` (:145-153 `resolutionForParkExit`)
- Test: closer units; cancel + auto-abandon integration

**Interfaces — Produces:**

```typescript
// work-items.ts:
closeWorkItemWorkInTransaction(workItemId: string, reason: string, actor: { type: "human" | "system"; id: string }, now: string): void;
// cancels (status 'cancelled') every non-hard-terminal task linked to the item — planning (work_item_planning_tasks), design (work_item_design_tasks), stage (stage_attempts→tasks) — with reconcileTaskPhasesForTerminal, retirePendingWakeupsForTask, task_updated events; closes open questions on those tasks with the count-asserted UPDATE + human_question_closed events (reason "work_item_cancelled"). Reason text passes redactForPersistence once at the top.
```

**Behavior:** `cancelWorkItem` delegates its steps 3–7 to the closer (existing semantics preserved — same strings, same events — now ALSO covering design/stage tasks, closing the exploration's "cancel mid-implementing leaks the stage task and its wakeup" hole); park-lifecycle auto-abandon calls the closer before its transition (reason = the auto-abandon cancelledReason). `resolutionForParkExit`: `auto_abandoned` iff `request.to === "abandoned" && request.actorType === "system"` (drop the actor-id string comparison).

Tests: closer unit — item with live planning + design + stage tasks and open questions on two of them → all cancelled/retired/closed with events, idempotent second call no-ops; cancel mid-`implementing` → stage task cancelled + wakeup retired (NEW behavior, regression-guard the old leak); auto-abandon → same closure + park record `auto_abandoned`; a hypothetical system abandoner with a different id still records `auto_abandoned` (actor-type table). Existing cancel tests pass unmodified except any that asserted the leaked-task behavior (name them in the report). Commit (controller): `feat: unified work-closing for cancel and auto-abandon; actor-typed park resolutions`.

---

### Task 8: Web pause control, e2e arcs, roadmap

**Files:**
- Modify: `src/web/task-board/views/WorkspaceSidebar.tsx` + `BoardApp.tsx` (pause banner + pause/resume control with reason prompt; fetch via new `client.getBoardPause` / `setBoardPause` / `resumeBoard` on the request→json→parse pattern; loose parser from Task 1), `data/client.ts`, `data/parse.ts` (if not landed in T1)
- Modify: `tests/server/task-board/pipeline-e2e.test.ts` (+arcs), `orchestrator-roadmap.md` (campaign 7 lead-in → `*(shipped 2026-08-21; §8, §12)*`, nothing else)
- Test: web vitest (banner renders when paused; control dispatches; badge unaffected); the four e2e arcs

**The e2e arcs** (two engineer identities + two lanes via the established fake-CLI technique; humans only at gates):

1. **Concurrent disjoint**: two items with disjoint scopes flow to `merged` with interleaved claims on DIFFERENT engineer agents (assert both agent ids appear in runs).
2. **Overlap serializes**: two items with overlapping scopes — B's node holds (`scope-hold:` summary asserted) until A merges, then B proceeds to `merged`.
3. **Runaway stage capped**: an engineer stub that claims and never settles + a driven clock past `stageCapSeconds` → sweep suspends (node_blocked) and parks `stage_cap_exceeded` with notification; human retry resumes it to completion.
4. **Kill switch drains cleanly**: pause mid-implementation → active run suspended, a subsequent claim gets nothing (204/null), resume → item completes to `merged`.

Also assert arc 6-style withdrawal already covered by Task 6's integration (no duplicate e2e needed — note it).

**[orchestrator verify]** `npm run typecheck:all && npm run test:runtime && npm run test:web` + background `verify:full` to green. Commit (controller): `test: campaign 7 exit criteria — overlap serializes, caps catch runaways, kill switch drains`.

---

## Deferred (do not build)

Push webhook + reachable endpoint (GitHub slice); on-unpark scope re-validation (§4); provider-outage board-side park; partial-stage artifact reset; token/cost accounting; deploy-health loop; auto-scaling identities/lanes.
