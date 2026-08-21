# Orchestrator campaign 6 — Ledgers + observability

Status: Drafted autonomously per operator "continue" (2026-08-20); decisions
follow campaign precedent (local-first, ride existing machinery, honest
about limits); open for review
Author: Claude, from `orchestrator-design.md` §13/§14/§4-Parked and
`orchestrator-roadmap.md` campaign 6
Date: 2026-08-20
Scope: a categorized park ledger with lifecycle (age → notify →
auto-abandon), findings-category analytics, in-app notifications, the
default observability view (stage / round / elapsed / heartbeat), a durable
gate-action audit record, and redact-before-persisting at the real ingress
seams — plus the campaign-5 fix-loop-predicate correction this campaign was
told to land first

## Summary

Campaign 5 finished the autonomous middle; campaign 6 makes it observable
and self-improving. §13's thesis: after ~20 tasks, recurring finding
categories and park reasons are each a missing lint rule, prohibition,
convention, or fixture — but only if they are queryable. Today they are
not: parks store no reason anywhere structural (six park sites scatter
prose across three sibling tables), findings have a table but zero
aggregate queries, elapsed time and heartbeats reach the browser and are
discarded one projection short of the UI, approvals never persist the
artifact they approved, and notifications do not exist at all.

Everything rides shipped machinery: park records write through the single
transition choke point, the lifecycle sweep rides the reconciler timer
pattern, analytics are SQL aggregates over the v21 findings table, and the
default view is mostly rendering data the web already parses and drops.

**Honest limits stated up front:** human identity is one shared token and
one `humanPrincipal` string — the audit view answers "a human approved, at
time T, against artifact V", not *which* human (multi-operator is out of
scope by design). Redaction is pattern-based (the existing
`safe-error-detail` vocabulary), not entropy-based secret detection.

## What exists / what changes

| Piece | Today | This campaign |
| --- | --- | --- |
| Park reason | Prose scattered over `tasks.result` / `project_events.summary` / `stage_handoffs.payload_json`; nothing on the park itself (`work-item-transitions.ts:118-120` even throws on a reason for non-abandoned targets) | `park_records` table written at the transition choke point; category REQUIRED at every park site |
| Park lifecycle | No age, no notify, no auto-abandon; no unpark endpoint (four incidental unpark paths) | Aged sweep on the reconciler timer: notify once at threshold, auto-abandon at threshold; records resolved on every exit from `parked` |
| Notifications | Nothing (grep-empty) | `notifications` table + delivery-adapter interface (in-app adapter only), unread badge, mark-read |
| Findings queryability | v21 table + per-item lists only; no GROUP BY anywhere | `GET /v1/ledgers/findings` category×severity aggregates + recent drill; Ledgers page |
| Default view | `StatusTimeline` is a static 4-step ribbon; `transitions` parsed & unused; `heartbeatAt` dropped at `BoardRun` (`types.ts:269-284`); round count only inside the findings panel | List rows gain stage / in-state-since / round / heartbeat; detail timeline renders real per-stage elapsed from the transitions it already has |
| Audit | Three substrates, none complete: verified sha checked but never persisted (`projects.ts:451-463`), reject-final attributed to `system:final-approval` (`workflow.ts:995-1000`) | `gate_actions` table written at every human gate with artifact refs; audit section on the detail page; reject-final actor corrected |
| Redaction | `safeErrorDetail` used only for worker/lane error strings; verify log tails, criterion-check stdout, and settle text persist raw | One shared redactor applied at those three durable ingress seams |
| Fix-loop predicate | Permanent latch: any historical blocking finding maps `implementation → fixing` forever (`work-item-transitions.ts:44-52`) | Loop-active + sticky semantics (below); analytics can trust `fixing` |

## Park ledger

**One writer seam.** `transitionWorkItemInTransaction` gains an optional
`park?: { category: ParkCategory; reason: string }` field, **required when
`to === "parked"`** (throw `WORK_ITEM_PARK_RECORD_REQUIRED` otherwise) and
rejected for any other target — no future park site can forget. In the same
transaction it inserts a `park_records` row. Every transition **out of**
`parked` closes the open record: `resolved_at` set, `resolution` derived —
`abandoned` target with actor `system:park-lifecycle` → `auto_abandoned`;
other `abandoned` → `abandoned`; `dead_letter` → `dead_letter`; anything
else → `resumed`.

**Categories are the honest vocabulary of the six real park sites** (new
contract enum `PARK_CATEGORIES`, CHECK-backed):
`open_question` (messages.ts human-question park), `planning_run_failed`,
`design_run_failed` (runs.ts non-completed planning/design settles),
`hazardous_without_pipeline`, `plan_rejected_twice` (confirm/reject paths),
`bright_line`, `scope_violation` (the two `parkAttempt` branches —
dispatched by the existing `BRIGHT_LINE:` prefix vs scope detail). Reason =
the same string each site already produces, bounded 1..2000, redacted
(below). No category `other`: an unknown park is a bug, not a bucket.
Pre-campaign parks (including v19-migrated ones) get no backfill — records
begin now, stated plainly in the ledger view.

## Park lifecycle + notifications

Config knobs in the established shape (`config.ts` boundedInteger + env in
`main.ts`): `parkNotifySeconds` (default 86 400 = 1 day),
`parkAutoAbandonSeconds` (default 604 800 = 7 days); `0` disables each;
auto-abandon must be ≥ notify when both are on (validated).

**The sweep** rides the reconciler-timer pattern (own interval like the
verify sweep, floor 60 s, never silently disabled): for each open
`park_records` row past `parkNotifySeconds`, insert ONE notification
(dedup: `notifications.dedupe_key = 'park_aged:' + park_record_id` UNIQUE);
past `parkAutoAbandonSeconds`, transition `parked → abandoned` (actor
`system:park-lifecycle`, `cancelledReason` = `parked past auto-abandon
threshold (<category>)`, endedAt set) — the transition choke point resolves
the record `auto_abandoned` — plus a second notification
(`park_auto_abandoned:` key). Races are benign: the sweep re-checks state
inside each item's transaction, same as the stale-run sweep.

**Notifications are records with a delivery adapter** (§14 verbatim): a
`NotificationDeliveryAdapter` interface whose only implementation is
`in_app` (the row itself is the delivery); adding email/Slack later is one
adapter, no schema change. Kinds enum: `park_aged | park_auto_abandoned`
(more arrive with campaign 7's caps). Endpoints (human):
`GET /v1/notifications?after=<seq>` (paged, unread-first) and
`POST /v1/notifications/:id/read { version }`. Web: unread-count badge in
the sidebar; a compact notifications block at the top of the Task List page
with mark-read.

**Badge counts** (§14): the sidebar work-items nav row shows live `parked`
and `final_approval` counts derived from the snapshot — no server change.

## Findings analytics + the Ledgers page

`GET /v1/ledgers/findings` (human; explicit query opt-in per the `noQuery`
convention): `{ categories: { category, severity, blocking, count }[]
grouped across all work items, perProject: { projectId, category, count }[],
recent: ReviewFinding[] (bounded 50, newest first, each with workItemId
resolved via the node→plan→item join) }`. Optional `?projectId=` filter.
No time-window parameter in v1 — the dataset is young; add windows when the
data demands them.

`GET /v1/ledgers/parks` (human): open parks first (with age), then resolved
(bounded 100), each row: category, reason, parked/resolved timestamps,
resolution, work item id + title projection.

**Web: one new `#/ledgers` page** (routing union + hash cases + sidebar nav
row — the established ~5-site change) with two sections: findings by
category (count table; severity split; each category expandable to its
recent findings with work-item links) and the park ledger (age-sorted open
parks, resolution history). This page is the campaign's exit criterion made
visible: recurring categories queryable, park reasons reviewable.

## The default view (§13: stage, round count, elapsed, heartbeat)

- **List rows**: the work-item list SQL gains three cheap per-row
  subqueries returned as new optional fields — `stateSince` (latest
  transition `created_at`), `reviewRound` (`MAX(stage_attempts.attempt)`
  for the item's verification stage, null when none), `heartbeatAt` (the
  item's tasks' active run's heartbeat, null when none). `WorkItemRow`
  renders: current stage pill, "in <state> for <duration>", a `round N`
  badge when non-null, and a liveness dot (green <2× heartbeat cadence,
  amber older, none when no active run).
- **Detail timeline**: `StatusTimeline` upgrades from the static ribbon to
  the real transition history the page already parses — one row per
  transition with state, actor, and elapsed-in-state; total elapsed at the
  top. Transcript stays one click away (unchanged) — §13's "watching an
  agent work pulls you back into supervising" rule is honored by showing
  aggregates, not streams.
- `BoardRun` finally carries `heartbeatAt` (it survives the wire today and
  is dropped in one projection).

## Audit: gate actions

New `gate_actions` table (v22), written in-transaction at each human gate
route:

| gate | artifact refs recorded |
| --- | --- |
| `plan_confirm` | planRevisionId + revision number |
| `plan_reject` | planRevisionId + note |
| `final_approve` | planRevisionId, verifiedSha (the value `approvePipelineMerge` already checks and then discards), mergeSha |
| `final_reject` | planRevisionId, note |
| `cancel` | note (cancelledReason) |
| `question_answer` | questionId |

Columns: `gate_action_id, work_item_id, gate (CHECK enum), actor_id,
plan_revision_id NULL, verified_sha NULL, merge_sha NULL, ref_id NULL,
note NULL, created_at`. Actor is the configured `humanPrincipal` — the
honest limit above. Correctness fix folded in: `rejectFinalApprovalInTransaction`'s
`task_events` row switches from `system:final-approval` to the human
principal (the transition row already says human; the event should agree).

`GET /v1/work-items/:id/audit` (human) returns the gate actions plus the
transition history; web renders an "Audit" section on the work-item detail
page (who/when/what table, artifact refs abbreviated, monospace shas).

## Redact before persisting

One shared `redactForPersistence(text: string): string` in
`src/server/shared/` — the existing `safeErrorDetail` pattern vocabulary
(PEM blocks, `Bearer …`, `sk-`/`sk-ant-`/`github_pat_`/`gh*_`/`glpat-`/
`npm_`/`xox*`/`AKIA…` tokens, `https://user:pass@`, control chars) applied
without the error-shape wrapper, each match replaced by a typed marker
(`[redacted:<kind>]`). Applied at the three durable ingress seams the
exploration found actually raw:

1. Verify log tails and start-failure details before
   `verify_attempts.detail` (`verify-attempts.ts` `errorDetail`/tail path —
   which today is a bare `.slice(4000)`), and the same text before it fans
   into `stage_handoffs` evidence and `project_events` summaries.
2. Criterion-check stdout/stderr before `check_results_json` and failure
   summaries.
3. Agent settle text (`runs.result` / `tasks.result`) and park reasons at
   their persistence sites.

Not applied at display time (§13: redact before persisting, not before
display). Review findings `expected`/`actual` pass through the same
redactor at settle. Documented limitation in code comment: pattern-based,
no entropy scanning — a secret in an unrecognized format persists.

## Fix-loop predicate correction (campaign-5 debt, load-bearing for ledgers)

The C5 predicate is a permanent latch (`SELECT 1 FROM review_findings WHERE
node_id=? AND blocking=1`): any node that ever had a blocking finding maps
`implementation → fixing` forever, so the ledger/analytics views could not
trust `fixing`. New semantics, one helper, all four call sites:

- **Loop-active**: `MAX(round of blocking findings) == COUNT of
  verification attempts` — true from a blocking review until a later review
  round settles (the C5 fix-context query already round-scopes this way;
  the state predicate now agrees with it).
- **Sticky**: when the item's current state IS `fixing`, implementation-
  stage writes keep it `fixing` (exit is `fixing → verifying` on stage
  advance, or terminal — never a sideways write; this also avoids the
  illegal `fixing → implementing` edge).
- `rejectFinalApprovalInTransaction` keeps sending the item to `fixing`
  explicitly (§4: "Reject → back to Fix"), which then holds via stickiness.

Behavioral change from C5: an unpark/retry long after a *resolved* fix loop
now maps `implementing`, not `fixing`. The C5 mixed-history test's fix-round
context assertions are unchanged.

## Cleanups folded in (from the C5 final review, all small)

`reviewFindingFromRow` deduplicated into `persistence/rows.ts`; the
`-review` / `-verify` workspace-suffix literals become shared contract
constants; `MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS` and
`MAX_AREA_MEMORY_RESULT_CHARACTERS` single-sourced from the contract; the
scoped-launcher `-review` guard tests `workflow?.workspaceKey` (not the
taskId fallback); one integration test drives a stored-v1 pipeline item
through green verify to `final_approval`; a comment (not a gate) documents
the `failed`+`needs_input` findings-less retry lane.

## Storage (schema v22 — additive, no enum-array changes)

```sql
CREATE TABLE park_records (
  park_record_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  category TEXT NOT NULL CHECK (category IN (<PARK_CATEGORIES>)),
  reason TEXT NOT NULL,
  parked_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  resolution TEXT NULL CHECK (resolution IN ('resumed','abandoned','auto_abandoned','dead_letter'))
);
CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,          -- monotonic, for ?after paging
  kind TEXT NOT NULL CHECK (kind IN (<NOTIFICATION_KINDS>)),
  dedupe_key TEXT NULL UNIQUE,
  project_id TEXT NULL, work_item_id TEXT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL, read_at TEXT NULL, version INTEGER NOT NULL
);
CREATE TABLE gate_actions (
  gate_action_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  gate TEXT NOT NULL CHECK (gate IN (<GATE_KINDS>)),
  actor_id TEXT NOT NULL,
  plan_revision_id TEXT NULL, verified_sha TEXT NULL, merge_sha TEXT NULL,
  ref_id TEXT NULL, note TEXT NULL,
  created_at TEXT NOT NULL
);
```

Contract types + enums single-sourced; migration ladder v21→v22 +
`fixtures/v21-schema.sql` freeze + drift-test loop extension, per the
established pattern.

## Error handling

- Park without category/reason at the choke point → throw (programming
  error, surfaces in tests, never ships silent).
- Lifecycle sweep failures are logged and retried next tick; a failed
  auto-abandon leaves the park open (no partial resolution — one
  transaction per item).
- Notification insert races resolve via the UNIQUE dedupe key (INSERT OR
  IGNORE).
- Ledger endpoints are read-only; empty datasets render as honest empty
  states, including "park records begin 2026-08-20; older parks have no
  ledger entry".
- All writes ride `transitionWorkItemInTransaction` / store transactions
  with after-commit events, per house rules.

## Testing

- Unit: park-record choke-point rules (required/forbidden/resolution
  derivation); category dispatch per park site; lifecycle sweep thresholds
  incl. dedupe and disable knobs; redactor pattern table; loop-active +
  sticky predicate truth table; gate-action rows per route; list-row
  subquery fields.
- Integration: park → age → notification → auto-abandon end to end on a
  driven clock (injectable now, per house pattern); findings/parks ledger
  endpoints over seeded multi-item data; audit endpoint after a full
  confirm→approve cycle records revision + verified sha + merge sha; a
  verify failure with a seeded fake secret in the log tail persists
  redacted everywhere (verify_attempts, handoff, event).
- Web (vitest): ledgers page tables, notifications block + badge,
  list-row badges, upgraded timeline, audit section; loose-parser
  round-trips with fields present and absent.
- **Exit-criterion check**: seed three work items producing findings in two
  categories and two parks in different categories; the ledgers endpoints
  group them correctly and the page renders both ledgers — categories
  queryable, park reasons reviewable.

## Amendments (ruled during implementation, 2026-08-20/21)

- `GET /v1/notifications` ships without the `?after` cursor: it returns
  unread (≤100, newest first) plus recentRead (≤50). The dataset is small
  and CAS-versioned reads make cursors premature; same §14 intent.
- The redact-before-persisting class was extended during review to every
  human- and agent-authored free-text ingress it logically contains:
  handoff prose, cancellation reasons across all five fan-out writes,
  plan-rejection notes (column and objective copies), final-reject notes
  and merge-conflict summaries, agent question text, and human answers.
  Benign text is byte-identical through the redactor, so the extension
  costs nothing on clean input.
- The fix-loop predicate's sticky rule also consults the state held at
  park time (via transition history), so a `fixing` item that parks on a
  question resumes as `fixing`.

## Deferred (recorded, not decided)

- Per-human identity (multi-operator auth) — out of scope by design §12;
  the audit records the shared principal.
- Findings-ledger time windows and category→action workflows ("convert to
  lint rule") — after real data accumulates.
- Task-list state-filter UI and transcript-in-detail (virtualized,
  collapsed tool calls) — §14 items not in the campaign-6 roadmap line.
- Notification delivery adapters beyond in-app (email/Slack) — one adapter
  each, later.
- Park-record backfill for pre-campaign parks.
- Entropy-based secret scanning; diff secret-scan before PR creation (§12,
  arrives with the GitHub slice).

## Alternatives considered

- **Park reasons on `work_item_transitions` columns** instead of a table —
  rejected: transitions are an append-only spine shared by every state
  change; park lifecycle needs mutable resolution fields and its own query
  shape, and a sparse column pair on every transition row is drift bait.
- **Deriving park categories by parsing existing prose** at read time —
  rejected: three tables, six formats, and any new park site silently
  becomes "uncategorized"; a required field at the choke point is the only
  arrangement that cannot rot.
- **A generic `audit_events` merged with `task_events`** — rejected:
  task_events is task-scoped and system-heavy; gate actions are work-item
  scoped, human-authored, and few — a small dedicated table keeps the audit
  query trivial and the artifact refs typed.
- **Auto-abandon via `cancelWorkItem`** (reusing the cancel route's
  machinery) — rejected: cancel is a human action with human attribution;
  the sweep writes its own system-actor transition through the same choke
  point instead.
- **Redacting at display time** — rejected explicitly by §13; secrets in
  the DB are already an incident.
- **Keeping the C5 fixLoop latch and making only analytics round-aware** —
  rejected: two disagreeing definitions of "fixing" is exactly the drift
  §13's ledger exists to catch; fixing the predicate once keeps state and
  analytics telling the same story.
