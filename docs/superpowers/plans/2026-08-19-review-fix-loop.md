# Campaign 5 — Review + Fix Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After machine Verify, a reviewer on a different runtime/model emits structured findings; blocking findings drive capped fix rounds (fresh sessions, re-verified before re-review); hazardous plans pass through a Design stage instead of parking; round exhaustion dead-letters.

**Architecture:** The pipeline template grows to `["implementation","testing","verification"]`; the existing stage engine already advances testing-green into `verification` (item state `reviewing`) and restricts that stage to `verifier`-role agent types on their own fleet lane. New: a `review_findings` table written at verification settle with server-derived blocking, a fix-aware item-state mapping (`implementation → fixing` once blocking findings exist), findings injected into fresh fix sessions, a cap of 3 fix rounds via the verification-stage attempt counter, and a Design stage mirroring the planning-task machinery for hazardous-tier plans.

**Tech Stack:** Node 24 / TypeScript, SQLite single-sourced schema (v20 → v21), `node:test` runtime suite, existing collaborator/transaction patterns.

**Spec:** `docs/superpowers/specs/2026-08-19-review-fix-loop-design.md`
**Seam report:** file:line citations below were verified 2026-08-19; re-grep if a line drifted.

## Global Constraints

- **Non-pipeline behavior is untouched.** Multi-node DAG plans, lanes, and every pre-existing test pass UNMODIFIED except where a task names a test to extend. Confirmed v1 pipeline plans (`["implementation","testing"]`) keep flowing through machine verify → `final_approval`.
- **Schema v21 in ONE migration** (Task 1). Later tasks add no schema. Contract stays single-sourced (`src/shared/task-board-contract/index.ts` → SQL CHECKs, validators, web parsers).
- **Forward tolerance:** NEW enum arrays (categories, severities, failure points) are fine; never add members to `WORKFLOW_STAGES`, `WORK_ITEM_STATES`, `WORK_NODE_STATES`, `PLAN_REVISION_STATES` (rebuild migration + strict browser parse). The one `WORK_ITEM_TRANSITIONS` edge addition (`parked → fixing`) is runtime-validated data, not a SQL CHECK.
- **Every work-item state write** goes through `transitionWorkItemInTransaction` (`collaborators/work-item-transitions.ts:79`); every durable write rides `store.transaction` with side effects in `afterCommit`.
- **HTTP conventions** per `service.ts`: regex route + method guard, named parser in `schema.ts` delegating to shared validators, `TaskBoardError` codes registered in `TASK_BOARD_ERROR_CODES`, human-vs-agent auth per route, `version`/`expectedState` guards.
- **Git safety:** array-args `execFile`, no shell, `-c core.fsmonitor= -c core.hooksPath=`.
- **No new npm dependencies.** Runtime tests are `node:test` under `tests/`, compiled; inner loop `npm run verify:fast -- --base HEAD`; gate `npm run typecheck:runtime && npm run test:runtime`.
- **Exit codes, error-code strings, and park/handoff reason strings are contracts** — copy verbatim from this plan.
- **RESULT_SCHEMA structured fields** (Tasks 4, 5) must be added to ALL SIX exact-key sites or settles hard-fail: envelope `required` (`agent-envelope.ts:150-152`), `structuredOutcome` expected-keys (`agent-envelope.ts:468-482`), worker settle exact list (`validate.ts:2247`), `parseBoardSettle` exact list (`validate.ts:2698-2705`), `AgentRunOutcome` (`task-worker/types.ts:165-174`), `SettleAgentRunRequest` (`task-worker/types.ts:238-245`). Follow the conditional pattern `...("handoff" in item ? ["handoff"] : [])`.
- **Sandbox note (Codex):** loopback only, no Docker. Steps marked **[orchestrator verify]** run later. The controller stages and commits; leave the tree dirty. Do not commit.

## File Map (created/modified per task)

| Task | Server | Contract/Schema | Web | Tests |
| --- | --- | --- | --- | --- |
| 1 schema+types | persistence/store.ts (v21) | index.ts, validate.ts | data/parse.ts projection | contract, drift/migration |
| 2 template v2 | persistence/workflow.ts, collaborators/runs.ts, agent-envelope.ts (intake prompt) | pipelineTemplateShape | — | predicate, settle, serial guard |
| 3 review ctx | workflow.ts (claimContext), new collaborators/pipeline-inspection.ts, runs.ts (claim), scoped-launcher.ts, agent-envelope.ts (reviewer prompt) | review block types; workspace-key allow-list | — | context, launcher, prompt, conflict |
| 4 findings+fix | workflow.ts (settle, setWorkItemStage), work-item-transitions.ts, agent-envelope.ts (fixer prompt) | reviewFindings in schema/settle ×6 | — | settle semantics, fix loop, cap |
| 5 design stage | collaborators/work-items.ts, runs.ts, workflow.ts (confirm), agent-envelope.ts (designer prompt) | designRecord in schema/settle ×6; design claim flag | — | design flow |
| 6 web | service.ts/projects.ts (summary) | PipelineSummary fields | WorkItemDetail.tsx, client.ts, parse.ts, model | web vitest |
| 7 e2e+roadmap | — | — | — | pipeline e2e arcs; roadmap edit |

---

### Task 1: Schema v21 — findings, design records, design tasks, contract types

**Files:**
- Modify: `src/shared/task-board-contract/index.ts`, `src/shared/task-board-contract/validate.ts`
- Modify: `src/server/task-board/persistence/store.ts` (SCHEMA_VERSION 20 → 21, tables, migration)
- Modify: `src/web/task-board/data/parse.ts` (loose read projections only)
- Test: `tests/shared/task-board-contract/` (round-trips, validation), `tests/server/task-board/contract-drift.test.ts` (v21 migration; freeze `tests/server/task-board/fixtures/v20-schema.sql` following the v19 fixture pattern at `contract-drift.test.ts:72-107`)

**Interfaces — Produces (every later task consumes these exact names):**

```typescript
export const REVIEW_FINDING_CATEGORIES = ["correctness", "security", "plan_deviation", "test_modification", "docs", "style", "other"] as const;
export const REVIEW_FINDING_SEVERITIES = ["minor", "major", "critical"] as const;
export const BLOCKING_REVIEW_FINDING_CATEGORIES = ["correctness", "security", "plan_deviation"] as const;
export type ReviewFindingCategory = typeof REVIEW_FINDING_CATEGORIES[number];
export type ReviewFindingSeverity = typeof REVIEW_FINDING_SEVERITIES[number];
export function reviewFindingBlocks(category: ReviewFindingCategory): boolean; // BLOCKING_REVIEW_FINDING_CATEGORIES membership
export interface ReviewFindingDraft {
  readonly file?: string | null;      // 1..512, no control chars, no leading "/"
  readonly line?: number | null;      // integer >= 1
  readonly category: ReviewFindingCategory;
  readonly severity: ReviewFindingSeverity;
  readonly expected: string;          // 1..2000
  readonly actual: string;            // 1..2000
}
export interface ReviewFinding extends ReviewFindingDraft {
  readonly findingId: string; readonly nodeId: string; readonly stage: WorkflowStage;
  readonly round: number; readonly blocking: boolean; readonly createdAt: string;
}
export const DESIGN_FAILURE_POINTS = ["crash_before_send", "crash_after_send_before_response", "crash_after_response_before_commit", "crash_after_commit_before_ack", "duplicate_delivery", "concurrent_invocation"] as const;
export type DesignFailurePointKind = typeof DESIGN_FAILURE_POINTS[number];
export interface DesignTransition { readonly from: string; readonly to: string; readonly durablePrecondition?: string; readonly recovery?: string } // from/to 1..200; optional 1..1000
export interface DesignFailurePoint { readonly point: DesignFailurePointKind; readonly resultingState: string; readonly recovery: string } // 1..500 / 1..1000
export interface DesignIdempotencyKey { readonly name: string; readonly generatedAt: string; readonly persistedAt: string; readonly reuse: string } // each 1..500
export interface DesignFaultInjectionCase { readonly name: string; readonly scenario: string; readonly expectation: string } // 1..200 / 1..1000 / 1..1000
export interface DesignRecordDraft {
  readonly states: readonly string[];                       // 1..64 × 1..200
  readonly transitions: readonly DesignTransition[];        // 1..128
  readonly failurePoints: readonly DesignFailurePoint[];    // 6..32; EVERY member of DESIGN_FAILURE_POINTS must appear at least once
  readonly idempotencyKeys: readonly DesignIdempotencyKey[];      // 0..32
  readonly faultInjectionCases: readonly DesignFaultInjectionCase[]; // 0..32
}
export interface DesignRecord extends DesignRecordDraft { readonly designRecordId: string; readonly workItemId: string; readonly planRevisionId: string; readonly createdAt: string }
```

New `TASK_BOARD_ERROR_CODES` members (exact strings): `TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED`, `TASK_BOARD_REVIEW_FINDINGS_REQUIRED`, `TASK_BOARD_REVIEW_OUTCOME_MISMATCH`, `TASK_BOARD_REVIEW_RUNTIME_CONFLICT`, `TASK_BOARD_DESIGN_RECORD_REQUIRED`, `TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED`.

**Tables** (in the base DDL AND `migrateVersion20To21`; category/severity CHECKs via `sqlStringList` on the contract arrays, `store.ts:31-33` pattern):

```sql
CREATE TABLE IF NOT EXISTS review_findings (
  finding_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN (<WORKFLOW_STAGES>)),
  round INTEGER NOT NULL,
  file TEXT NULL, line INTEGER NULL,
  category TEXT NOT NULL CHECK (category IN (<REVIEW_FINDING_CATEGORIES>)),
  severity TEXT NOT NULL CHECK (severity IN (<REVIEW_FINDING_SEVERITIES>)),
  expected TEXT NOT NULL, actual TEXT NOT NULL,
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS design_records (
  design_record_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(plan_revision_id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS work_item_design_tasks (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
```

- Validators in `validate.ts`: `parseReviewFindingDraft` (server strict; reject unknown category/severity, control chars, out-of-bounds), `parseDesignRecordDraft` (enforce the every-failure-point-covered rule; error message names the first missing point, e.g. `design record missing failure point: duplicate_delivery`). Browser: extend loose read projections in `parse.ts` for `ReviewFinding` and `DesignRecord` (tolerant, ignore-unknown).
- Migration: `migrateVersion20To21(db)` creating the three tables, wired into the ladder (`store.ts:1226-1289`); bump `SCHEMA_VERSION` to 21 (`store.ts:29`).
- Drift test: freeze `fixtures/v20-schema.sql` from the current v20 DDL; add a v20→v21 replay case following the v19→v20 case (`contract-drift.test.ts:153-219`); update the frozen-projection filters so older fixtures still project (pattern at `:72-96`); assert the new CHECK clauses byte-match the contract arrays (pattern at `:109-151`).

Steps: failing contract tests (round-trip a finding draft and a design record; reject: unknown category, `blocking` supplied by caller [server derives it], failure-point set missing one member, 65 states, control chars) → implement → pass (`npm run verify:fast -- --base HEAD`; gate `npm run test:runtime`). Commit (controller): `feat: review findings, design records, design tasks (schema v21)`.

---

### Task 2: Pipeline template v2 — shared predicate, final-gate routing, serial guard

**Files:**
- Modify: `src/shared/task-board-contract/index.ts` (predicate + one transition edge)
- Modify: `src/server/task-board/persistence/workflow.ts` (predicates :77-89, propose rule :221-240, drift guard :91-97/:403/:430, last-stage settle :1163-1200, serial guard :99-116)
- Modify: `src/server/task-board/collaborators/runs.ts` (settle predicate :606-624)
- Modify: `src/server/agents/task-worker/agent-envelope.ts` (intake planning instructions, ~:287-291)
- Test: `tests/shared/task-board-contract/` predicate; `tests/server/task-board/` settle integration + serial guard (extend existing files where the v1 cases live)

**Interfaces — Produces:**

```typescript
// contract index.ts — single source for all predicate call sites
export function pipelineTemplateShape(template: readonly WorkflowStage[]): "v1" | "v2" | null;
// v1 = exactly ["implementation","testing"]; v2 = exactly ["implementation","testing","verification"]; else null
```

**Behavior:**

- Replace `pipelineShaped` (`workflow.ts:77-82`) and the inline `runs.ts:606-608` duplicate with `pipelineTemplateShape(...) !== null`; `storedPlanHasPipelineShape` (`workflow.ts:84-89`) likewise accepts v1 or v2 (confirmed legacy plans keep flowing).
- **Propose-time rule:** NEW pipeline proposals must be v2 — in the planning-settle branch (`runs.ts:606-624`), a v1-shaped plan now 400s `TASK_BOARD_PIPELINE_PLAN_INCOMPLETE` with detail `pipeline plans must end in a verification stage (template ["implementation","testing","verification"])`. Remove the `machineVerifiedTesting` carve-out from the template rule (`workflow.ts:221, :231-240`) — v2 ends in `verification`, satisfying the base rule; the error message drops its carve-out clause. Delete `testingStageUsesMachineVerify` only if no longer referenced (the confirm drift guard still needs it — see next bullet).
- **Executor drift guard** (`pipelineExecutorDrift`, `workflow.ts:91-97`, thrown :403/:430): for a v2 plan, require `testing → machine_verify` AND `verification → enabled agent_type`; for stored v1 plans keep the existing testing-only check.
- **Last-stage settle routing** (`settleAttemptInternal` PASS-last branch, `workflow.ts:1163-1200`): mirror the machine-verify path (`:980-989`) — `to: attempt.pipeline_branch !== null ? "final_approval" : "merged"` (`pipeline_branch` is already selected at `:1046`). `reviewing → final_approval` is legal (`index.ts:214`).
- **Serial guard** (`workflow.ts:99-116`): state list becomes `('implementing','verifying','reviewing','fixing','designing','final_approval','parked')`.
- **Transition edge:** add `"fixing"` to `WORK_ITEM_TRANSITIONS.parked` (`index.ts:~226`), with the same style of comment as its neighbors: `// campaign 5: unparked fix-round items re-enter the fix loop`.
- **Intake prompt** (`agent-envelope.ts` planning instructions): the pipeline-plan sentence changes from `stageTemplate ["implementation","testing"]` to `stageTemplate ["implementation","testing","verification"]` — Implement, machine Verify, then an independent review.

Tests: predicate unit table (v1/v2/null incl. wrong order, duplicates, extra stages); integration — a v2 plan proposes/confirms cleanly, `pipeline_branch`/`base_sha` set; a v1 proposal 400s naming the template; an agent `verification` settle passing on the last stage of a pipeline plan lands `final_approval` NOT `merged` (drive with a stub verifier agent settle: outcome completed, handoff passed — findings arrive in Task 4); non-pipeline multi-node plan still lands `merged`; serial guard 409s while a first item sits in `reviewing`. Commit (controller): `feat: pipeline template v2 with reviewer stage routing and widened serial guard`.

---

### Task 3: Review claim context, derived workspace, runtime conflict, reviewer prompt

**Files:**
- Create: `src/server/task-board/collaborators/pipeline-inspection.ts` (factored git block)
- Modify: `src/server/task-board/collaborators/projects.ts` (pipelineSummary delegates, :191-319), `src/server/task-board/persistence/workflow.ts` (claimContext :325-395), `src/server/task-board/collaborators/runs.ts` (claim: areaMemory suppression :769-785, runtime-conflict check, claim insert :329-380)
- Modify: `src/shared/task-board-contract/index.ts` (review block type; workflow exact-field lists `validate.ts:1493`, `:1898`; workspace-key allow-list `validate.ts:1764`), `src/server/agents/task-worker/types.ts` (mirror), `src/server/agents/task-workspace/scoped-launcher.ts`, `src/server/agents/task-worker/agent-envelope.ts` (reviewer prompt)
- Test: `tests/server/task-board/` claim-context integration; `tests/server/agents/` scoped-launcher + envelope units

**Interfaces — Produces:**

```typescript
// contract — inside the claim context workflow block, sibling of pipeline:
export interface WorkflowReviewContext {
  readonly commits: readonly { sha: string; subject: string }[];
  readonly diffstat: string;
  readonly filesTouched: readonly { path: string; status: "added" | "modified" | "deleted" }[];
  readonly scopeOk: boolean;
  readonly midRunAssumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly criterionChecks: readonly PlanCriterionCheck[];
  readonly priorFindings: readonly ReviewFinding[];
}
// workflow block gains: review?: WorkflowReviewContext | null  (set for pipeline verification-stage claims; null otherwise)
// pipeline-inspection.ts:
export function inspectPipelineBranch(options: { repoPath: string; baseSha: string; branch: string; declaredScope: readonly string[]; git?: GitRunner }): Promise<{
  commits: readonly { sha: string; subject: string }[]; diffstat: string;
  filesTouched: readonly { path: string; status: "added" | "modified" | "deleted" }[]; scopeOk: boolean;
}>;
```

**Behavior:**

- `pipeline-inspection.ts`: hoist the git block from `pipelineSummary` (`projects.ts:225-251`) — `git log --format=%H%x00%s -z`, `git diff --stat`, and name-status via `git -c core.fsmonitor= -c core.hooksPath= -C <repo> diff --no-renames --name-status -z <base>..<branch> --` (statuses A/M/D map to added/modified/deleted); scope check reuses `checkDeclaredScope` prefix logic on the path list. `pipelineSummary` delegates (its `filesTouched: string[]` projection derives from the name-status paths — response shape unchanged until Task 6).
- `claimContext` (`workflow.ts:389-394`): for pipeline claims with `stage === "verification"`, return `workspaceKey: `${workItemId}-review`` and a populated `review` block (mid-run assumptions via the existing extraction `projects.ts:262-300` factored to be callable here; acceptance criteria + criterionChecks from the confirmed revision; priorFindings from `review_findings` for the node, all rounds ascending). Other pipeline stages unchanged.
- Workspace-key allow-list (`validate.ts:1764`): accept `<branchKey>`, `<branchKey>-verify`, `<branchKey>-review`.
- `WorkspaceScopedLauncher` (`scoped-launcher.ts:14-16, 24-49`): when the workspace key ends in `-review`, call the three-arg `create(key, baseSha, branchKey)` with `branchKey` = the key minus the suffix, and on ANY completion skip `harvest` (remove on completed, retain otherwise — mirroring machine verify's retention semantics at `verify-attempts.ts:576-577`).
- **areaMemory suppression:** in `claimResult` (`runs.ts:769-785`), return `[]` whenever the claim carries a non-null `workflow?.pipeline`.
- **Runtime conflict:** in the claim path (`runs.ts` claim, insert at :364-379): when the claimed task is a pipeline `verification` stage attempt, load the latest run row of the node's most recent `implementation`-stage attempt (join `stage_attempts` → `tasks` → `runs`, latest by created_at); if BOTH that row's `(runtime, model)` and `request.pinned`'s `(runtime, model)` are fully non-null and equal → throw 409 `TASK_BOARD_REVIEW_RUNTIME_CONFLICT` with message `review runtime matches implement runtime (<runtime>/<model>) — configure a different reviewer lane`, and write a board event (same event helper the settle paths use) so the stall is visible. Missing pinning on either side → allow (old workers), no event.
- **Reviewer prompt** (`agent-envelope.ts`, sibling of `pipelineImplementation` :272-275, gated `fixedRole === "verifier" && stage === "verification" && pipeline != null`), verbatim block:
  "Pipeline review on branch ${branch}. You are reviewing the diff against the approved plan — injected below — never the implementer's reasoning. Review depth follows change shape (${changeShape}): spot-check a mechanical sweep; read feature work line by line; review a blast-radius change per consumer. Check in order: (1) files touched vs declared scope — pre-computed as scopeOk=${scopeOk}, files below; (2) each acceptance criterion actually met in the code; (3) docs updated in the same diff where the plan requires; (4) any modified or deleted existing test — emit a test_modification finding for each unless the plan's mechanicalPortions declared it. For hazardous tier, trace each failure point in the design record to the line that guarantees it. Emit reviewFindings [{file, line, category, severity, expected, actual}]; categories correctness|security|plan_deviation block, others do not. If any blocking finding exists return handoff outcome failed with recommendedReturnStage implementation; otherwise outcome passed. Do not edit the workspace."
  Render the `review` block data (commits, diffstat, files with status, assumptions, criteria, prior findings) and `pipeline.designRecord` when present into the prompt below the block.

Tests: launcher unit — `-review` key clones the branch into an isolated dir, never harvests (commit in engineer workspace → harvest → review create → completion → source repo branch unchanged); claim-context integration — verification-stage claim carries review block + `-review` workspaceKey, implementation claim carries neither; areaMemory empty for pipeline claims, unchanged for others; runtime-conflict — equal pinned pairs 409 + event, differing model claims fine, absent pinning claims fine; envelope snapshot for the reviewer prompt. Commit (controller): `feat: reviewer claim context, derived review workspace, runtime-conflict guard`.

---

### Task 4: Findings settle and the fix loop

**Files:**
- Modify: `src/server/agents/task-worker/agent-envelope.ts` (RESULT_SCHEMA + fixer prompt), `src/shared/task-board-contract/validate.ts` (settle exact lists :2247, :2698-2705 + `parseReviewFindingDraft` wiring), `src/server/agents/task-worker/types.ts` (:165-174, :238-245)
- Modify: `src/server/task-board/persistence/workflow.ts` (settleAttemptInternal :1030-1204; setWorkItemStage :1212-1248; claimContext fix block + retry evidence :375-387), `src/server/task-board/collaborators/work-item-transitions.ts` (:33-38)
- Test: `tests/server/task-board/` settle semantics + fix-loop integration; envelope units

**Interfaces — Produces:**

```typescript
// RESULT_SCHEMA + settle payloads gain (optional):
reviewFindings?: readonly ReviewFindingDraft[];   // ≤64
// claim context workflow block gains: fix?: { round: number; findings: readonly ReviewFinding[] } | null
// work-item-transitions.ts:
export function workItemStateForStage(stage: WorkItemStage | null, options?: { fixLoop?: boolean }): WorkItemState;
// implementation + fixLoop → "fixing"; all existing mappings otherwise unchanged
```

**Behavior:**

- `RESULT_SCHEMA` gains `reviewFindings` (array ≤64 of the draft shape, enums inline, bounds per Task 1); wire ALL SIX exact-key sites (Global Constraints).
- **Settle semantics** in `settleAttemptInternal`, only when the attempt is a pipeline `verification` stage:
  - `reviewFindings` present on any other stage/plan → 400 `TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED`.
  - Derive `blocking = reviewFindingBlocks(category)` per finding; persist ALL findings to `review_findings` in the settle transaction with `round = attempt.attempt`.
  - Consistency gates (before any state change): handoff `passed` but ≥1 derived-blocking finding → 400 `TASK_BOARD_REVIEW_OUTCOME_MISMATCH`; handoff `failed` but zero blocking findings → 400 `TASK_BOARD_REVIEW_FINDINGS_REQUIRED`; a failed review's `recommendedReturnStage` is forced to `"implementation"` regardless of what the agent sent.
  - **Cap:** in the FAIL branch (`:1120-1153`), the re-arm threshold becomes `const maxAttempts = stage === "verification" && attempt.pipeline_branch !== null ? 4 : 3;` — replace both the `attemptNumber < 3` re-arm condition and the `attemptNumber >= 3` dead-letter condition with `maxAttempts`. Retry event text keeps its `(attempt N+1 of ${maxAttempts})` arithmetic.
- **Fix-aware mapping:** `setWorkItemStage` (`workflow.ts:1212-1248`) computes `fixLoop = stage === "implementation" && EXISTS(SELECT 1 FROM review_findings WHERE node_id = ? AND blocking = 1)` and passes it through. Verify the machine-verify settle path (`:897-931`) and the agent FAIL/PASS branches all route through `setWorkItemStage` so the mapping applies everywhere; `rejectFinalApprovalInTransaction` (`:692-715`) switches its hardcoded `implementing` target to the same mapping (legal: `final_approval → fixing`).
- **Findings reach the fixer:** retry-evidence seam (`:375-387`) extends its handoff IN-list to `('implementation','testing','verification')`; claimContext populates `fix` for implementation-stage pipeline claims when blocking findings exist: `round` = max persisted round, `findings` = that round's blocking findings plus non-blocking from the same round.
- **Fixer prompt** (`agent-envelope.ts`, replaces the plain pipeline-implementation block when `workflow.fix` is non-null), verbatim:
  "Fix round ${round} on branch ${branch}. A reviewer found the defects below; the diff is on the branch. Fix each finding, then re-trace the whole flow end to end — not just the patch. Loop: run `npm run verify:fast`, read the failure, fix; repeat until green. Run `npm run verify:area` once before finishing. Commit in staged logical units. The declared scope, non-goals, and BRIGHT_LINE rules from the original task still apply verbatim."
  followed by the rendered findings and the original bright-line block.
- Machine Verify already re-runs before re-review from stage order (`fixing → verifying` legal; testing precedes verification in the template) — add no code, add a test.

Tests: green review (passed, zero findings) → `final_approval`; passed + non-blocking findings → `final_approval` with findings persisted; failed + blocking finding → item `fixing`, node ready@implementation, next claim carries `fix` block with the findings; mismatch cases 400 with exact codes; findings on an implementation settle → `TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED`; full loop — fix commit → machine verify green → review round 2 passes → `final_approval`; cap — blocking reviews at rounds 1,2,3 re-arm, round 4 → `dead_letter` with `endedAt` set and `currentStage` null; fix-round implementation retry keeps item in `fixing` (same-state write); mapping unit table. Commit (controller): `feat: structured review findings settle and capped fix loop`.

---

### Task 5: Design stage for the hazardous tier

**Files:**
- Modify: `src/server/task-board/collaborators/work-items.ts` (design-task machinery beside :207-320), `src/server/task-board/collaborators/runs.ts` (design claim flag :792-795; design settle branch beside :596-666), `src/server/task-board/persistence/workflow.ts` (confirm :417-500, hazardous branch :466-478; base-sha :397-415; design-result helper beside :736-745)
- Modify: `src/server/agents/task-worker/agent-envelope.ts` (RESULT_SCHEMA designRecord + designer prompt), `src/shared/task-board-contract/index.ts` + `validate.ts` (context `design` flag; settle exact lists; `WorkflowPipelineContext.designRecord`), `src/server/agents/task-worker/types.ts`
- Test: `tests/server/task-board/` design-flow integration; envelope units

**Interfaces — Produces:**

```typescript
// RESULT_SCHEMA + settle payloads gain (optional):
designRecord?: DesignRecordDraft;
// claim context gains: design: boolean          (sibling of intake; true iff task ∈ work_item_design_tasks)
// WorkflowPipelineContext gains: designRecord?: DesignRecordDraft | null   (injected for ALL pipeline stage claims of a hazardous item once persisted)
```

**Behavior:**

- **Confirm** (`workflow.ts:466-478` replacement): `tier === "hazardous"` AND the plan is pipeline-shaped → compute base sha (remove the hazardous bypass at `:404`), set `pipeline_branch`/`base_sha`, do NOT activate nodes, transition `plan_approval → designing` (actor = the confirming human, `currentStage: "planning"`), create the design task in the same transaction, return `outcome: "designing"` (extend the confirm response union additively; the old `"parked_hazardous"` value stays for non-pipeline). Hazardous NON-pipeline plans keep parking with the new result string `hazardous tier requires a pipeline plan`.
- **Design task machinery** (`work-items.ts`): `startWorkItemDesignInTransaction(workItemId)` mirroring `startWorkItemPlanningInTransaction` (`:207-320`) — manager identity via `createLazyManagerInTransaction`, task title `Design workflow: ${workItem.title}`, objective = the confirmed plan record rendered as JSON + the raw request, `INSERT INTO work_item_design_tasks`, wake after commit. No revision loop, no orphan repair.
- **Claim flag:** `design: true` iff the claimed task is in `work_item_design_tasks` (pattern at `runs.ts:792-795`); replay backfill defaults `false` (pattern `:841-853`); mirror through `http-board-client.ts:421-428` and `BoundedAgentContext`.
- **Design settle branch** (`runs.ts`, sibling of the planning branch, keyed on design-task membership): completed run without a valid `designRecord` → 400 `TASK_BOARD_DESIGN_RECORD_REQUIRED` (validator's message names the first gap); valid → persist `design_records` row (work item + confirmed revision), activate dependency-free nodes ready at `stage_template[0]` (reuse the confirm-tail logic `workflow.ts:479-498`), transition `designing → implementing`, record the design result on the design task (new helper sibling of `recordPlanningResult` throwing `TASK_BOARD_DATABASE_CORRUPT:work_item_design_task_missing`). `designRecord` on a non-design task → 400 `TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED`. Non-completed design run → park, mirroring the planning park (`runs.ts:724-745`).
- **Injection:** claimContext populates `pipeline.designRecord` from `design_records` for every pipeline stage claim of the item (null when absent). Implement/fix prompts append, when non-null: "This is a hazardous-tier task. Design record below. Write each fault-injection case as a test." Reviewer prompt already handles it (Task 3).
- **Designer prompt** (gated `context.design === true`), verbatim:
  "Produce the design record for the approved plan below — return it as designRecord. Required: states and legal transitions (for each transition crossing a process or network boundary, what is durably recorded before the boundary and the recovery); a failure-point table covering all six points (crash_before_send, crash_after_send_before_response, crash_after_response_before_commit, crash_after_commit_before_ack, duplicate_delivery, concurrent_invocation) with resulting state and recovery for each; idempotency-key lifecycle (where generated, persisted, how reused); fault-injection cases that the implementer will write as tests. Standing prohibitions: locks are an optimization to reduce duplicate work, never the correctness boundary — correctness comes from conditional writes whose affected-row count resolves the race; unknown outcome is a distinct state, never collapsed into failure, resolved by querying the remote, never by assuming; idempotency keys are generated once, persisted with the intent record, reused verbatim on retry; timer, cleanup, and retry paths are participants in the state machine and appear in the transition table. Never write code."
- **RESULT_SCHEMA:** add `designRecord` (object schema mirroring Task 1 bounds); wire ALL SIX exact-key sites.

Tests: hazardous pipeline confirm → `designing`, branch/baseSha set, design task exists, response `outcome: "designing"`; design settle with a complete record → `design_records` row, nodes ready, item `implementing`; missing failure point → 400 naming it; designRecord on an engineer task → `TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED`; failed design run → `parked`; hazardous non-pipeline confirm → parked with the new string; subsequent implementation claim carries `pipeline.designRecord`. Commit (controller): `feat: design stage for hazardous pipeline plans`.

---

### Task 6: Web — findings, design record, widened gates

**Files:**
- Modify: `src/server/task-board/collaborators/projects.ts` (pipelineSummary :191-319), `src/shared/task-board-contract/index.ts` (`PipelineSummary` :433-444) + `validate.ts` (:1051-1094)
- Modify: `src/web/task-board/views/WorkItemDetail.tsx`, `src/web/task-board/data/client.ts`, `src/web/task-board/data/parse.ts`, `src/web/task-board/model/work-item-detail.ts`
- Test: web vitest beside the existing WorkItemDetail tests

**Interfaces — Produces:** `PipelineSummary` gains `findings: readonly ReviewFinding[]` (all rounds ascending) and `designRecord: DesignRecordDraft | null`.

**Behavior:**

- Server: `pipelineSummary` joins `review_findings` (via the item's plan nodes) and `design_records`; loose web parser extended (`parsePipelineSummary`), old tabs ignore the new fields.
- `WorkItemDetail.tsx`: summary fetch gate (`:544-564`) widens from `state === 'final_approval'` to `['reviewing','fixing','final_approval'].includes(state)`; new `ReviewFindingsPanel` — findings grouped by round, blocking ones badged with category+severity, file:line shown when present; new `DesignRecordDetails` — states, transitions table, failure-point table, idempotency keys, fault-injection cases — rendered whenever `designRecord` is non-null; the hazardous confirm banner (`:226-231`) text changes to `Hazardous tier: confirming enters the Design stage before implementation.`; `StatusTimeline` buckets (`:63-107`) place `designing` with the planning-side phases and `reviewing`/`fixing` with the execution phases.
- `client.ts`/`model`: no new endpoints; affordances unchanged (both gates already keyed on states).

Tests (vitest): summary parser round-trips the new fields and tolerates their absence; findings panel renders rounds and blocking badges; design record section renders the failure-point table; banner text for hazardous plans; fetch gate fires in `reviewing`. Commit (controller): `feat: findings and design record surfaced in work-item detail`.

---

### Task 7: Exit-criterion e2e + roadmap

**Files:**
- Modify: `tests/server/task-board/pipeline-e2e.test.ts` (extend fixtures + arcs), `orchestrator-roadmap.md`
- **[orchestrator verify]** full gate after commit

**Behavior — extend the existing fixture set** (`pipeline-e2e.test.ts`: fakeCodex :112-124, manager stub :126-179, engineer stub :181-231, fixture repo :233-261, config :314-322, driveVerify :507-540):

1. Manager stub returns the v2 template `["implementation","testing","verification"]`; automation config adds `verification: { kind: "agent_type", agentTypeId: <verifier type> }` (helper `automationStages`, `helpers.ts:83-102`) plus a verifier-role agent type; a third lane (fake CLI, `model: "fake-reviewer"` — provider may be `codex` with a distinct model, exercising the pinned-pair comparison) and third `TaskWorker`.
2. Reviewer stub: reads its run counter; round 1 emits `reviewFindings: [{ file: "src/feature.txt", category: "correctness", severity: "major", expected: "no SEEDED_DEFECT marker", actual: "marker present" }]` + handoff failed; round 2 emits zero findings + handoff passed.
3. Engineer stub `EngineerMode` gains `"seeded_defect"`: initial commit writes `SEEDED_DEFECT` into an in-scope file (passes machine Verify — the fixture verify contract doesn't look at it); on a fix-round claim (detect via the `fix` block rendered in the prompt, dumped like `prompt-<n>.txt` :479-482), commit the fix removing the marker.
4. **Seeded-defect arc (exit criterion):** request → plan → confirm → implement (defect) → machine verify green → review round 1 blocking → `fixing` (assert findings in claim context and DB) → fix commit → verify green again → review round 2 passed → `final_approval` → approve-merge → `merged`; assert `review_findings` holds both rounds and the fixture main contains the fixed file. Human clicks only confirm + approve.
5. **Dead-letter arc:** reviewer stub always-blocking → rounds 1–3 re-arm, round 4 → `dead_letter`.
6. **Hazardous arc:** manager returns `tier: "hazardous"`; confirm → `designing`; a designer stub (manager lane, `design: true` claim) returns a complete `designRecord`; item → `implementing`; assert the engineer prompt dump contains the design record; flow to `merged`.
7. Roadmap: campaign 5 lead-in → `*(shipped <date>; §4; item 5)*`.

**[orchestrator verify]** `npm run typecheck:all && npm run test:all` plus a background `verify:full` to green. Commit (controller): `test: campaign 5 exit-criterion e2e — seeded defect caught, fixed, re-verified`.

---

## Deferred (do not build)

Findings/park ledger views + category analytics (C6); park lifecycle (C6); `reviewing → planning` auto-replan; scheduling/webhooks/concurrency (C7); GitHub slice; second real runtime adapter (C8); prompts-SHA feeding; real-model review quality assertions.
