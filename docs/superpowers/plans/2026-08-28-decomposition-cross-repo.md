# Decomposition + Cross-repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parent/child work items with a work-item-level dependency DAG, plan-declared decomposition with split-rule validation, phase-aware merge policy (feature split: one parent approval; phased cross-repo: auto-merge Expand/Migrate, human-gated Contract after deploy attestation), cross-repo interface context, and the UI — proven by a two-repo e2e arc.

**Architecture:** additive v26 migration; `coordinating` parent state; `work_item_dependencies` mirroring node-dependency readiness; children created pre-confirmed at parent plan confirm; merge policy in the final-approval collaborator; `deploy_attest` gate; interface context injected at claim via the docs-publish `git show` primitive; TaskList grouping + parent detail.

**Tech Stack:** TypeScript/Node 24, SQLite (node:sqlite), node:test, vitest, Playwright. No new deps.

**Spec:** `docs/superpowers/specs/2026-08-28-decomposition-cross-repo-design.md`

## Global Constraints

- Contract enums are single-sourced (`src/shared/task-board-contract/index.ts`) and move with SQL CHECKs, web tone maps, and fixtures together; web enum parsing stays forward-tolerant.
- Migration v25→v26 additive (`store.ts` ladder pattern with `foreign_key_check` + `quick_check`); golden `tests/server/task-board/fixtures/v25-schema.sql` generated via the established mechanism; fresh v26 == upgraded v26 (contract-drift).
- Every merge has a `final_approve` gate action; every child's pre-confirmation writes a `plan_confirm` with `refId` = parent; no path to `merged` without those.
- Scope overlap semantics unchanged; dependency readiness = all deps `merged` (+ attested for Contract).
- Prompt template edits regenerate the goldens deliberately (promptsSha changes are expected and named in the report).
- Gate per task (outside sandbox, quiet machine): `npm run typecheck:all && npm run test:all`; Playwright + container tier at close. Codex implements; controller commits.

---

### Task 1: Contract + schema v26

**Files:** `src/shared/task-board-contract/index.ts` (states + transitions incl. `coordinating`; `WorkItem.parentWorkItemId/phase/childOrdinal`; `WORK_ITEM_PHASES`; `GATE_KINDS`+`deploy_attest`; `NOTIFICATION_KINDS`+2; `DeclaredChild` + `workflowPlan.children`), `validate.ts` (parsers incl. the split-rule matrix), `persistence/store.ts` (v26: work_items columns, `work_item_dependencies`, `projects.repo_path` backfill, CHECK updates), `rows.ts`, `tests/server/task-board/fixtures/v25-schema.sql`, `contract-drift.test.ts`, `tests/shared/task-board-contract/*` (unions/validate matrices), web `data/wire.ts`/`parse.ts` enum arrays + `work-item-labels.ts` tone for `coordinating`.
**Produces:** types + parsers consumed verbatim by later tasks; `projects.repo_path` read by `pipelineSummary`, `base-branch-poll`, `workflow.pipelineBaseSha` (switch the four `description AS repo_path` sites).

### Task 2: Plan declaration → child creation at confirm

**Files:** `collaborators/work-items.ts` / `persistence/workflow.ts` (`confirm()`: validate children, create child work items `queued` with pre-confirmed single-node plans, insert dependencies, parent → `coordinating`, gate actions), `collaborators/work-item-transitions.ts`, HTTP route additions in `service.ts` (children listing on the work item), `tests/server/task-board/board.test.ts` + `collaborators/*` tests.
**Produces:** `listChildren(parentId)`, `dependenciesFor(workItemId)`; children exist and are queued.

### Task 3: Readiness, merge policy, deploy attestation, parent completion

**Files:** reconciler/claim path (`collaborators/projects.ts` node activation gate: child readiness = deps merged/attested), `collaborators/runs.ts` settle: auto-merge for Expand/Migrate reaching `final_approval` under parent authorization, `settleParentCompletionInTransaction`, parent → `final_approval` when feature-split children are all in `final_approval`, fan-out merge in dependency order, `POST /v1/work-items/:id/attest-deploy` (`deploy_attest` gate), child failure parks the parent (`child_failed`), base-branch withdrawal propagation; wall-clock sweep excludes `coordinating`; notifications emitted. Tests for each rule.

### Task 4: Cross-repo interface context

**Files:** `collaborators/runs.ts` claim payload (`crossRepoContext`), a reader in `src/server/task-board/collaborators/interface-context.ts` reusing the docs-publish git primitive (`git show <sha>:docs/interface.md` from the provider `repo_path`), contract type for the claim payload, `config/prompts.md` `engineer` section (conditional render in `agent-envelope.ts`), goldens regenerated (named), tests.

### Task 5: Web — tree + parent detail + gates

**Files:** `TaskList.tsx` grouping (parent rows with indented children, phase pills, dependency hints), `WorkItemDetail.tsx` parent section (children table, attest button, single approve-and-merge-children action, Contract gate status), plan gate renders declared children + the auto-merge pre-authorization line, `data/client.ts` (children/attest routes), `parse.ts`, model/affordances, SSR tests, Playwright (mocked API): tree rendering, parent approval, attest flow, Contract gate blocked/unblocked.

### Task 6: Two-repo e2e exit arc

**Files:** `tests/server/task-board/pipeline-e2e.test.ts` (fixture accepts multiple repos + per-project identities; fake manager emits a blast-radius plan with Expand/Migrate/Contract via `scopeRoutes`-style markers; fake engineer for the consumer asserts the injected interface context), plus a feature-split arc (single repo, two children, one parent approval).

### Task 7: Docs + roadmap

**Files:** `README.md` (parent/child + phases + attest), `docs/WORKFLOW_ARCHITECTURE.md` (decomposition section), roadmap campaign 10 shipped marker.

## Self-review

Spec sections ↔ tasks: data model (T1), declaration+creation (T2), runtime policy+attest+completion (T3), interface context (T4), UI (T5), exit arc (T6), docs (T7). Rulings R1–R4 embedded. Names consistent (`coordinating`, `deploy_attest`, `work_item_dependencies`, `crossRepoContext`, `DeclaredChild`).
