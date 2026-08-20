# Orchestrator campaign 5 — Review + Fix loop

Status: Drafted autonomously per operator "continue" (2026-08-19); decisions
below follow campaign-4 precedent (local-first, config-swappable, ride the
existing machinery); open for review
Author: Claude, from `orchestrator-design.md` §4 and `orchestrator-roadmap.md`
campaign 5
Date: 2026-08-19
Scope: Reviewer stage on a different runtime/model with structured findings,
fix rounds (cap 3, fresh sessions) feeding back through machine Verify, dead
letter on round exhaustion, and the Design stage that unblocks the hazardous
tier — all riding the campaign-4 pipeline

## Summary

§4 completes the autonomous middle: after machine Verify, a reviewer on a
different runtime reads the diff against the plan, emits structured findings,
and blocking findings send the task through capped fix rounds — fresh
sessions, always re-verified by machine before re-review. Hazardous-tier
plans stop parking at confirm and instead pass through a Design stage whose
record (state list, failure-point table, idempotency keys, fault-injection
cases) is injected into Implement, Fix, and Review. Exit criterion: a seeded
defect is caught, fixed, and re-verified without human input.

Everything rides shipped machinery. The pipeline template grows a third
stage — `["implementation", "testing", "verification"]` — and the existing
stage engine already advances testing-green into `verification` and maps that
stage to the `reviewing` state. The automation contract already restricts
`verification` to `verifier`-role agent types, which resolve to their own
identity and fleet lane — §4's "different runtime/model from Implement" falls
out of config, not new code. Review rounds reuse the per-stage attempt
counter; the Design stage is a byte-for-byte analogue of the planning-task
machinery.

## What exists / what changes

| Piece | Today | This campaign |
| --- | --- | --- |
| Pipeline template | `["implementation","testing"]`, hardcoded in three predicates (`workflow.ts:77-89`, `runs.ts:606-624`) | One shared predicate accepting v1 (legacy, confirmed plans only) and v2 `[...,"verification"]`; new pipeline plans must be v2 |
| Last-stage settle | `settleAttemptInternal` always writes `merged` (`workflow.ts:1188-1198`) — green review would skip the final gate | Pipeline-aware: `final_approval`, mirroring the machine-verify path (`workflow.ts:980-989`) |
| Review | `verification` stage exists; verifier role read-only at provider layer; no findings anywhere | Reviewer agent on `verification`; `review_findings` table; findings-driven settle |
| Fix | Verify-fail re-arms `implementation` as a plain retry | Blocking findings → item `fixing`, findings injected into a fresh session, re-verified then re-reviewed; cap 3 rounds → `dead_letter` |
| Hazardous tier | Parks at confirm ("needs the Design stage") (`workflow.ts:466-478`) | `plan_approval → designing`; design task produces a validated design record; `designing → implementing` |
| Serial guard | Omits `reviewing`/`fixing`/`designing` (`workflow.ts:99-116`) | All in-flight pipeline states listed |
| Fresh sessions | `areaMemory` injects the agent's last 8 task results (`runs.ts:769-785`) | Suppressed for pipeline stage claims |

## The pipeline template, v2

New pipeline plans are one node with stage template
`["implementation", "testing", "verification"]` — Implement, machine Verify,
Review. This already satisfies the must-end-in-`verification` rule with no
carve-out; the campaign-4 `testing`+machine_verify carve-out is removed from
propose-time validation (new proposals must be v2) while
`storedPlanHasPipelineShape` and the settle-time predicate accept both shapes
so confirmed v1 items keep flowing. All three predicate copies collapse into
one shared helper returning `"v1" | "v2" | null`.

Executor requirements at confirm extend the campaign-4 drift guard: `testing`
must still resolve to `machine_verify`, and `verification` must resolve to an
enabled `agent_type` — which the automation contract already forces to role
`verifier` (`validate.ts:1241-1249`), a distinct identity and fleet lane from
the engineer.

**Different runtime/model, enforced:** at claim of a pipeline `verification`
task, the board compares the claiming lane's pinned provider+model against
the node's latest `implementation` attempt's pinned pair; equal → 409
`TASK_BOARD_REVIEW_RUNTIME_CONFLICT`. A model reviewing its own output shares
its blind spots; a misconfigured single-lane setup surfaces as a visible
stuck stage rather than a silent self-review.

## Review

**Claim context** (injected at spawn — the diff and plan, never the
implementer's reasoning): the existing `pipeline` block (plan record,
declared scope, non-goals, assumptions), plus a new `review` block assembled
by factoring the pipeline-summary git work (`projects.ts:191-319`) into a
reusable collaborator: commits, diffstat, `filesTouched` with
added/modified/deleted status, `scopeOk` (files-touched vs predicted — §4's
highest-signal check, pre-computed), server-computed `midRunAssumptions`,
acceptance criteria and criterion checks, prior-round findings, and the
design record when one exists.

**Workspace:** a fresh clone on the pipeline branch under key
`<workItemId>-review` — the board returns the suffixed `workspaceKey` for
pipeline `verification` claims, and the scoped launcher treats a suffixed
key as a derived read-only workspace: the three-arg
`TaskWorkspaceManager.create` on the work-item branch (exactly as machine
verify's `-verify` key), removed or retained but never harvested. The
verifier role is already read-only at the provider layer. The workspace-key
allow-list (`validate.ts:1764`) gains the `-review` suffix.

**Findings are the reviewer's output.** `RESULT_SCHEMA` gains optional
`reviewFindings`: up to 64 of `{ file?, line?, category, severity, expected,
actual }`. Categories (new contract enum): `correctness | security |
plan_deviation | test_modification | docs | style | other`; severities:
`minor | major | critical`. **`blocking` is derived server-side** — a finding
blocks iff its category is `correctness`, `security`, or `plan_deviation`
(§4: style nits don't block) — so the reviewer cannot be prompted into
unblocking a correctness finding.

**Settle semantics** (in `settleAttemptInternal`, pipeline `verification`
only; `reviewFindings` anywhere else → 400
`TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED`):

- All findings persist to `review_findings` with the stage attempt number as
  the round.
- Handoff `passed` + zero blocking findings → stage passes → item
  `final_approval` (the pipeline-aware last-stage fix above).
- Handoff `failed` + ≥1 blocking finding → fix round (below).
- Mismatches are contract errors: `passed` with blocking findings or `failed`
  without any → 400 `TASK_BOARD_REVIEW_OUTCOME_MISMATCH` /
  `TASK_BOARD_REVIEW_FINDINGS_REQUIRED`.

**Prompt** (verifier role + `verification` stage + pipeline): review depth
follows change shape (spot-check a mechanical sweep, read feature work line
by line, review a blast-radius change per consumer); check files-touched vs
predicted first, then each acceptance criterion against the code, docs
updated in the same diff, and any modified or deleted existing test —
flagged as a `test_modification` finding unless the plan declared it; for
hazardous tier, trace each failure point in the design record to the line
that guarantees it.

## Fix rounds

A blocking review re-arms the node at `implementation` through the existing
retry path, with three changes:

- **State mapping becomes fix-aware.** `workItemStateForStage` maps
  `implementation → fixing` (not `implementing`) when the node has any
  blocking finding — a durable, derivable predicate, no new column. The
  needed edges already exist (`reviewing → fixing`, `fixing → verifying`,
  `verifying → fixing`, `final_approval → fixing`); the one addition is
  `parked → fixing` so an unparked fix-round item re-enters its loop.
- **Findings reach the fixer.** The claim context's retry-evidence seam
  (`workflow.ts:375-387`) extends to `verification` handoffs, and a `fix`
  block carries `{ round, findings }` for the latest blocking round. The
  fixer prompt: fix the findings, then re-trace the whole flow, not just the
  patch; the fast-tier loop, staged commits, and bright lines all still
  apply.
- **Fresh session, genuinely.** Each run is already a new CLI session given
  only injected context; additionally, `areaMemory` (the agent's last 8 task
  results) is suppressed for all pipeline stage claims — §4's "never the
  prior conversation".

The fixed branch then flows `testing` (machine Verify) before `verification`
again — Fix returns to Verify, never straight to Review, for free from stage
order.

**Cap and dead letter:** the `verification` stage's per-node attempt counter
is the fix-round counter. For pipeline verification the re-arm cap is 4
attempts (three fix rounds, per §4/§12) instead of the default 3; the fourth
blocking review dead-letters the item through the existing conventions
(`endedAt`, `currentStage: null`, actor `system:workflow`). Implementation
and machine-verify caps are unchanged and still dead-letter on their own
exhaustion.

**Built the wrong thing:** v1 has no auto-replan (`reviewing → planning`
interacts badly with the one-revision rule); a reviewer concluding the plan
itself was mis-executed emits blocking `plan_deviation` findings, and round
exhaustion dead-letters for the human. Recorded under alternatives.

## Design stage (hazardous tier)

Hazardous pipeline confirm stops parking. Instead, confirm sets the pipeline
identity (branch + `base_sha` — today skipped for hazardous), transitions
`plan_approval → designing`, and creates a design task mirroring the
planning-task machinery byte for byte: a `work_item_design_tasks` link table,
the manager identity, a `design: true` claim flag beside `intake`, and
result-recording helpers. Hazardous non-pipeline plans keep parking
(message: "hazardous tier requires a pipeline plan").

**The design record** is the settle payload (`RESULT_SCHEMA` gains optional
`designRecord`; on a non-design task → 400
`TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED`):

- `states` and `transitions` (from, to, what is durably recorded before any
  process/network boundary, recovery)
- `failurePoints` — must cover all six canonical points (new contract enum):
  crash before send / after send before response / after response before
  commit / after commit before ack / duplicate delivery / concurrent
  invocation — each with resulting state and recovery mechanism
- `idempotencyKeys` — name, where generated, where persisted, how reused
- `faultInjectionCases` — name, scenario, expectation; Implement's prompt
  requires writing each as a test

Missing or incomplete → 400 `TASK_BOARD_DESIGN_RECORD_REQUIRED` naming the
gap. A valid record persists to a `design_records` table (one per work item,
keyed to the confirmed revision), then dependency-free nodes activate and the
item transitions `designing → implementing`. A non-completed design run parks
the item, exactly like a failed planning run. There is no human gate on
design — §4 has two gates, and design is not one of them.

**Prompt** (design task): produce the record; §4's standing prohibitions
verbatim (locks are an optimization never the correctness boundary; unknown
outcome is a distinct state resolved by querying, never assuming;
idempotency keys generated once, persisted with the intent record, reused
verbatim; timers/cleanup/retries are state-machine participants). Never
writes code.

The record is injected wherever the plan record is: a nullable
`designRecord` on the claim context's `pipeline` block, rendered into the
Implement, Fix, and Review prompts.

## Storage (schema v21)

Additive migration — no enum-array changes, so no rebuild:

```sql
CREATE TABLE review_findings (
  finding_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id),
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  file TEXT NULL, line INTEGER NULL,
  category TEXT NOT NULL CHECK (category IN (...)),   -- contract-derived
  severity TEXT NOT NULL CHECK (severity IN (...)),
  expected TEXT NOT NULL, actual TEXT NOT NULL,
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TABLE design_records (
  design_record_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(work_item_id),
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(plan_revision_id),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE work_item_design_tasks (  -- analogue of work_item_planning_tasks
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  created_at TEXT NOT NULL
);
```

Contract types `ReviewFinding`, `DesignRecord`, category/severity/
failure-point enums; migration ladder entry, `fixtures/v20-schema.sql`
freeze, and the drift-test projection filter per the established pattern.

## Web

- `pipeline-summary` grows `findings` (all rounds, blocking flagged) and
  `designRecord`; its fetch gate widens from `final_approval` to
  `reviewing | fixing | final_approval`. The final gate thus shows findings
  across all rounds (§4).
- `WorkItemDetail`: findings panel by round; design-record section for
  hazardous items; the hazardous confirm banner changes from "will park" to
  "will enter the Design stage"; timeline buckets learn the new states.
- Read parsers stay loose (new optional fields only); no strict-parser or
  enum-tolerance changes — old tabs degrade to not rendering the new panels.

## Error handling

- Reviewer settle validation failures (mismatch, findings-elsewhere) are
  400s that fail the settle — the run stays open for the worker's retry
  discipline, consistent with existing handoff mismatch guards.
- Review workspace creation happens worker-side at launch (the scoped
  launcher); a failure fails that run and rides the existing attempt/retry
  discipline — nothing new.
- Design settle with an invalid record → 400 naming the first gap; a
  non-completed design run parks the item with the runtime's detail.
- Runtime-conflict 409 at review claim emits a board event so a
  misconfigured lane is visible, not just a quiet stall.
- All new writes ride `transitionWorkItemInTransaction` and store
  transactions with after-commit events, per house rules.

## Testing

- Unit: findings validation and blocking derivation; fix-aware state
  mapping; shared pipeline predicate (v1/v2/null); verification cap
  arithmetic (4 attempts = 3 fix rounds); design-record validation
  (failure-point coverage); review claim-context assembly; workspace-key
  allow-list; runtime-conflict comparison.
- Integration: review settle green → `final_approval`; blocking findings →
  `fixing` with findings in the next claim; fix → verify → re-review loop;
  fourth blocking review → `dead_letter`; hazardous confirm → `designing` →
  record persisted → `implementing`; serial guard covers the new states.
- **Exit-criterion e2e** (extends `pipeline-e2e.test.ts`): engineer stub
  seeds a marker defect that passes machine Verify; reviewer stub (own
  verifier lane, distinct provider/model pair) emits a blocking correctness
  finding; fixer round repairs it; Verify re-runs green; review round 2
  passes → `final_approval` → merge. Companion arcs: always-blocking
  reviewer → dead letter after 3 fix rounds; hazardous plan → design record
  → merged. Human clicks only at the two gates.

## Amendments (ruled during implementation, 2026-08-19)

- **Findings bounds tightened for transport fit.** This spec's "up to 64"
  findings with 2000-char texts cannot fit the settlement HTTP body limit
  (64 KiB default). Shipped contract: ≤16 findings per settle,
  `expected`/`actual`/`file` ≤1000/1000/512 chars
  (`REVIEW_FINDING_DRAFT_MAX_ITEMS`, `REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH`),
  worst case asserted under 64 KiB by test. Raising capacity later means
  raising the route budget with it.
- **Design-record bounds tightened for the same reason:** states ≤32,
  transitions ≤64, idempotency keys ≤8, fault-injection cases ≤8, labels
  ≤96 chars, detail fields ≤128 chars — and `failurePoints` is therefore
  exactly the six canonical points, one entry each.
- Prior review evidence injected into later review rounds is byte-budgeted
  (newest rounds kept, truncation flagged), and review git evidence
  (commits, diffstat, file lists) is bounded server-side before claim
  construction.

## Deferred (recorded, not decided)

- Findings/park **ledger views and category analytics** — campaign 6 (the
  table and categories land now; querying and conversion workflows later).
- `reviewing → planning` auto-replan ("built the wrong thing").
- Reviewer runtime choice as anything but config; real second-runtime
  adapter — campaign 8. Real-model review quality is not asserted by tests.
- Park lifecycle (age, notify, auto-abandon) — campaign 6; scheduling,
  webhooks, concurrency — campaign 7; GitHub slice — unchanged from
  campaign 4.

## Alternatives considered

- **A separate Fix stage in `WORKFLOW_STAGES`** — a `fix` stage would make
  the round explicit but adding a member to a CHECK-backed enum forces a
  rebuild migration and breaks old tabs' strict stage parsing. The fix-aware
  state mapping gets the §3 state (`fixing`) with zero enum churn. Rejected.
- **A fixer agent type on its own lane** — dispatch resolves identities by
  role, and a fixer is role `engineer`, so it would share Implement's lane
  anyway; §4 wants a fresh session, not a different model, for Fix.
  Rejected as no-op complexity.
- **Reviewer verdict field instead of derived blocking** — letting the
  reviewer declare pass/fail directly invites rationalization; deriving
  blocking from category keeps the gate mechanical and the vocabulary
  auditable. Chosen: derived.
- **Auto-replan on plan-deviation findings** — collides with the
  one-revision rule and the serial guard, and §4 routes "built the wrong
  thing" through a human anyway at dead letter. Deferred.
- **Design as a workflow node stage** — would put design inside the node's
  stage template and its attempt caps, but design is item-scoped (one record
  per item, pre-implementation) exactly like planning; the planning-task
  machinery already has identity, wake, park, and settle semantics. Chosen:
  planning analogue.
- **Warn-only on same runtime/model review** — silently permitting
  self-review defeats the design's stated reason for a second runtime; a
  hard 409 with an event makes the misconfiguration cost visible and
  fixable. Chosen: hard.
