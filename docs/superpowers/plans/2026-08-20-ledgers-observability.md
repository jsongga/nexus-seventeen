# Campaign 6 — Ledgers + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Park reasons become a categorized, lifecycle-managed ledger; findings become queryable by category; gates leave a durable audit record with artifact refs; the default views show stage/round/elapsed/heartbeat; raw log tails and settle text are redacted before persisting.

**Architecture:** All parks flow through the single transition choke point (`transitionWorkItemInTransaction`), which now requires a category+reason and writes/resolves `park_records`; a lifecycle sweep rides the reconciler-timer pattern and feeds a new `notifications` table behind a delivery-adapter interface. Analytics are SQL aggregates over the v21 `review_findings` table plus the new `park_records`. Gate routes write typed `gate_actions` rows. A shared redactor sits at the three raw durable-ingress seams (verify tails, check output, settle text). The C5 fix-loop latch becomes loop-active+sticky so `fixing` is trustworthy.

**Tech Stack:** Node 24 / TypeScript, SQLite single-sourced schema (v21 → v22), `node:test` runtime suite, vitest web suite, existing collaborator/transaction patterns.

**Spec:** `docs/superpowers/specs/2026-08-20-ledgers-observability-design.md` (read it; seam citations there were verified 2026-08-20 — re-grep if a line drifted).

## Global Constraints

- **Schema v22 in ONE migration** (Task 1, additive only). Contract stays single-sourced (`src/shared/task-board-contract/index.ts` → SQL CHECKs via `sqlStringList`, validators, web parsers). NEW enum arrays are fine; NEVER add members to `WORKFLOW_STAGES` / `WORK_ITEM_STATES` / `WORK_NODE_STATES` / `PLAN_REVISION_STATES` / `REVIEW_FINDING_CATEGORIES` (rebuild-migration territory, `index.ts:69-74`).
- **Every work-item state write** goes through `transitionWorkItemInTransaction`; durable writes ride `store.transaction` with side effects in `afterCommit`.
- **HTTP conventions** per `service.ts`: regex route + method guard, `noQuery` unless a route opts into explicit query parsing, named parser in `schema.ts` delegating to shared validators, `TaskBoardError` codes registered in `TASK_BOARD_ERROR_CODES`, human-vs-agent auth per route, `version` CAS guards on mutations.
- **Config knobs** follow the `boundedInteger` pattern (`config.ts:49-61`) + env in `main.ts` (`optionalInteger("STEWARD_TASK_BOARD_…")`); timer floors 60 s; `0` disables.
- **Web read parsers stay LOOSE** (tolerant enums, absent-field defaults); strict parsers only for round-trip config shapes. New list/summary fields are optional so old tabs degrade.
- **No new npm dependencies.** Inner loop `npm run verify:fast -- --base HEAD`; gate `npm run typecheck:runtime && npm run test:runtime`; web tasks also `npm run typecheck:all && npm run test:web`.
- **Exact strings are contracts**: enum members, error codes, park reasons, notification summaries — copy verbatim from this plan.
- **Sandbox note (Codex):** loopback listeners may be blocked (`listen EPERM`) — say so per test; the controller re-runs the full gate outside. Do NOT commit or touch `.git`; leave the tree dirty.
- **Spec refinement (recorded):** `GET /v1/notifications` ships WITHOUT an `?after` cursor in v1 — it returns unread (≤100, newest first) + recentRead (≤50); the dataset is small and CAS-versioned reads make cursors premature. Same §14 intent.

## File Map (created/modified per task)

| Task | Server | Contract/Schema | Web | Tests |
| --- | --- | --- | --- | --- |
| 1 schema+types | persistence/store.ts (v22) | index.ts, validate.ts | data/parse.ts projections | contract, drift (freeze v21 fixture) |
| 2 park ledger+predicate | collaborators/work-item-transitions.ts, messages.ts, runs.ts, persistence/workflow.ts, runtime.ts | transition `park` field; error codes | — | choke-point, six sites, predicate table |
| 3 lifecycle+notifications | new collaborators/notifications.ts + park-lifecycle.ts, service.ts (timer+routes), board.ts, config.ts, main.ts, schema.ts | notification types | — | sweep, dedupe, endpoints |
| 4 redaction | new shared/redact.ts; verify-attempts.ts, runs.ts | — | — | pattern table, seeded-secret integration |
| 5 gate actions+audit | persistence/workflow.ts, collaborators/work-items.ts, messages.ts, projects.ts, service.ts, board.ts | GateAction types; audit response | — | per-gate rows, audit endpoint |
| 6 ledger endpoints+list fields | new collaborators/ledgers.ts, service.ts, board.ts, work-items.ts (list subqueries) | ledger response types; WorkItem optional fields | — | aggregates, list fields |
| 7 web | — | — | routing.ts, WorkspaceSidebar.tsx, BoardApp.tsx, TaskList.tsx, WorkItemDetail.tsx, new views/LedgersPage.tsx, client.ts, parse.ts, model/*, types.ts | vitest per panel |
| 8 cleanups+exit+roadmap | rows.ts, scoped-launcher.ts, http-board-client.ts, validate.ts, workflow.ts comment | shared suffix/char constants | — | stored-v1 arc, exit-criterion integration; roadmap edit |

---

### Task 1: Schema v22 — park records, notifications, gate actions

**Files:**
- Modify: `src/shared/task-board-contract/index.ts`, `validate.ts`; `src/server/task-board/persistence/store.ts` (SCHEMA_VERSION 21 → 22, tables in base DDL + `migrateVersion21To22` via a shared `CREATE TABLE IF NOT EXISTS` block, the `REVIEW_DESIGN_SCHEMA` pattern at `store.ts:1006-1023`); `src/web/task-board/data/parse.ts` (loose projections)
- Test: `tests/shared/task-board-contract/` round-trips; `tests/server/task-board/contract-drift.test.ts` (freeze `fixtures/v21-schema.sql`, extend the `for (const version of [19, 20])` loop, add the v21→v22 replay case, CHECK-clause byte-equality for the new tables)

**Interfaces — Produces (exact names all later tasks consume):**

```typescript
export const PARK_CATEGORIES = ["open_question", "planning_run_failed", "design_run_failed", "hazardous_without_pipeline", "plan_rejected_twice", "bright_line", "scope_violation"] as const;
export const PARK_RESOLUTIONS = ["resumed", "abandoned", "auto_abandoned", "dead_letter"] as const;
export const NOTIFICATION_KINDS = ["park_aged", "park_auto_abandoned"] as const;
export const GATE_KINDS = ["plan_confirm", "plan_reject", "final_approve", "final_reject", "cancel", "question_answer"] as const;
export type ParkCategory = typeof PARK_CATEGORIES[number];
export interface ParkRecord { readonly parkRecordId: string; readonly workItemId: string; readonly category: ParkCategory; readonly reason: string; readonly parkedAt: string; readonly resolvedAt: string | null; readonly resolution: typeof PARK_RESOLUTIONS[number] | null }
export interface BoardNotification { readonly notificationId: string; readonly sequence: number; readonly kind: typeof NOTIFICATION_KINDS[number]; readonly dedupeKey: string | null; readonly projectId: string | null; readonly workItemId: string | null; readonly summary: string; readonly createdAt: string; readonly readAt: string | null; readonly version: number }
export interface GateAction { readonly gateActionId: string; readonly workItemId: string; readonly gate: typeof GATE_KINDS[number]; readonly actorId: string; readonly planRevisionId: string | null; readonly verifiedSha: string | null; readonly mergeSha: string | null; readonly refId: string | null; readonly note: string | null; readonly createdAt: string }
```

New `TASK_BOARD_ERROR_CODES` members (exact): `TASK_BOARD_PARK_RECORD_REQUIRED`, `TASK_BOARD_PARK_RECORD_INVALID`, `TASK_BOARD_NOTIFICATION_NOT_FOUND`.

**Tables** (base DDL + migration; CHECKs via `sqlStringList` on the contract arrays; all STRICT):

```sql
CREATE TABLE IF NOT EXISTS park_records (
  park_record_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN (<PARK_CATEGORIES>)),
  reason TEXT NOT NULL,
  parked_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  resolution TEXT NULL CHECK (resolution IN (<PARK_RESOLUTIONS>))
) STRICT;
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (<NOTIFICATION_KINDS>)),
  dedupe_key TEXT NULL UNIQUE,
  project_id TEXT NULL, work_item_id TEXT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL, read_at TEXT NULL,
  version INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS gate_actions (
  gate_action_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  gate TEXT NOT NULL CHECK (gate IN (<GATE_KINDS>)),
  actor_id TEXT NOT NULL,
  plan_revision_id TEXT NULL, verified_sha TEXT NULL, merge_sha TEXT NULL,
  ref_id TEXT NULL, note TEXT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

Validators: strict server parsers `parseParkRecord`, `parseBoardNotification`, `parseGateAction` (+ loose browser projections in `parse.ts` with tolerant enums → `"unrecognized"` per house pattern). Reason bounds 1..2000; summary 1..500; note ≤2000; shas exactly 40 hex when present.

Steps: failing contract tests (round-trip each type; reject unknown category/kind/gate, oversize reason, malformed sha; migration replay v21→v22 preserves rows; fresh DDL byte-matches frozen v21 fixture after projection) → implement → pass → gate. Commit (controller): `feat: park records, notifications, gate actions (schema v22)`.

---

### Task 2: Park choke point, six park sites, fix-loop predicate

**Files:**
- Modify: `src/server/task-board/collaborators/work-item-transitions.ts` (choke point + predicate), `collaborators/messages.ts:86` (P1), `collaborators/runs.ts:867-887` (P2, P3), `persistence/workflow.ts:761-772, :841-860, :1523-1541` (P4, P5, P6), `collaborators/runtime.ts:249, :341` (predicate call sites), `persistence/workflow.ts:1040, :1662` (predicate call sites), contract `index.ts` (transition request field)
- Test: `tests/server/task-board/work-item-transitions.test.ts` + integration files where each park already has coverage

**Interfaces — Produces:**

```typescript
// transition request (contract + work-item-transitions.ts):
park?: { readonly category: ParkCategory; readonly reason: string };
// required iff to === "parked" (else throw TASK_BOARD_PARK_RECORD_REQUIRED);
// present on any other target → throw TASK_BOARD_PARK_RECORD_INVALID.
// work-item-transitions.ts:
export function workItemStateForNodeStage(db, nodeId, stage, currentState: WorkItemState | null): WorkItemState;
```

**Behavior:**

- Choke point: on `to === "parked"`, validate `park` (category member, reason 1..2000), insert `park_records` (id `randomUUID()`, `parked_at = now`) in the same transaction. On any transition whose `fromState === "parked"`, close the newest open record: `resolution` = target `abandoned` && actor id `system:park-lifecycle` → `auto_abandoned`; target `abandoned` otherwise → `abandoned`; target `dead_letter` → `dead_letter`; else `resumed`; `resolved_at = now`. No open record (pre-campaign parks) → no-op.
- Six sites pass their category + the reason string they already produce: P1 `open_question` (reason = the question, messages.ts); P2 `planning_run_failed` / P3 `design_run_failed` (reason = the run result or `"planning run failed"` / `"design run failed"` when empty); P4 `hazardous_without_pipeline` (reason = `hazardous tier requires a pipeline plan`); P5 `plan_rejected_twice` (reason = `plan rejected twice — request unclear`); P6 `bright_line` when the detail starts `BRIGHT_LINE:`, else `scope_violation` (reason = the detail, pre-truncated 2000).
- **Fix-loop predicate** replaces the latch (`work-item-transitions.ts:44-52`): `fixing` iff `stage === "implementation"` AND ( currentState === "fixing" /* sticky */ OR loopActive ), where loopActive = both non-null and equal of `SELECT MAX(round) FROM review_findings WHERE node_id=? AND blocking=1` and `SELECT MAX(attempt) FROM stage_attempts WHERE node_id=? AND stage='verification'`. All four call sites pass the item's current state (they hold the row). `rejectFinalApprovalInTransaction` keeps its explicit `fixing` target (stickiness then holds it).

Tests: choke-point table (park without field throws; field on non-park throws; resolution derivation ×4); each of the six sites integration-asserts its `park_records` row (category + reason verbatim); predicate truth table (loop active during round-1 fix → `fixing`; after clean round-2 review, unpark/retry → `implementing`; sticky: state `fixing` + implementation write stays `fixing`; final-reject → `fixing` then stays); C5 mixed-history test still passes (fix context untouched). Commit (controller): `feat: categorized park ledger at the transition choke point; round-scoped fix-loop predicate`.

---

### Task 3: Park lifecycle sweep + notifications

**Files:**
- Create: `src/server/task-board/collaborators/notifications.ts`, `src/server/task-board/collaborators/park-lifecycle.ts`
- Modify: `config.ts` (+`parkNotifySeconds` default 86_400, +`parkAutoAbandonSeconds` default 604_800; both 0-disables, floor 60 when non-zero, abandon ≥ notify when both non-zero else throw at normalize), `main.ts` (env `STEWARD_TASK_BOARD_PARK_NOTIFY_SECONDS`, `STEWARD_TASK_BOARD_PARK_AUTO_ABANDON_SECONDS`), `service.ts` (timer beside the verify sweep, same interval resolution + `.unref()` + cleared in `close()`; routes), `board.ts`, `schema.ts`
- Test: unit sweep with injected clock; endpoint integration

**Interfaces — Produces:**

```typescript
// notifications.ts:
export interface NotificationDeliveryAdapter { deliver(notification: BoardNotification): void } // in_app adapter = no-op (the row is the delivery)
insertNotificationInTransaction(input: { kind; dedupeKey: string | null; projectId; workItemId; summary }): BoardNotification | null; // null when dedupe_key already exists (INSERT OR IGNORE + changes check)
listNotifications(): { unread: BoardNotification[]; recentRead: BoardNotification[] };   // unread ≤100 newest first; recentRead ≤50
markNotificationRead(notificationId, version): BoardNotification;                          // CAS on version else 409; 404 TASK_BOARD_NOTIFICATION_NOT_FOUND
// park-lifecycle.ts:
sweepParkLifecycle(now: string): { notified: number; autoAbandoned: number };
```

**Behavior:**

- Sweep (called from the new timer): open `park_records` older than `parkNotifySeconds` → notification `{ kind: "park_aged", dedupeKey: "park_aged:" + parkRecordId, summary: "Work item parked ${humanAge} (${category}): ${reason.slice(0,200)}" }`; older than `parkAutoAbandonSeconds` → per-item transaction re-checking `state === 'parked'`, then `transitionWorkItemInTransaction` to `abandoned` (actor `{type:"system", id:"system:park-lifecycle"}`, `cancelledReason` = `parked past auto-abandon threshold (${category})`, `endedAt`) — the Task 2 choke point resolves the record `auto_abandoned` — plus notification kind `park_auto_abandoned` (dedupe `park_auto_abandoned:` + parkRecordId). Open questions do NOT block auto-abandon (an unanswered question aging past the threshold is exactly the case). Threshold disabled (0) → that half skipped.
- Routes (human): `GET /v1/notifications` (no query) → `listNotifications()`; `POST /v1/notifications/:id/read` body `{ version }`.

Tests: clock-driven unit — record younger than notify → nothing; older → exactly one notification (second sweep dedupes); older than abandon → item abandoned + record `auto_abandoned` + second notification; item already un-parked between sweeps → no-op; knobs 0 disable each half; config validation throws when abandon < notify (both non-zero). Endpoint integration: list shape; read CAS bumps version + sets readAt; wrong version 409; unknown id 404. Commit (controller): `feat: park lifecycle sweep with in-app notifications`.

---

### Task 4: Redact before persisting

**Files:**
- Create: `src/server/shared/redact.ts`
- Modify: `src/server/shared/safe-error-detail.ts` (delegate its pattern pass to redact.ts — one vocabulary), `src/server/task-board/collaborators/verify-attempts.ts` (`errorDetail` :81-84, tail path :452-458, `#runChecks` failure details :501-511, `#finalize` detail write :540-549), `src/server/task-board/collaborators/runs.ts` (settle persistence of `runs.result` :809-812 and `tasks.result` :826-831), `work-item-transitions.ts` (park reason passes through the redactor before insert)
- Test: `tests/server/shared/redact.test.ts` pattern table; seeded-secret integration in `tests/server/task-board/verify-attempts.test.ts`

**Interfaces — Produces:**

```typescript
export function redactForPersistence(value: string, maxLength?: number): string;
// applies the safe-error-detail pattern set (PEM blocks, Bearer …, sk-/sk-ant-/github_pat_/gh[pousr]_/glpat-/npm_/xox[a-z]-/AKIA…, https://user:pass@host, control chars),
// each match → "[redacted:<kind>]" (kinds: key|token|bearer|pem|url-credential); strips control chars; optional trailing truncation.
```

**Behavior:** apply at exactly the ingress seams above — verify tails/check output before `verify_attempts.detail`/`check_results_json` AND before the same text enters `MachineVerifyEvidence` (so `stage_handoffs` + `project_events` inherit clean text); agent settle `result` before `runs.result`/`tasks.result`; park reasons at the choke point. Review findings `expected`/`actual` pass through the redactor in the settle path (workflow.ts findings insert). Display paths untouched. A doc comment states the limitation verbatim: `Pattern-based only — a secret in an unrecognized format persists. Entropy scanning is out of scope (spec §Redact).`

Tests: pattern table (each kind redacts; benign text with "token" as a word survives; 4 KiB tail with an embedded `sk-ant-` key persists with the marker in verify_attempts AND the stage handoff AND the project event summary — one integration arc); settle result with a Bearer header redacted in runs.result and tasks.result. Commit (controller): `feat: shared persistence redactor at verify, settle, and park ingress`.

---

### Task 5: Gate actions + audit endpoint

**Files:**
- Modify: `src/server/task-board/persistence/workflow.ts` (confirm :741-809, reject :833-852, approve-merge settlement :899-915, reject-final :939-1000 incl. the `task_events` actor fix `system:final-approval` → human principal), `collaborators/work-items.ts` (cancel :528-551), `collaborators/messages.ts` (answer :115-119), `collaborators/projects.ts` (approve context carries `verifiedSha` — it already computes it at :451-463; thread it to the settlement write), `service.ts` (+`GET /v1/work-items/:id/audit`), `board.ts`, `schema.ts`, contract (audit response type)
- Test: per-gate integration rows; audit endpoint

**Interfaces — Produces:**

```typescript
insertGateActionInTransaction(input: Omit<GateAction, "gateActionId" | "createdAt">): GateAction;
// GET /v1/work-items/:id/audit (human) →
export interface WorkItemAudit { readonly gateActions: readonly GateAction[]; readonly transitions: readonly WorkItemTransition[] }
```

**Behavior:** each human gate route writes its row in the SAME transaction as its state change, `actorId = config.humanPrincipal`: `plan_confirm` {planRevisionId, refId: String(revision)}; `plan_reject` {planRevisionId, note}; `final_approve` {planRevisionId (confirmed revision), verifiedSha (the value approve already validates), mergeSha (from the merge result)}; `final_reject` {planRevisionId, note}; `cancel` {note: cancelledReason}; `question_answer` {refId: questionId}. Audit endpoint returns gate actions (created_at asc) + the existing transition history.

Tests: one integration per gate asserting the row's exact fields (approve case asserts verifiedSha === the branch tip and mergeSha === the merge commit); reject-final's `task_events` row now carries `actor_type='human', actor_id=humanPrincipal`; audit endpoint over a full confirm→approve cycle returns 2+ actions in order. Commit (controller): `feat: durable gate actions and the work-item audit endpoint`.

---

### Task 6: Ledger endpoints + list-row observability fields

**Files:**
- Create: `src/server/task-board/collaborators/ledgers.ts`
- Modify: `service.ts` (+`GET /v1/ledgers/findings` with explicit optional `?projectId=` parsing, +`GET /v1/ledgers/parks`, no other params), `board.ts`, `schema.ts`, `collaborators/work-items.ts` (`listWorkItemsPage` :54-92 row subqueries), contract `index.ts` + `validate.ts` (response types; `WorkItem` gains OPTIONAL `stateSince?: string | null; reviewRound?: number | null; heartbeatAt?: string | null`)
- Test: aggregates over seeded data; list fields

**Interfaces — Produces:**

```typescript
export interface FindingsLedger {
  readonly categories: readonly { category: ReviewFindingCategory; severity: ReviewFindingSeverity; blocking: boolean; count: number }[];
  readonly perProject: readonly { projectId: string; category: ReviewFindingCategory; count: number }[];
  readonly recent: readonly (ReviewFinding & { workItemId: string })[];  // ≤50 newest
}
export interface ParksLedger {
  readonly open: readonly (ParkRecord & { workItemTitle: string })[];       // age-desc
  readonly resolved: readonly (ParkRecord & { workItemTitle: string })[];   // ≤100 newest
  readonly recordsSince: string;   // "2026-08-20" — honest empty-history marker
}
```

**Behavior:** findings aggregates join `review_findings → work_nodes → plan_revisions → work_items` (the C5 per-item join, unfiltered) with `GROUP BY category, severity, blocking` and per-project rollup; `?projectId=` filters both. Parks ledger reads `park_records` + a title projection (the item's refined objective/original request slice the list view already uses). List rows: three per-row subqueries — `stateSince` = `MAX(created_at) FROM work_item_transitions WHERE work_item_id=?`; `reviewRound` = `MAX(attempt) FROM stage_attempts JOIN work_nodes… WHERE stage='verification'` for the item's confirmed plan (null when none); `heartbeatAt` = active run's `COALESCE(heartbeat_at, started_at)` via the item's tasks (null when no active run). Loose web parse tolerates absence.

Tests: seed two projects × two categories × blocking mix → exact group counts, projectId filter; parks ledger open/resolved split + ordering; list rows carry the three fields (and null cases); old-payload parse (fields absent) still round-trips. Commit (controller): `feat: findings and park ledger endpoints; observability fields on work-item lists`.

---

### Task 7: Web — Ledgers page, notifications, default view, audit section

**Files:**
- Create: `src/web/task-board/views/LedgersPage.tsx`
- Modify: `routing/routing.ts` (union member `ledgers`: `acceptsSegmentCount`, `pageToHash`, `hashToPage`), `views/WorkspaceSidebar.tsx` (nav row + unread-notifications badge + parked/final_approval counts on the work-items row), `BoardApp.tsx` (page wiring + notifications block above the task list), `views/TaskList.tsx` (`WorkItemRow` stage pill, `in <state> for <duration>`, `round N` badge, heartbeat dot: green < 90 s, amber ≥ 90 s, none when null), `views/WorkItemDetail.tsx` (`StatusTimeline` → real per-transition rows with actor + elapsed-in-state + total; new `AuditSection` table), `data/client.ts` (+`getFindingsLedger`, `getParksLedger`, `getNotifications`, `markNotificationRead`, `getWorkItemAudit`), `data/parse.ts` (loose parsers), `model/` + `types.ts` (`BoardRun.heartbeatAt` finally carried; ms projections)
- Test: vitest — ledgers tables, notifications block + mark-read dispatch, sidebar badges, row badges incl. null cases, timeline rows + elapsed math, audit section

**Behavior:** Ledgers page = two sections (findings by category with severity split and expandable recent findings linking to work items; park ledger with ages, resolutions, and the `recordsSince` notice `Park records begin ${recordsSince}; older parks have no ledger entry.`). Notifications block lists unread with a mark-read button; sidebar badge = unread count; work-items nav row shows `parked` / `final_approval` counts from the snapshot. Timeline derives durations client-side from `createdAtMs` deltas (data already parsed at `parse.ts:185`). All new fetches follow the `client.ts` request→json→parse envelope pattern; renders tolerate empty datasets with explicit empty states.

Tests: per-panel per the existing WorkItem*.test.ts convention (render-function technique); parser round-trips fields present/absent. Gates: `npm run typecheck:all && npm run test:web` plus runtime suite untouched-green. Commit (controller): `feat: ledgers page, notifications, and the default observability view`.

---

### Task 8: Cleanups, exit-criterion integration, roadmap

**Files:**
- Modify: `src/server/task-board/persistence/rows.ts` (+ single `reviewFindingFromRow`; delete copies in `projects.ts:62-77` and `workflow.ts:178-192`), contract `index.ts` (+`REVIEW_WORKSPACE_SUFFIX = "-review"`, `VERIFY_WORKSPACE_SUFFIX = "-verify"`; consume at `workflow.ts:674`, `scoped-launcher.ts:16-17`, `validate.ts:2094/:2122/:2140`, `verify-attempts.ts:583/:591`), single-source `MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS` + `MAX_AREA_MEMORY_RESULT_CHARACTERS` in the contract (consume from `http-board-client.ts:34-35` and `validate.ts:1935/:1938`), `scoped-launcher.ts` guard → `request.context.workflow?.workspaceKey?.endsWith(REVIEW_WORKSPACE_SUFFIX) === true` (taskId fallback never triggers review semantics), `persistence/workflow.ts` (comment at the `failedReview` gate: `// failed + needs_input handoffs bypass FINDINGS_REQUIRED by design: a findings-less retry lane; revisit if it is abused (C5 final review, minor 5)`), `orchestrator-roadmap.md` (campaign 6 lead-in → `*(shipped 2026-08-20; §13; item 6)*`)
- Test: new stored-v1 integration case — seed a CONFIRMED v1 (`["implementation","testing"]`) pipeline item (insert the plan pre-confirmed via the store, bypassing propose-time v2 validation exactly as legacy data would exist), drive machine verify green via the sweep → assert `final_approval`; **exit-criterion integration** — seed findings in ≥2 categories across 2 items + 2 parks in different categories, assert `GET /v1/ledgers/findings` groups match and `GET /v1/ledgers/parks` lists both with categories and reasons
- **[orchestrator verify]** `npm run typecheck:all && npm run test:runtime && npm run test:web` and a background `verify:full` to green

Steps: cleanups (behavior-neutral — full suite must stay green UNMODIFIED except the new tests), stored-v1 case, exit-criterion case, roadmap edit. Commit (controller): `test: campaign 6 exit criterion — ledgers queryable; C5 cleanup batch`.

---

## Deferred (do not build)

Per-human identity/multi-operator auth; findings time windows + category→action workflows; task-list state-filter UI; transcript-in-detail view; email/Slack notification adapters; park-record backfill; entropy secret scanning + PR diff scan (GitHub slice); scheduling/budget caps and their notification kinds (C7).
