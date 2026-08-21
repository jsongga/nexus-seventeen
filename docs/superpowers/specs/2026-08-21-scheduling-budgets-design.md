# Orchestrator campaign 7 — Scheduling + budgets

Status: Drafted autonomously per operator "continue" (2026-08-21); decisions
follow campaign precedent (local-first, ride existing machinery, honest
about limits); open for review
Author: Claude, from `orchestrator-design.md` §8/§12/§4 and
`orchestrator-roadmap.md` campaign 7
Date: 2026-08-21
Scope: scope-overlap gating replacing the serial guard (concurrency > 1
becomes real), per-stage and per-task wall-clock caps, a kill switch that
drains and stops in-flight work without stranding it, and withdrawal of a
pending final approval when the base moves (local-first polling — the
webhook stays with the GitHub slice)

## Summary

Campaign 4 serialized pipelines with a project-wide 409 at confirm; §8 wants
overlap-scoped gating at the start of work instead, so disjoint tasks run in
parallel and only genuinely overlapping ones wait. §12 wants runaway work
caught by wall-clock caps (a looping agent is indistinguishable from a
working one except by elapsed time) and a kill switch that drains cleanly.
§4 wants a pending final approval withdrawn when the base branch moves.

The exploration surfaced three traps this design is built around:

- **An interrupted settle strands the node** (`stage_failed`-blocked, never
  reconciled) **and burns an attempt toward dead letter.** A kill switch or
  cap sweep built naively on the stale-run pattern would dead-letter healthy
  work. This campaign adds a *suspend* settle variant that parks the run's
  node as reconciler-resumable and skips attempt accounting.
- **The serial guard was never the real concurrency ceiling.** Agent
  resolution always picks the oldest identity (`ORDER BY created_at LIMIT
  1`), one active run per agent is DB-enforced, and the fleet runs one lane
  per identity. Removing the guard without idle-preferred agent selection
  changes nothing.
- **There is no default-branch concept.** Base sha is read once as `HEAD`
  at confirm and never re-checked until merge. "Base moved" has to be
  defined; the merge executor's valid-target rules are the honest
  definition, and the poller no-ops when the repo isn't on a valid target.

**Honest limits:** withdrawal is polling on the reconcile cadence, not a
webhook (webhook = GitHub slice); concurrency > 1 requires the operator to
add engineer identities and fleet lanes (the board schedules across
whatever exists); caps park — humans resolve parks, as designed.

## What exists / what changes

| Piece | Today | This campaign |
| --- | --- | --- |
| Serialization | Project-wide 409 at confirm (`assertPipelineSerialAvailability`, workflow.ts:248-265), `parked` included — one parked item freezes the project | REMOVED; scope-overlap hold at node activation; disjoint items proceed |
| Agent pick | Oldest identity always (`projects.ts:680-687`) | Idle-preferred within role; falls back to oldest when all busy |
| Multiple managers | `createLazyManagerInTransaction` returns null when >1 manager exists — planning breaks | Oldest manager wins (aligned with executor behavior) |
| Caps | None board-side (worker process timeout only, invisible) | Stage cap (default 3600 s) + task cap (default 10 800 s, agent-active time only), sweep parks |
| Kill switch | None; only cooperative interrupt + token-rotation stop | `board_pause` single-row setting; claim gate returns 204; in-flight runs suspended resumable |
| Base movement | Read once at confirm; merge-time guards only | Poller withdraws pending final approvals, rebases the target (`base_sha` updated), notifies |
| Cancel/abandon task closing | Cancel closes only the planning task (stage/design tasks + wakeups leak); auto-abandon closes nothing | One shared closer used by cancel, auto-abandon, and the kill-switch drain |
| Park-exit resolution | `auto_abandoned` keyed on the literal actor id string | Keyed on `actorType === "system"` |

## Scope-overlap gating (§8)

**Overlap predicate** (new, in `scope-check.ts`, reusing its normalization):
`declaredScopesOverlap(a, b)` — true iff any prefix pair satisfies
`x === y || x.startsWith(y + "/") || y.startsWith(x + "/")`.
Directory-prefix, conservative: a false serialization costs latency; a
false parallelization costs a merge conflict found after two expensive runs
(§8 verbatim).

**The hold lives at the activation chokepoint** (`activateWorkflowNode`,
between stage resolution and agent resolution): for a pipeline node, if the
item's confirmed `declaredScope` overlaps any OTHER pipeline item in the
same project in states `implementing | verifying | reviewing | fixing |
designing | final_approval | parked`, the node is held via
`blockNodeInTransaction` with the contract summary
`scope-hold: overlaps <workItemId>`. Held = `blocked` + latest lifecycle
event `node_blocked`, which the existing reconciler already retries every
tick and after every settle — exactly when overlaps clear. Re-holding an
already-held node no-ops (no duplicate events). Activation re-checks the
overlap each pass, so release is automatic; no new node state, no new
table. `parked` stays in the in-flight set deliberately: a parked item's
branch still owns its scope, and §4's unpark path re-enters the same gate.

**The serial guard is deleted** (both call sites; the 409 code retires from
active use but stays registered for old clients). Confirm always succeeds
for a valid plan; serialization becomes visible as a held node
(`node_blocked` event) rather than a rejected confirm.

## Concurrency > 1 (§8)

- **Idle-preferred agent selection**: resolution picks, within the required
  role, an identity with no active run and no pending live wakeup (the
  exact predicate `agentFromRow` already derives status from), oldest
  first; when none is idle, it falls back to the oldest identity — today's
  queueing behavior, unchanged for single-lane setups.
- **Manager landmine defused**: `createLazyManagerInTransaction` picks the
  oldest manager instead of returning null when several exist.
- Operators scale by adding identities (the existing agent route) and fleet
  lanes; `runs_one_active_agent` and one-lane-per-identity remain the
  per-agent invariants. Documented in the fleet example config.
- Parallelism within a task stays prohibited (§8) — untouched.

## Wall-clock caps (§12)

Config knobs (established pattern; env `STEWARD_TASK_BOARD_*`):
`stageCapSeconds` default 3 600, `taskCapSeconds` default 10 800; `0`
disables each; floor 60; task ≥ stage when both non-zero.

**Clocks** (no schema for timestamps — the durable sources exist):

- *Stage clock*: for a stage attempt's active run, elapsed since the node's
  latest `stage_started | stage_retry_ready` project event. For planning
  and design runs (item-level, no node), elapsed since `runs.started_at`.
- *Task clock*: agent-active time only — the sum of intervals the item
  spent in `implementing | verifying | reviewing | fixing | designing`,
  walked from `work_item_transitions`. Human-gate and parked time do not
  count against the task (§12's cap exists to catch runaway agents, not
  slow humans).

**The cap sweep** (own timer, reconcile cadence, `.unref()`, cleared on
close): for each active run of a pipeline work item whose stage or task
clock exceeds its cap — *suspend* the run (below), then park the item with
category `stage_cap_exceeded` or `task_cap_exceeded`, reason naming the
stage, elapsed, and cap; notification kind `cap_parked`. Parks are
human-resolved through the existing retry machinery, and the park ledger
now shows budget pressure by category (§13's loop). A cap breach does not
burn attempts and cannot dead-letter — the suspend variant guarantees it.

## The suspend settle (shared by caps and the kill switch)

New `suspendActiveRunInTransaction(runId, reason, actor)` — the stale-run
pattern with three deliberate differences from a failure settle:

1. The run settles `interrupted` with the given system actor
   (`system:stage-cap`, `system:task-cap`, `system:kill-switch`).
2. The node is blocked with a **`node_blocked`** event (summary carries the
   reason) — reconciler-resumable — never `stage_failed`.
3. No attempt-cap or dead-letter accounting runs; the work item state is
   not advanced (cap sweeps park it explicitly in the same transaction;
   the kill switch leaves it where it is).

On resume/unpark the reconciler re-activates the node through the normal
orphan-adoption path; the next claim links the next attempt as any retry
would.

## Kill switch (§12)

**State**: `board_pause` single-row table (the `automation_configuration`
shape: CHECK-pinned id, seeded in DDL, CAS version, updated_by/at) with
`paused INTEGER CHECK (paused IN (0,1))` and `reason TEXT NULL`.

**Endpoints** (human): `GET /v1/board/pause`;
`POST /v1/board/pause { reason, version }` — sets paused, then suspends
every active run (per-run transactions, `system:kill-switch`) and stops new
machine-verify starts; running verify processes are polled to completion as
usual. `POST /v1/board/resume { version }` — clears paused, emits a wakeup
event per agent with pending work, and runs the workflow reconciler.

**The drain gate is one central check**: the first line of claim-candidate
selection returns null when paused — every path (immediate and long-poll)
already funnels there, and the worker's existing 204 handling means no
protocol change and no fleet change. Wakeups accumulate while paused;
nothing is lost. Every transition is already a durable write, so the drain
is clean by construction (§12's parenthetical, now actually exercised by a
test that kills mid-implementation and resumes to `merged`).

The drain deliberately does NOT run the shared task-closer: pausing
cancels nothing and abandons nothing — it freezes work resumable. Abandon
remains the human's or the park lifecycle's decision.

## Final-approval withdrawal on base movement (§4, local-first)

A poller on the reconcile cadence, for each item in `final_approval` with a
pipeline branch:

- Read the repo's `HEAD` (the existing neutralized runner). If the repo is
  not currently a valid merge target (detached, on a `task/*` branch, dirty
  — the merge executor's own rules), **no-op**: withdrawal must never fire
  on transient operator checkout states.
- If `HEAD == base_sha`, no-op. If `base_sha` is an ancestor of `HEAD` and
  they differ — the base advanced — withdraw: under the final-approval
  lock, ride `returnFinalApprovalToImplementationInTransaction` exactly as
  the merge-conflict path does (state via the fix-aware mapping, no gate
  action), with note `base branch advanced to <head>; rebase onto it and
  re-verify`, actor `system:base-branch-poll` (the actor type is threaded —
  today that path hard-codes "human"), **`base_sha` updated to the new
  `HEAD` in the same transaction** (otherwise the next scope check and
  merge would judge the rebased branch against a stale base and see every
  newly-merged file as a violation), and a notification kind
  `final_approval_withdrawn` (§4's "in-app notice, or it reads as a bug").
- If `base_sha` is NOT an ancestor of `HEAD` (history rewritten), park the
  item with category `base_diverged` — recorded honestly rather than
  auto-rebased across a rewrite.

The engineer's next round receives the note as handoff and rebases under
the same bright lines (§4). The real push webhook remains deferred to the
GitHub slice; this poller is its polling fallback named by the roadmap.

## Task-closing unification (C6 deferral + a cancel gap the exploration found)

`cancelWorkItem` closes only the planning task — a cancel mid-`implementing`
leaves the stage task in progress and its wakeup claimable; auto-abandon
closes nothing at all (an abandoned item's agent can still pick up the
task). One shared `closeWorkItemWorkInTransaction(workItemId, reason, actor)`
factors cancel's steps — terminal-cancel the live planning/design/stage
tasks, reconcile task phases, retire pending wakeups, close open questions
with events, emit the task_updated events — and is used by cancel (existing
semantics preserved), the park-lifecycle auto-abandon, and nothing else.
`resolutionForParkExit` switches from the actor-id string literal to
`actorType === "system"` for `auto_abandoned`.

## Storage (schema v23) and contract

- `PARK_CATEGORIES` += `stage_cap_exceeded`, `task_cap_exceeded`,
  `base_diverged`; `NOTIFICATION_KINDS` += `cap_parked`,
  `final_approval_withdrawn`. Both CHECK-backed → one v22→v23 migration
  rebuilding `park_records` and `notifications` (the established rebuild
  shape; both tables are small, FK-free, with only their unique indexes to
  recreate).
- New `board_pause` table (additive, in the same migration).
- Contract: `BoardPause` type + parsers; the `scope-hold:` summary prefix
  as an exported constant; new error codes
  `TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT` (CAS) — pause state reads ride
  the snapshot loosely for old tabs.

## Web

Small, mostly free: a pause banner + pause/resume control (sidebar or
board header, human-gated, with reason); held nodes render their
`scope-hold:` summary in the existing node/event surfaces; the new
notification kinds render through the existing block; cap parks appear in
the parks ledger with their new categories (tolerant enums already bucket
unknowns for old tabs — new tabs get labels).

## Error handling

- All sweeps: per-item transactions re-asserting preconditions; failures
  logged, next tick retries; never thrown out of timers.
- Pause CAS conflicts 409; pausing an already-paused board no-ops
  idempotently (version still guards).
- Withdrawal races merge: both run under the per-item final-approval lock;
  whichever wins, the other sees the changed state and no-ops.
- Suspend on a run that settles concurrently: the per-run transaction
  re-checks `status='active'` and no-ops.
- Cap sweep on an item that parks/settles mid-sweep: same re-check shape.

## Testing

- Unit: overlap predicate table (equal, nested, disjoint, root, trailing
  slashes); clock computations (stage entry from events incl. retry
  re-entry; task clock excluding gate/parked intervals; same-state
  transition caveat); suspend settle (node_blocked emitted, no attempt/cap
  effect); idle-preferred selection (idle chosen, busy fallback, manager
  multi-identity); pause CAS; withdrawal target-validation no-ops;
  resolutionForParkExit actor-type table; shared closer (tasks cancelled,
  wakeups retired, questions closed) for cancel and auto-abandon.
- Integration: overlapping confirm → second item's node held with the
  contract summary → first merges → reconciler releases → second proceeds;
  cap sweep on a clock-driven fixture parks with category + notification
  and the run suspended; kill switch mid-implementation → claims 204, run
  suspended, resume → item proceeds to `final_approval`; withdrawal —
  advance the fixture repo's base, poller withdraws, `base_sha` updated,
  notification written, item back to `implementing`/`fixing` per findings
  history; base rewritten → `base_diverged` park.
- **Exit-criterion e2e** (extends pipeline-e2e, two engineer identities +
  two lanes): (1) two disjoint-scope items flow CONCURRENTLY to merged —
  both claims interleave; (2) two overlapping-scope items serialize — the
  second holds until the first merges; (3) a runaway stage (stub engineer
  that never settles + driven clock) is suspended and parked by the cap
  sweep; (4) pause mid-flight drains cleanly (claims 204), resume completes
  the run to merged. Humans only at the gates.

## Deferred (recorded, not decided)

- The push webhook + reachable endpoint (GitHub slice; roadmap names the
  funnel-vs-polling decision — polling shipped here).
- On-unpark declared-scope re-validation against merged work (§4 Parked) —
  next campaign that touches unpark; the withdrawal poller narrows the
  window meanwhile.
- Provider-outage backoff-then-park (§12) — lane backoff exists; the
  board-side park needs outage signals the worker does not yet report.
- §12 partial-stage artifact reset on resume; token/cost accounting
  (excluded by §3); deploy-health loop (out of scope by roadmap).
- Auto-scaling identities/lanes — operators add them manually; the board
  schedules across what exists.

## Alternatives considered

- **Gating overlap at confirm** (keep the 409 shape) — rejected: §8 gates
  the start of work; confirm-time rejection punishes the human for queue
  state and cannot self-release. The hold is silent, automatic, and visible
  in events.
- **A `held` node state or a scope_holds table** — rejected for v1: a new
  `WORK_NODE_STATES` member is a rebuild + strict-parser quake; a side
  table duplicates what `blocked` + `node_blocked` already give (idempotent
  hold, automatic retry, event visibility). Revisit if §13 wants hold
  analytics.
- **Kill switch via the interrupted-failure settle** — rejected: it strands
  nodes `stage_failed`-blocked (reconciler never resumes) and burns
  attempts toward dead letter; a drain that dead-letters healthy work is
  corruption with extra steps. Hence the suspend variant.
- **Caps killing to `dead_letter` directly** — rejected: §4 routes budget
  exhaustion to `parked`; dead letter remains the repeated-failure verdict.
- **Webhook now via Tailscale funnel** — rejected for local-first: the
  roadmap defers the reachable endpoint to the GitHub slice; polling on the
  reconcile cadence bounds staleness to a minute without new exposure.
- **Withdrawal without updating `base_sha`** — rejected: the rebased branch
  would be scope-checked and merged against the stale base, flagging every
  file other items merged; updating the base in the withdrawal transaction
  is what makes the §4 rebase step coherent.
