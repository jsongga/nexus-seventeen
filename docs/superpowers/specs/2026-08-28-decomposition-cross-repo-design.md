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
Validation (`validate.ts`, next to the plan parsers): `mechanical_sweep` ⇒ no children; `feature` ⇒ children optional, each independently mergeable is asserted by review; `blast_radius` ⇒ children **required**, each with `splitBy`; when any child has a `phase`: exactly one `expand`, ≥1 `migrate`, exactly one `contract`, every migrate depends on the expand, the contract depends on every migrate, the expand/contract project == the parent's project, migrates in other projects; cycles rejected; child scopes within one project must not overlap each other (they'd serialize anyway, but overlap contradicts "independently mergeable").

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

## Alternatives considered

- Multi-node plans as parents — rejected: single-node pipeline assertions in three places; nodes have no branch/approval.
- No new state (parent parked in `plan_approval`/`planning`) — rejected: semantic abuse; reconciler/caps would misread it.
- Auto-merging the Contract child — rejected by §9 (irreversible step, human gate regardless of tier).
- Deploy detection via the base-branch poller — rejected as the gate (proves merge, not deploy); kept as a shown precondition.
- Children with their own plan gates — rejected: the parent's approver already approved the decomposition; doubling gates defeats decomposition.
