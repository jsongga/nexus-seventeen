# Orchestrator campaign 4 — Pipeline v1 (local-first)

Status: Approved in brainstorming (operator directed local-first with external
decisions deferred; spec open for review)
Author: Claude, from `orchestrator-design.md` §4 and `orchestrator-roadmap.md`
campaign 4
Date: 2026-08-19
Scope: Intake's full plan record, a real plan-approval gate with one
revision, one pipeline branch per work item, Implement under bright lines
with the fast-tier inner loop, machine-only Verify wired to the campaign-3
verify library, final approval with a local merge — no GitHub, no pushes

## Summary

§4 defines the pipeline: Intake produces a rich plan record, a human
approves it, Implement writes staged commits under bright lines, a machine
(never an agent) runs the full verification, and a human merges the result.
Campaigns 1–3 built the state machine, the execution substrate, and the
verify tiers; this campaign connects them into that flow for a single
runtime, serially.

**Local-first (operator decision, 2026-08-19):** the delivery vehicle is a
local branch merged locally at the final gate — the exact analogue of
merging a PR, minus the remote. GitHub (org, service account, PR creation,
push) is a deferred thin slice; nothing in this campaign forecloses it.
Also deferred as swappable config, not decisions: Implement's runtime
(per-lane `provider`), containers vs local-process lanes (per-lane
`runtime`), and the real-CLI egress smoke.

**Corrected premise:** the roadmap says "confirm/reject on manager plans
exists." Confirm exists; reject does not — the web's Reject button performs
destructive cancellation (`WorkItemDetail.tsx:376` → cancel → `abandoned`),
and nothing ever writes the `rejected` plan state. This campaign builds the
actual reject → revision loop.

## What exists / what changes

| Piece | Today | This campaign |
| --- | --- | --- |
| Plan record | `plan_revisions`: objective, assumptions, acceptance criteria (prose), node DAG (`store.ts:41`, `WorkflowPlanDraft`) | + change shape, tier, declared scope, non-goals, mechanical portions, blocking questions, executable checks |
| Plan gate | Confirm only; "reject" = cancel/abandon | Reject → `planning` revision (one allowed; second parks) |
| Planning signal | Task-title prefix `"Plan workflow:"` (`agent-envelope.ts:242`) | Explicit intake marker in claim context |
| Branch identity | `task/<taskId>` per stage-attempt, derivable, unstored — N×M branches per item | `pipeline_branch = task/<workItemId>` + `base_sha` on the work item; cross-stage continuity |
| Verify | No non-agent executor (`AutomationStageExecutor = agent_type\|human\|disabled`); `VerifyRunner` unwired to the board | `machine_verify` executor kind; durable attempt→verify-run link; reconciler-timer polling; system-actor settle |
| Final gate | `final_approval` unreachable; last node completing → `merged` (`workflow.ts:392-400`) | Green Verify → `final_approval`; approval endpoint performs the local merge |
| Scope enforcement | None | Files-touched vs declared scope checked at settle; violation parks |

## Intake — the planning stage, upgraded

The existing flow stays: `queued → planning` creates the manager's planning
task (`work-items.ts:203-302`); the settled run's `workflowPlan` becomes a
proposed revision landing the item in `plan_approval` (`runs.ts:513-577`,
`workflow.ts:80-163`).

**The plan record grows §4's fields**, all optional in the contract so old
tabs and old agents keep working (the browser's loose parsers ignore
unknown fields; new plan-revision *states* would throw, so none are added):

- `changeShape: "mechanical_sweep" | "feature" | "blast_radius"`
- `tier: "standard" | "hazardous"` — trusted, recorded. Hazardous items
  park at confirm with reason "hazardous tier needs the Design stage
  (campaign 5)"; the gate shows this before the human clicks.
- `declaredScope: string[]` — directory prefixes, validated non-empty for
  pipeline plans
- `nonGoals: string[]`, `mechanicalPortions: string[]`
- `blockingQuestions: { question, recommendedDefault }[]` — rendered at the
  gate; v1 answers arrive via the existing reject-with-note loop
- Acceptance criteria become `{ criterion: string, check?: string }[]` —
  `check` is a command Verify runs after the full tier (§4 "executable
  checks"); prose-only criteria remain legal and are listed at the final
  gate for the human instead

Storage: new nullable JSON/text columns on `plan_revisions` (schema bump via
the established single-sourced migration path). Prompting: the planning
instructions in `agent-envelope.ts` require the new fields for pipeline
plans; `RESULT_SCHEMA`'s `workflowPlan` grows the same optional fields.
**The title-prefix hack is replaced**: the claim context's workflow block
(or a sibling field) carries `intake: true` for planning tasks, and
`agentPrompt` branches on that instead of `title.startsWith("Plan
workflow:")`. Never writes code — unchanged, prompt-enforced as today.

Pipeline plans in v1 are the degenerate DAG: one node, stage template
`[implementation, testing]` — Implement then machine Verify. The
must-end-in-`verification` template rule (`workflow.ts:107`) gets a
carve-out: templates may end in `testing` when that stage's executor is
`machine_verify` (the verification/review stage arrives with campaign 5).
Multi-node DAGs keep working exactly as today (they're not pipeline plans).

## The plan gate

- **Reject**: new human endpoint `POST /v1/plans/:planRevisionId/reject`
  `{ note, expectedState: "proposed" }` — marks the revision `rejected`
  (state exists, never written today), stores the note, transitions the
  work item `plan_approval → planning` (edge already legal,
  `index.ts:164`), and re-arms the planning task with the note in the
  manager's context. **One revision allowed** (§4): a second reject parks
  the item — "the request itself is unclear."
- **Confirm** unchanged (`workflow.ts:180-218`), plus the hazardous-parks
  rule above. The no-revision-after-confirm guard
  (`PLAN_REVISION_UNSUPPORTED`, `workflow.ts:125-127`) stands.
- **Web**: `WorkItemDetail` renders the new record sections (change shape,
  tier, scope, non-goals, questions with defaults) and rewires Reject to
  the new endpoint with a note dialog; Cancel remains available but
  separate. `parseWorkflowPlan`'s fixed projection is extended with the new
  optional fields.

## One branch per work item

New nullable columns on `work_items`: `pipeline_branch`, `base_sha`. Set at
confirm for pipeline plans: branch `task/<workItemId>`, base = the project
repo's current default-branch head.

The claim context's workflow block gains `workspaceKey: string | null` —
the engine sets it to the work item id for pipeline stage tasks.
`WorkspaceScopedLauncher` keys the workspace on
`context.workflow?.workspaceKey ?? context.taskId` (existing behavior
untouched for everything else). `TaskWorkspaceManager.create` learns branch
continuity: when `task/<key>` already exists in the source repo (a prior
stage harvested), the fresh clone checks out that branch instead of
creating from HEAD — commits accumulate across Implement rounds on one
branch. Harvest stays fetch-based and hook-safe as shipped in campaign 2.

## Implement

The engineer stage task for a pipeline plan carries, injected at spawn via
the claim context: the confirmed plan record verbatim, the pipeline branch
name, and instructions encoding §4's core loop — failing test where
criteria allow, implement, **run the project's fast tier**
(`npm run verify:fast`, campaign 3) each iteration, area tier once before
handoff, staged commits by logical unit, mid-run reversible decisions
appended to the assumptions list in the handoff, bright lines (file outside
declared scope, unplanned schema change, new dependency, published-interface
change, non-goal violation, infeasible plan, deleting/skipping a test) →
stop and report `parked` intent.

**Enforcement is two-layer.** The prompt states the rules; the engine
verifies the cheap, objective one at settle: `git diff --name-only
<base_sha>..task/<id>` in the harvested repo against `declaredScope`
prefixes — any file outside scope parks the item with the file list in the
park reason. (Deeper checks — test modification, dependency additions —
are campaign 5 review territory.) Local-process lanes get workspace support
for pipeline tasks by constructing the fleet's local worker with the same
`WorkspaceScopedLauncher` wrapping (campaign 2 only wired containers; the
seam exists).

## Machine Verify

New executor kind `{ kind: "machine_verify" }` in the automation config
(beside `agent_type | human | disabled`). `activateWorkflowNode`
(`projects.ts:225-348`) handles it: instead of dispatching an agent wake it

1. creates a fresh clone of the pipeline branch (same
   `TaskWorkspaceManager`, key `<workItemId>-verify`, read-only intent),
2. starts `VerifyRunner.startFull()` in it (the clone carries the
   project's own `docs/workflow.md` contract; the full tier is whatever
   that project declares),
3. writes a row in a new `verify_attempts` table — `attempt_id, node_id,
   stage, verify_run_id, workspace_path, state` — because verify run ids
   live only on disk today and must survive a board restart.

The existing reconciler timer (`service.ts:163-171`, 60 s) gains a sweep:
for each open `verify_attempts` row, poll `VerifyRunner.status(id)`;
terminal → settle through a **new system-actor settle path** (a sibling of
`settleAttemptInternal` — the agent-run route deliberately rejects system
actors, `runs.ts:611`). Green: advance the stage machine; after the last
stage, transition to `final_approval` (not `merged`). Failed or `died`:
return the node to `implementation` with the log tail (bounded, via
`tail()`) recorded as the stage handoff evidence — the engineer's next
round reads it. The existing attempt cap applies: three failed rounds →
`dead_letter`. Acceptance-criteria `check` commands run after the full
tier, in the verify workspace, each recorded pass/fail in the attempt row.

## Final approval and local merge

`final_approval` becomes reachable. The web view shows: commit list and
diffstat of `base_sha..pipeline_branch`, the assumptions list with mid-run
additions flagged, files-touched vs `declaredScope`, verify results
(including per-check outcomes), and prose criteria for human judgment.

- **Approve**: `POST /v1/work-items/:id/approve-merge { version }` — the
  board performs the local merge in the project repo: `git merge --no-ff
  task/<workItemId>` onto the default branch with hooks neutralized (the
  campaign-2/3 `-c core.hooksPath= -c core.fsmonitor=` discipline), then
  transitions to `merged`. Merge conflict → no mutation beyond an aborted
  merge, item parks with the conflict summary. Nothing is ever pushed.
- **Reject**: returns the item to `implementing` with the note as handoff
  (the state machine already allows `final_approval → implementing`).
- The base-branch-push withdrawal webhook is campaign 7, unchanged.

## Serial execution

One pipeline item in flight per project: confirm blocks (409) when another
pipeline plan is between `plan_approval` (confirmed) and
`merged`/terminal. §8 scheduling arrives in campaign 7.

## Error handling

- Reject on a non-`proposed` revision → 409, expected-state guard as
  confirm.
- Verify workspace creation or `startFull` spawn failure → the attempt row
  records `failed_to_start`; the reconciler retries once, then routes to
  the same failed-verify path (back to implementation with the reason).
- Board restart mid-verify: `verify_attempts` + on-disk `status.json`
  re-join on the next timer tick; a `died` run counts as a failed round.
- Scope-check git failures (missing branch, corrupt clone) park the item —
  never silently pass.
- All new writes ride `transitionWorkItemInTransaction` and store
  transactions with after-commit events, per house rules.

## Testing

- Unit: plan-record validation (new fields, closed-world server-side);
  reject/revision/park logic; scope-prefix checker; template carve-out;
  serial-execution guard; `verify_attempts` state machine with a fake
  runner; workspaceKey resolution in the scoped launcher; branch-continuity
  clone behavior.
- Integration (runtime suite): reject → revised plan → confirm flow over
  the real HTTP board; machine-verify settle loop with a stub verify
  contract in a fixture repo; final-approval merge (success and conflict)
  against fixture repos.
- **Exit-criterion e2e** (gated suite): on a fixture project repo with a
  trivial verify contract — raw request → manager stub produces the full
  plan record → confirm via HTTP → engineer stub commits staged changes on
  `task/<workItemId>` → machine Verify green via the real
  reconciler+runner → `final_approval` → approve-merge lands the commits
  on the fixture's main. Human clicks are the only human steps.
- Web: plan-record rendering and the new gate controls (vitest).

## Deferred (recorded, not decided)

- **GitHub delivery slice**: org/repo target, service account, push + PR
  creation with the plan rendered into the body, and switching final
  approval's merge to GitHub. The local merge endpoint is shaped so the
  GitHub executor replaces one collaborator.
- **Container lanes for pipeline stages** and the **real-CLI egress
  smoke**: per-lane config; smoke remains the operator gate for cutover.
- **Implement runtime**: per-lane `provider` config; e2e uses the stub.
- `projects.yaml` hazardous path patterns; prompts-SHA pinning
  (`promptsSha` slot still unfed); Design stage, review/fix loop, ledgers,
  webhooks — campaigns 5–7.

## Alternatives considered

- **A separate pipeline engine beside the workflow machinery** — §4's
  linear flow could bypass `work_nodes` entirely, but the existing
  stage-template machinery already provides attempts, caps, handoffs,
  recovery, and reconciliation; a one-node degenerate plan reuses all of it
  and campaign 10's DAG decomposition composes naturally. Rejected:
  parallel engines drift.
- **GitHub-first PR flow now** — collides with the operator's metered-CI /
  autodeploy constraints and blocks the campaign on org decisions; the
  local merge preserves the exact gate semantics. Deferred by operator
  direction.
- **Trusting prompt-level bright lines alone** — the scope check at settle
  is cheap and objective; trusting self-report defeats §4's purpose.
  Deeper enforcement (test tampering, dependency diffing) belongs to the
  campaign-5 reviewer, not v1 heuristics.
- **A new `verify` agent role instead of a machine executor** — §4 is
  explicit: "Machine only, no agent... the objective gate the agent can't
  rationalize past." An agent-shaped verify would re-open that hole.
- **Auto-merge on green Verify (skip final approval)** — §4's second human
  gate exists precisely because assumptions accumulate mid-run; the exit
  criterion keeps the human merge click.
