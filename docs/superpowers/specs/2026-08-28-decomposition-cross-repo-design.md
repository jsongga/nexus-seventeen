# Campaign 10: Decomposition + cross-repo changes

**Status:** Approved for implementation (drive-to-completion authorization; four architectural rulings recorded below)
**Author:** Claude
**Date:** 2026-08-28
**Scope:** orchestrator-design.md §7 (decomposition) and §9 (cross-repo); roadmap campaign 10 — the last design campaign. Exit: one blast-radius change lands as phased children across two repos (runtime e2e).

## Summary

Today a work item is one plan, one branch, one repo, one merge. §7 asks for parent/child work items whose
children are each independently mergeable, with decomposition **declared in the plan** by change shape;
§9 asks for cross-repo changes as three phased children — Expand → Migrate (one per consumer, parallel) →
Contract (human-gated, after all migrates are merged *and deployed*). This campaign adds parent/child
work items with a dependency DAG at the work-item level, a plan declaration format with split-rule
validation, phase-aware merge policy, a human deploy-attestation gate, cross-repo interface context for
consumers, and the UI to see and drive it.

Seam facts are from the 2026-08-28 exploration (constraints numbered C1–C14 there).

## Rulings (architectural)

- **R1 — A parent is a work item in a new state `coordinating`.** Pipeline plans are single-node by three independent assertions (C3), and every existing non-terminal state implies an agent + branch + claim (C5). One new enum member is an honest contract change (v26 widens the CHECK; the web's forward-tolerant enum parsing from campaign 1 absorbs it) — cheaper than abusing `planning`.
- **R2 — Children are created at the parent's plan confirmation, with their plans pre-confirmed.** The human approving the parent's plan approves each child's objective, scope, project, phase, and dependencies; children therefore skip their own plan gate (a `plan_confirm` gate action is written for each, actor = the parent's approver, `refId` = parent) and start in `queued`.
- **R3 — Merge policy by shape.** *Feature split* (single repo): children run to `final_approval`; the parent's **single** final approval fans out and merges children in dependency order (`final_approve` on the parent with a note listing child merge shas; children settle with their own `final_approve` actions so the audit invariant "every merge has a gate action" holds). *Blast-radius / phased* (cross-repo): the parent's plan approval explicitly pre-authorizes auto-merge of **Expand** and **Migrate** children when they reach `final_approval` (shown at the gate as "Children merge automatically once verified and reviewed"; they are additive by rule); the **Contract** child always has its own human final approval and additionally requires every Expand/Migrate child to be `merged` **and deploy-attested**.
- **R4 — "Deployed" is human attestation.** New gate kind `deploy_attest` recorded per merged child ("Attest deployed" in the UI). The base-branch poller's observation that the merge landed on the base is a precondition shown to the human, not a substitute (C6).

## Data model (v26)

- `work_items` gains `parent_work_item_id` (nullable FK, `ON DELETE RESTRICT`), `phase` (nullable: `expand|migrate|contract`), `child_ordinal` (nullable int). `WORK_ITEM_STATES` gains `coordinating` (parent-only; transitions: `plan_approval → coordinating`, `coordinating → final_approval | parked | abandoned | dead_letter`). A parent's `resolved_project_id` is the provider/primary repo; children may differ.
- `work_item_dependencies (work_item_id, depends_on_work_item_id)` — mirrors `work_node_dependencies` semantics: cycle check, **ready when every dependency is `merged`** (and, for a Contract child, deploy-attested).
- `projects` gains `repo_path` (backfilled from `description`; consumers switch to it; `description` stays descriptive).
- `GATE_KINDS` gains `deploy_attest`; `NOTIFICATION_KINDS` gains `parent_ready_for_approval` (feature split: all children verified) and `phase_ready` (phased: next phase unblocked / Contract gate ready).
- Contract-drift goldens: `v25-schema.sql` frozen; fresh v26 == upgraded v26.

## Plan declaration + split rule

The proposed plan (`workflowPlan`) gains `children?: readonly DeclaredChild[]` where
`DeclaredChild = { key, objective, projectId, declaredScope, acceptanceCriteria, phase?, dependsOn?: key[], splitBy?: 'consumer' | 'phase' }`.
Validation (`validate.ts`, next to the plan parsers): `mechanical_sweep` ⇒ no children; `feature` ⇒ children optional, each independently mergeable is asserted by review; `blast_radius` ⇒ children **required**, each with `splitBy`; when any child has a `phase`: exactly one `expand`, ≥1 `migrate`, exactly one `contract`, every migrate depends on the expand, the contract depends on every migrate, the expand/contract project == the parent's project, migrates in other projects; cycles rejected; phases are total (if any child has a phase, every child must; a feature split has none); child scopes within one project must not overlap each other — unphased siblings and `migrate` siblings — **except the Expand/Contract pair**, which is strictly sequenced and by design touches the same interface files (Contract removes what Expand added). *(Amended 2026-08-28, campaign 10 Task 1 fix round: ruling R-T1c/R-T1f; `codex review` read the original sentence literally and asked for Expand/Contract disjointness — rejected, it would make the phased pattern undeclarable.)*

## Runtime behavior

- **Confirm** (parent): validate, create children (`queued`, pre-confirmed plans with the declared node, phase, ordinal), insert dependencies, parent → `coordinating`.
- **Readiness**: the reconciler activates a child only when its dependencies are satisfied (all `merged`; Contract additionally attested); the claim gate's existing scope-overlap serialization applies within a project (C7).
- **Cross-repo context** (C10): when a Migrate child's run is claimed, the board injects `crossRepoContext = { providerProjectId, interfacePath: 'docs/interface.md', sha, markdown }` read from the provider repo at the Expand child's merge sha via the docs-publish `git show` primitive; the engineer prompt (template `engineer` gains an optional section rendered only when present — `config/prompts.md` changes → promptsSha changes, goldens regenerated deliberately) tells the agent to rely on the published interface, never the provider's source.
- **Completion**: feature-split parent → `final_approval` when all children are in `final_approval` (notification `parent_ready_for_approval`); approving merges children in dependency order via the existing per-item merge path and then settles the parent (`settleParentCompletionInTransaction`, `final_approve` without a merge sha, `refId` listing children). Phased parent: Expand/Migrate auto-merge on reaching `final_approval` (recorded `final_approve` with actor `system:parent-plan-authorization`, `refId` = the parent's `plan_confirm` action); after all migrates are merged+attested, `phase_ready` notifies; Contract's own human approval merges it; the parent then settles as above. A child parking parks nothing else; a child abandoned/dead-lettered parks the parent (`park` category `child_failed`) for a human decision.
- **Caps**: a `coordinating` parent has no run and is excluded from wall-clock sweeps (C4 note).
- **Base-branch withdrawal**: unchanged per child; the parent's pending approval is withdrawn if any child's approval is withdrawn.

## UI

Task list groups children under their parent (indent, phase pill, dependency hint "after: Expand"). Work-item detail for a parent: children table (state, phase, project, attest button when merged, "merge order"), the parent's plan gate renders declared children (and the auto-merge pre-authorization line for phased plans), the single **Approve & merge children** action for feature splits, and the Contract child's gate showing attestation status. Uses the anchored Modal/popover surfaces from 9.6.

## Testing

Runtime units per task (contract, migration equivalence, split-rule matrix, readiness, merge order, attestation gate, prompt section rendering with regenerated goldens); web SSR pins; Playwright for the tree and gates with mocked API. **Exit** in `pipeline-e2e.test.ts`: a two-repo fixture (provider + consumer, each with its own agent identities; the fake manager emits a blast-radius plan declaring Expand/Migrate/Contract) — Expand auto-merges after verify/review; Migrate starts only after that, receives the provider's `docs/interface.md` context at the Expand sha, auto-merges; Contract stays blocked until the human attests both deploys, then its human approval merges it; the parent reaches `merged` with a `final_approve` action listing all three.

### Rulings added during implementation (campaign 10 Task 2 review, 2026-08-29)

- **Decomposed parents always go `plan_approval → coordinating`**, whatever their tier, and never receive a branch or base sha. The parent's plan confirm is the human gate at parent level; a hazardous tier is inherited by every child, and each hazardous child runs the existing single-item Design stage itself. *(Why: `designing` has no edge to `coordinating`; a parent-level design doc would duplicate the children's.)*
- **Child plans are leaves**: `changeShape = feature`, tier inherited from the parent (else `standard`), `criterionChecks = []` — a declaration carries acceptance-criteria text only. Follow-up candidate: `DeclaredChild.criterionChecks`.
- **Children are target-locked from creation** and exempt from intake planning (`workItemAwaitsIntakePlanning`); the child's v2 template must pass the executor-drift check at confirm.

### Rulings added during implementation (campaign 10 Task 3 review, 2026-08-29)

- **Merge policy is keyed on phases, not change shape** — a phased declaration follows the auto-merge policy (Expand/Migrate under parent plan authorization, Contract human-gated); any unphased declaration (feature *or* blast-radius) follows the one-parent-approval policy.
- **Individually merged children are tolerated** — the parent is promoted when every child is in `final_approval` or already `merged`; parent approval fans out over the unmerged children only; if the last child merges on its own, the parent settles directly.
- **Contract readiness is transitive over the parent** — every Expand and Migrate sibling must be merged *and* deploy-attested, regardless of declared edges.
- **Policy errors are isolated per parent** — a transient merge error (busy/unavailable repo) waits for the next reconcile pass; a non-transient one leaves the child where the human merge path would; neither can stop the pass for other items.
- **`parked → coordinating`** exists for decomposed parents (after a `child_failed` park). New edges (`queued → designing|implementing`, `coordinating → merged`, `final_approval → coordinating`, `parked → coordinating`) live in the contract table but are contextually guarded: the first pair for children only, the rest for decomposed parents only.
- Gate-action `refId` stays an identifier; the parent's completion action stores no child list (64 children would overflow any inline bound) — completion detail is derived from the children and their own `final_approve` actions.

- **Unphased `dependsOn` is merge order only** — children of an unphased declaration start in parallel (the split rule already requires independent mergeability); the fan-out merges them in dependency order. Phased children keep merge-gated readiness.
- **Delayed same-repo children re-base at first activation** — a phased child's `base_sha` is re-resolved from its project head when it first activates (Contract must see Expand's merge), never from the confirm-time snapshot.
- Project-scoped reconciliation only visits decomposition families touching that project; a transient merge failure on one sibling does not stop independent siblings in the same pass.

- **Automatic merges honour the base-advance guard** — before an Expand/Migrate auto-merge the reconciler runs the same base-advance predicate the base-branch poll uses; an advanced base withdraws the approval instead of merging.
- **Rejecting a decomposed parent** in `final_approval` fans out like approval: every unmerged child in `final_approval` is rejected through its own path with the same note, and the parent returns to `coordinating` (otherwise the next reconcile pass would simply re-promote it). **Resuming a parked decomposed parent** is a work-item-level human action (`resume`) that returns it to `coordinating`.

- **Board pause gates the decomposition policy pass** — no automatic merge, promotion, or settlement while paused.
- **Parent termination cascades down** — abandoning or dead-lettering a decomposed parent cancels every non-terminal child (merged children untouched) in the same transaction.

- **A family touches a project** if the parent's or any child's project matches — one helper for every project-scoped pass. **Any unmerged child leaving `final_approval`** (rejection, base withdrawal) demotes a promoted parent to `coordinating`. **Cancellation retires open machine-verification attempts**, cascaded or not.

- **One level of decomposition** — a child's plan may not declare children. **Resuming a `child_failed` park means proceeding without the failed child — for unphased families only**: abandoned children are excluded from promotion and completion counts (the completion note records them). In a **phased** family an abandoned Expand or Migrate makes the Contract phase unsafe: Contract stays blocked (abandoned never counts as merged+attested), the parent can never complete, and cancelling the parent is the only exit. *(Re-ruled 2026-08-29 after the round-6 review showed a Contract could activate over an abandoned Migrate.)* **Retiring a verification attempt on cancellation stops the verifier and cleans its workspace** — retirement is a terminal outcome of the attempt state machine, not a bookkeeping flag.

- **Publishing the interface is the Expand child's obligation**, enforced at its verification: an Expand whose verified sha lacks a valid `docs/interface.md` fails verification with a finding and goes through the normal fix round — there is no "re-merge" of a merged item. The Migrate readiness block remains only as a residual guard (repository outage, aggregate context budget), with cancellation of the parent as the exit. The interface bound counts toward the run's total context budget; the board validates the markdown (control characters only are rejected) before any run is persisted; only engineer tasks carry the context.

- **The publication check never rewrites a worker's settlement** — the board accepts the verifier's result as submitted and, in the same transaction, records its own publication finding and routes the Expand back to implementation. **Expand and Contract scopes must cover `docs/interface.md`** (validated at settlement and confirm). A symlinked interface is `not_file`.

- **Expand and Contract engineers are authorized to change `docs/interface.md`** — the engineer prompt renders a phase-authorization block for those claims (the published-interface bright line is suspended for that file only); Migrate and ordinary claims keep the bright line.

- **UI rulings (Task 5 review)** — the plan gate shows every declared child's scope and acceptance criteria before confirm (confirmation pre-approves them); the web hides *Resume coordination* for a phased family parked `child_failed` (cancel is the only exit) and offers inline deployment attestation on the parent's children rows; a parent's Children section renders only once a non-empty children list arrives, including for terminal parents.

- **Block-summary precedence** (Task 6 review): a terminal (abandoned/dead-lettered) sibling is reported first, then unmerged predecessors, then unattested ones — the permanent reason wins over the recoverable one; the summary names the sibling's actual terminal state (`abandoned` or `dead_letter`).

## Alternatives considered

- Multi-node plans as parents — rejected: single-node pipeline assertions in three places; nodes have no branch/approval.
- No new state (parent parked in `plan_approval`/`planning`) — rejected: semantic abuse; reconciler/caps would misread it.
- Auto-merging the Contract child — rejected by §9 (irreversible step, human gate regardless of tier).
- Deploy detection via the base-branch poller — rejected as the gate (proves merge, not deploy); kept as a shown precondition.
- Children with their own plan gates — rejected: the parent's approver already approved the decomposition; doubling gates defeats decomposition.
