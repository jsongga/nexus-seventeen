# Contract Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `src/shared/task-board-contract` the single source of truth for wire types and protocol constants on both the server and the browser, so server-side changes break the web build instead of failing silently at runtime.

**Architecture:** The contract gains `as const` arrays for each wire union, with the existing types derived from them — type-identical, so the 10 server importers are unaffected. The web app reaches the contract *at source* through a new `@shared/*` alias (Vite + tsconfig), while the server keeps its existing `#shared/*` subpath imports that resolve to `build/`. Web's local wire types and duplicated constants are then deleted in favour of contract imports, and `client.ts` is split last, once the deletions have shrunk it.

**Tech Stack:** TypeScript 5.7 (`moduleResolution: "Bundler"` for web, `NodeNext` for runtime), Vite 6, Vitest 4 (web), `node --test` (runtime), React 19.

## Global Constraints

- **Do not change the view-model layer.** `TaskStatus`, `AgentStatus`, `RunStatus` in `src/web/task-board/types.ts` are a deliberate projection (`idle→sleeping`, `in_progress→running`, `waiting_for_human` derived from `hasOpenQuestion`). They stay exactly as they are. Only *wire* types move to the contract.
- **Name collision is real.** `TaskStatus`, `AgentStatus`, and `RunStatus` exist in both `types.ts` (view) and the contract (wire) with different members. Every contract import of these MUST be aliased `as Wire*`. An unaliased import will compile against the wrong type.
- **Contract name differences:** web `WakeReason` = contract `WakeupReason`; web `AutomationEvaluatorProfile` = contract `AgentTypeEvaluatorProfile`. Keep the web-facing names as local aliases; do not rename view types.
- **Server must stay untouched.** No edits under `src/server/`. Verify with `git diff --stat src/server` after each task — it must be empty.
- **Commit style:** Conventional Commits, and every commit ends with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Comment dense logic or wrap it in a named util.** Prefer a well-named function over a comment where a name removes the need for prose.
- Verification commands: `npm run typecheck:all`, `npm run test:web`, `npm run test:runtime`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/task-board-contract/index.ts` | *Modify.* Add `as const` union arrays; derive existing types from them. |
| `vite.config.ts` | *Modify.* `resolve.alias` for `@shared/*` → `src/shared/*`. |
| `tsconfig.app.json` | *Modify.* Matching `paths` entry. |
| `src/web/task-board/wire.ts` | *Create.* The web's single doorway to the contract: re-exports wire types under web-facing names, and the validator `Set`s built from contract arrays. |
| `src/web/task-board/parse.ts` | *Create.* The ~40 field validators and `parseRaw*` functions moved out of `client.ts`. |
| `src/web/task-board/project.ts` | *Create.* Wire→view projection (`taskStatus`, `agentStatus`, `runStatus`, `normalize`, `*Projection`). |
| `src/web/task-board/client.ts` | *Modify.* Retains only HTTP concerns and the public client surface. |

`wire.ts` exists so exactly one file imports `@shared/*`. That keeps the aliasing/collision rules in one place rather than scattered across four.

---

### Task 1: Derive contract unions from runtime arrays

The contract currently exports only *types* for its unions, so web's runtime validators cannot be built from it. Exporting `as const` arrays and deriving the types is type-identical for existing consumers.

**Files:**
- Modify: `src/shared/task-board-contract/index.ts:7-61`
- Test: `tests/shared/task-board-contract/unions.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `AGENT_STATUSES`, `WORKER_CONNECTIONS`, `TASK_STATUSES`, `RUN_STATUSES`, `AGENT_ROLES`, `TASK_KINDS`, `TASK_PHASE_STAGES`, `TASK_PHASE_STATUSES`, `TASK_MESSAGE_KINDS`, `QUESTION_STATUSES`, `WAKEUP_REASONS`, `WORK_ITEM_PRIORITIES`, `WORK_ITEM_STATES`, `WORK_ITEM_STAGES`, `EVALUATOR_PROFILES`, `DOCUMENT_ACTOR_TYPES` — each `readonly string[]` via `as const`. The same type names as today (`AgentStatus` etc.) remain exported, now derived.

- [ ] **Step 1: Write the failing test**

Create `tests/shared/task-board-contract/unions.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STATUSES,
  TASK_STATUSES,
  RUN_STATUSES,
  WORK_ITEM_STATES,
} from '#shared/task-board-contract';

test('agent statuses match the documented wire vocabulary', () => {
  assert.deepEqual([...AGENT_STATUSES], [
    'idle', 'ready', 'running', 'interrupting', 'waiting_for_human',
  ]);
});

test('task statuses are the wire set, not the view set', () => {
  // 'in_progress' and 'cancelled' are wire-only; the view projects them to
  // 'running' and 'interrupted'. If this ever contains 'running', a view
  // type has leaked into the contract.
  assert.deepEqual([...TASK_STATUSES], [
    'backlog', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled',
  ]);
  assert.ok(!TASK_STATUSES.includes('running' as never));
});

test('run statuses include active rather than running', () => {
  assert.deepEqual([...RUN_STATUSES], [
    'active', 'waiting_for_human', 'completed', 'failed', 'interrupted',
  ]);
});

test('work item states cover the durable lifecycle', () => {
  assert.deepEqual([...WORK_ITEM_STATES], [
    'submitted', 'processing', 'needs_input', 'waiting_for_human_review',
    'completed', 'failed', 'cancelled',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:runtime`
Expected: FAIL — the module has no export named `AGENT_STATUSES`.

- [ ] **Step 3: Convert the unions**

In `src/shared/task-board-contract/index.ts`, replace each bare union type with an array + derived type. Apply this exact pattern to all sixteen:

```ts
export const AGENT_ROLES = ["engineer", "manager", "verifier"] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export const AGENT_STATUSES = ["idle", "ready", "running", "interrupting", "waiting_for_human"] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

export const WORKER_CONNECTIONS = ["waiting_for_wake", "watching_run"] as const;
export type WorkerConnection = typeof WORKER_CONNECTIONS[number] | null;

export const TASK_KINDS = ["work", "manager_review", "human_check"] as const;
export type TaskKind = typeof TASK_KINDS[number];

export const TASK_STATUSES = ["backlog", "queued", "in_progress", "blocked", "completed", "failed", "cancelled"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_PHASE_STAGES = ["research", "planning", "execution", "testing", "review", "done"] as const;
export type TaskPhaseStage = typeof TASK_PHASE_STAGES[number];

export const TASK_PHASE_STATUSES = ["pending", "in_progress", "blocked", "completed", "failed"] as const;
export type TaskPhaseStatus = typeof TASK_PHASE_STATUSES[number];

export const TASK_MESSAGE_KINDS = ["note", "progress", "proposal", "result"] as const;
export type TaskMessageKind = typeof TASK_MESSAGE_KINDS[number];

export const QUESTION_STATUSES = ["open", "answered"] as const;
export type QuestionStatus = typeof QUESTION_STATUSES[number];

export const WAKEUP_REASONS = ["human_assignment", "human_answer", "human_resume", "workflow_handoff"] as const;
export type WakeupReason = typeof WAKEUP_REASONS[number];

export const RUN_STATUSES = ["active", "waiting_for_human", "completed", "failed", "interrupted"] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export const WORK_ITEM_PRIORITIES = ["urgent", "high", "normal", "low", "opportunistic"] as const;
export type WorkItemPriority = typeof WORK_ITEM_PRIORITIES[number];

export const WORK_ITEM_STATES = ["submitted", "processing", "needs_input", "waiting_for_human_review", "completed", "failed", "cancelled"] as const;
export type WorkItemState = typeof WORK_ITEM_STATES[number];

export const WORK_ITEM_STAGES = ["refinement", "project_resolution", "research", "planning", "implementation", "testing", "verification", "human_review", "deployment"] as const;
export type WorkItemStage = typeof WORK_ITEM_STAGES[number];

export const EVALUATOR_PROFILES = ["tests", "editorial", "visual", "manual"] as const;
export type AgentTypeEvaluatorProfile = typeof EVALUATOR_PROFILES[number];

export const DOCUMENT_ACTOR_TYPES = ["human", "agent"] as const;
export type DocumentActorType = typeof DOCUMENT_ACTOR_TYPES[number];
```

Preserve the original member order exactly — the tests above assert on it, and reordering would be a silent wire-vocabulary change.

Leave `ActorType`, `WorkflowStage`, `PlanRevisionState`, `WorkNodeState`, `StageHandoffOutcome`, `ArtifactMediaType`, `DocumentContentType`, `WorkItemProjectTarget`, and `AutomationStageExecutor` as they are — web does not build runtime validators from them in this task.

Note `DocumentActorType` was previously `Exclude<ActorType, "system">`; the explicit array above is equivalent. Keep `ActorType` itself unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:runtime`
Expected: PASS.

- [ ] **Step 5: Verify the server is genuinely unaffected**

Run: `npm run typecheck:all`
Expected: PASS with no errors — the derived types are structurally identical, so all 10 server importers still compile.

Run: `git diff --stat src/server`
Expected: empty output.

- [ ] **Step 6: Commit**

```bash
git add src/shared/task-board-contract/index.ts tests/shared/task-board-contract/unions.test.ts
git commit -m "refactor: derive contract unions from runtime arrays

Exports as-const arrays for each wire union so consumers can build
runtime validators from the contract. Types are derived and remain
structurally identical, leaving server importers unaffected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire `@shared/*` for the browser and delete duplicated constants

The web app cannot currently import the contract: `package.json` maps `#shared/*` to `./build/...`, a build artifact that would break HMR in the browser. This task adds a source-resolving alias for web only, and proves it by deleting the first set of duplicated constants.

**Files:**
- Create: `tooling/aliases.ts`
- Modify: `vite.config.ts`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.app.json`
- Create: `src/web/task-board/wire.ts`
- Modify: `src/web/task-board/client.ts:45,66,72,73` (constant declarations)
- Modify: `src/web/task-board/document-drafts.ts:10`
- Test: `src/web/task-board/wire.test.ts` (create)

**Interfaces:**
- Consumes: `TASK_BOARD_API_VERSION`, `AUTOMATION_CONFIGURATION_MAX_BYTES`, `WORK_ITEM_PAGE_SIZE` from Task 1's module.
- Produces: `src/web/task-board/wire.ts` re-exporting `apiVersion: string`, `maximumAutomationConfigurationBytes: number`, `workItemPageSize: number`.

- [ ] **Step 1: Write the failing test**

Create `src/web/task-board/wire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TASK_BOARD_API_VERSION } from '@shared/task-board-contract';
import { apiVersion, maximumAutomationConfigurationBytes, workItemPageSize } from './wire';

describe('wire constants', () => {
  it('resolves the shared contract from source through the @shared alias', () => {
    expect(TASK_BOARD_API_VERSION).toBe('steward.task-board/v1');
  });

  it('re-exports contract constants rather than redeclaring them', () => {
    expect(apiVersion).toBe(TASK_BOARD_API_VERSION);
    expect(maximumAutomationConfigurationBytes).toBe(48 * 1_024);
    expect(workItemPageSize).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/task-board/wire.test.ts`
Expected: FAIL — cannot resolve `@shared/task-board-contract`.

- [ ] **Step 3: Define the alias once**

`vitest.config.ts` is a standalone config — it does **not** extend
`vite.config.ts`, so an alias declared only in Vite would not apply under
Vitest and this task's test would fail to resolve. Both configs need it, so
define it in one place.

Create `tooling/aliases.ts`:

```ts
import { fileURLToPath } from 'node:url';

/**
 * The browser resolves the shared contract from SOURCE, so Vite can hot-reload
 * it. The Node runtime keeps its own `#shared/*` subpath imports (see the
 * `imports` map in package.json), which point at compiled output under build/
 * because that is what it actually executes. Same contract, two resolutions,
 * for two genuinely different consumers.
 *
 * Declared here because vite.config.ts and vitest.config.ts are independent
 * configs and both need it.
 */
export const sharedContractAlias = {
  '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
};
```

- [ ] **Step 4: Wire the alias into both configs**

In `vite.config.ts`, import it and add a `resolve` block inside the returned
config object, alongside `plugins`:

```ts
import { sharedContractAlias } from './tooling/aliases';

    resolve: { alias: sharedContractAlias },
```

In `vitest.config.ts`, add the same:

```ts
import { defineConfig } from 'vitest/config';
import { sharedContractAlias } from './tooling/aliases';

export default defineConfig({
  resolve: { alias: sharedContractAlias },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tooling/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Add the matching path to tsconfig**

In `tsconfig.app.json`, add to `compilerOptions` (it already has `"baseUrl": "."`):

```json
"paths": {
  "@shared/*": ["src/shared/*"]
}
```

- [ ] **Step 6: Create the wire module**

Create `src/web/task-board/wire.ts`:

```ts
/**
 * The web app's single doorway to the shared task-board contract.
 *
 * Only this file imports `@shared/*`. Everything else in src/web imports from
 * here, which keeps two hazards in one place:
 *
 *  1. Wire types collide by name with the view types in ./types.ts —
 *     TaskStatus, AgentStatus and RunStatus mean different things on each
 *     side. Wire versions are re-exported with a `Wire` prefix.
 *  2. Two names differ across the boundary: the contract calls them
 *     WakeupReason and AgentTypeEvaluatorProfile; the web calls them
 *     WakeReason and AutomationEvaluatorProfile.
 */
import {
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  TASK_BOARD_API_VERSION,
  WORK_ITEM_PAGE_SIZE,
} from '@shared/task-board-contract';

export const apiVersion = TASK_BOARD_API_VERSION;
export const maximumAutomationConfigurationBytes = AUTOMATION_CONFIGURATION_MAX_BYTES;
export const workItemPageSize = WORK_ITEM_PAGE_SIZE;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/web/task-board/wire.test.ts`
Expected: PASS.

- [ ] **Step 8: Replace the duplicated declarations**

In `src/web/task-board/client.ts`, delete these four lines:

```ts
const API_VERSION = 'steward.task-board/v1';          // line 45
const taskMessagePageSize = 200;                      // line 66  -- see note
const maximumAutomationConfigurationBytes = 48 * 1_024; // line 72
const workItemPageSize = 200;                         // line 73
```

Add to the existing import block at the top:

```ts
import { apiVersion, maximumAutomationConfigurationBytes, workItemPageSize } from './wire';
```

Then replace every use of `API_VERSION` with `apiVersion`.

Keep `taskMessagePageSize` as a local constant — it is a *client-side paging
choice* that happens to equal 200, not the contract's `WORK_ITEM_PAGE_SIZE`.
Collapsing them would couple two unrelated numbers. Leave a comment saying so:

```ts
// Client-side paging for task messages. Deliberately NOT the contract's
// WORK_ITEM_PAGE_SIZE — same value today, different concerns.
const taskMessagePageSize = 200;
```

In `src/web/task-board/document-drafts.ts:10`, **leave `maximumDraftBytes` local**
and only add the comment explaining why:

```ts
// Mirrors the server's document content cap (src/server/task-board/schema.ts).
// Deliberately NOT the automation payload cap: the two limits are unrelated and
// only happen to share a value today, so coupling them would let a change to one
// silently break the other.
const maximumDraftBytes = 48 * 1_024;
```

> **Corrected 2026-08-02.** This step originally told the implementer to set
> `maximumDraftBytes = maximumAutomationConfigurationBytes`. That was wrong:
> `src/server/task-board/schema.ts` caps *document content* with its own
> independent `48 * 1_024`, and the contract has no document-content constant.
> Coupling the two would make a change to the automation cap silently drift
> document drafts away from what the server accepts — the same "same value
> today, different concerns" trap this task deliberately avoids for
> `taskMessagePageSize`. Caught by `codex review` on the Task 2 diff.
>
> Sharing the limit properly would mean adding `DOCUMENT_CONTENT_MAX_BYTES` to
> the contract and using it on both sides, which requires editing `src/server`
> — outside this plan's constraints. Left as a known, uncoupled duplicate.

- [ ] **Step 9: Run the full web suite**

Run: `npm run typecheck && npm run test:web`
Expected: PASS. `client.test.ts:81` and `document-drafts.test.ts:52-54` hardcode these values as literals — that is fine and intentional, since a test asserting against the constant it is testing would prove nothing.

- [ ] **Step 10: Verify the production build resolves the alias**

Run: `npm run build:web`
Expected: PASS. Vitest and Vite resolve aliases through different configs, so
a green test run does not prove the bundle works. This step is what confirms it.

- [ ] **Step 11: Commit**

```bash
git add tooling/aliases.ts vite.config.ts vitest.config.ts tsconfig.app.json src/web/task-board/wire.ts src/web/task-board/wire.test.ts src/web/task-board/client.ts src/web/task-board/document-drafts.ts
git commit -m "refactor: resolve the shared contract from web source

Adds an @shared alias for the browser so the contract is reachable from
source instead of build output, and replaces the duplicated API version,
automation payload cap, and work-item page size with contract imports.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Replace local wire types and validator sets with the contract

This is the task that creates the actual safety seam. `RawAgent` (`client.ts:161`), `RawTask` (:197) and `RawRun` (:253) inline the server's status unions as string literals, and the `Set`s at :46-62 repeat them again as runtime values. Both get replaced by contract-derived values.

**Files:**
- Modify: `src/web/task-board/wire.ts`
- Modify: `src/web/task-board/client.ts:46-62` (validator sets), `:161-171` (`RawAgent`), `:197-215` (`RawTask`), `:253-261` (`RawRun`)
- Test: `src/web/task-board/wire.test.ts`

**Interfaces:**
- Consumes: Task 1's union arrays; Task 2's `@shared` alias and `wire.ts`.
- Produces: from `wire.ts` — types `WireAgentStatus`, `WireTaskStatus`, `WireRunStatus`, `WireWorkerConnection`, plus `AgentRole`, `TaskKind`, `TaskPhaseStage`, `TaskPhaseStatus`, `TaskMessageKind`, `QuestionStatus`, `WakeReason`, `WorkItemPriority`, `WorkItemState`, `WorkItemStage`, `AutomationEvaluatorProfile`, `DocumentActorType`; and `Set`s `rawAgentStatuses`, `rawWorkerConnections`, `rawTaskStatuses`, `rawRunStatuses`, `roles`, `taskKinds`, `taskPhaseStages`, `taskPhaseStatuses`, `messageKinds`, `questionStatuses`, `wakeReasons`, `workItemPriorities`, `workItemStates`, `workItemStages`, `evaluatorProfiles`, `documentActorTypes`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/task-board/wire.test.ts`:

```ts
import { AGENT_STATUSES, TASK_STATUSES } from '@shared/task-board-contract';
import { rawAgentStatuses, rawTaskStatuses } from './wire';

describe('wire validators', () => {
  it('builds the agent status validator from the contract', () => {
    expect([...rawAgentStatuses].sort()).toEqual([...AGENT_STATUSES].sort());
  });

  it('builds the task status validator from the contract', () => {
    expect([...rawTaskStatuses].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('rejects view-layer vocabulary that never appears on the wire', () => {
    // 'running' is what the view calls in_progress. If the wire validator
    // ever accepts it, the projection layer has leaked into parsing.
    expect(rawTaskStatuses.has('running' as never)).toBe(false);
    expect(rawAgentStatuses.has('sleeping' as never)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/task-board/wire.test.ts`
Expected: FAIL — `wire.ts` has no export named `rawAgentStatuses`.

- [ ] **Step 3: Extend the wire module**

Add to `src/web/task-board/wire.ts`:

```ts
import {
  AGENT_ROLES, AGENT_STATUSES, DOCUMENT_ACTOR_TYPES, EVALUATOR_PROFILES,
  QUESTION_STATUSES, RUN_STATUSES, TASK_KINDS, TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES, TASK_PHASE_STATUSES, TASK_STATUSES, WAKEUP_REASONS,
  WORKER_CONNECTIONS, WORK_ITEM_PRIORITIES, WORK_ITEM_STAGES, WORK_ITEM_STATES,
  type AgentRole, type AgentStatus, type AgentTypeEvaluatorProfile,
  type DocumentActorType, type QuestionStatus, type RunStatus, type TaskKind,
  type TaskMessageKind, type TaskPhaseStage, type TaskPhaseStatus,
  type TaskStatus, type WakeupReason, type WorkerConnection,
  type WorkItemPriority, type WorkItemStage, type WorkItemState,
} from '@shared/task-board-contract';

// Prefixed because ./types.ts exports different types under these same three
// names. Importing the wrong one compiles but is silently incorrect.
export type WireAgentStatus = AgentStatus;
export type WireTaskStatus = TaskStatus;
export type WireRunStatus = RunStatus;
export type WireWorkerConnection = WorkerConnection;

// Renamed to the vocabulary the web app already uses.
export type WakeReason = WakeupReason;
export type AutomationEvaluatorProfile = AgentTypeEvaluatorProfile;

export type {
  AgentRole, DocumentActorType, QuestionStatus, TaskKind, TaskMessageKind,
  TaskPhaseStage, TaskPhaseStatus, WorkItemPriority, WorkItemStage, WorkItemState,
};

/** Runtime validators, derived so a contract change reaches parsing automatically. */
export const rawAgentStatuses = new Set(AGENT_STATUSES);
export const rawWorkerConnections = new Set(WORKER_CONNECTIONS);
export const rawTaskStatuses = new Set(TASK_STATUSES);
export const rawRunStatuses = new Set(RUN_STATUSES);
export const roles = new Set(AGENT_ROLES);
export const taskKinds = new Set(TASK_KINDS);
export const taskPhaseStages = new Set(TASK_PHASE_STAGES);
export const taskPhaseStatuses = new Set(TASK_PHASE_STATUSES);
export const messageKinds = new Set(TASK_MESSAGE_KINDS);
export const questionStatuses = new Set(QUESTION_STATUSES);
export const wakeReasons = new Set(WAKEUP_REASONS);
export const workItemPriorities = new Set(WORK_ITEM_PRIORITIES);
export const workItemStates = new Set(WORK_ITEM_STATES);
export const workItemStages = new Set(WORK_ITEM_STAGES);
export const evaluatorProfiles = new Set(EVALUATOR_PROFILES);
export const documentActorTypes = new Set(DOCUMENT_ACTOR_TYPES);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/task-board/wire.test.ts`
Expected: PASS.

- [ ] **Step 5: Delete the duplicated sets from client.ts**

Remove lines 46-62 of `src/web/task-board/client.ts` (`rawAgentStatuses` through `documentActorTypes`, and `evaluatorProfiles`). Keep `identifierPattern`, `skillIdentifierPattern`, and all the `maximum*` limits — those are client-side parsing policy, not contract vocabulary.

Import the deleted names from `./wire` instead, merging into the existing `./wire` import added in Task 2.

- [ ] **Step 6: Replace the inline unions in the Raw types**

In `RawAgent` (`client.ts:161`):

```ts
  role: AgentRole;
  status: WireAgentStatus;
  workerConnection: WireWorkerConnection;
```

In `RawTask` (`client.ts:197`):

```ts
  status: WireTaskStatus;
  assignedRole: AgentRole | null;
```

In `RawRun` (`client.ts:253`):

```ts
  status: WireRunStatus;
```

Import those four type names from `./wire`.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm run test:web`
Expected: PASS. The projections at `client.ts:866-893` still compile because
`Record<RawTask['status'], TaskStatus>` now keys off the *contract's* union —
which is the entire point of this task.

- [ ] **Step 8: Prove the seam actually works**

This step is the deliverable. Temporarily add a member to the contract:

```ts
export const TASK_STATUSES = [..., "cancelled", "escalated"] as const;
```

Run: `npm run typecheck`
Expected: **FAIL** in `client.ts`, reporting that the `Record<RawTask['status'], TaskStatus>` mapping is missing the `escalated` key.

If it passes, the seam is not real — stop and investigate before continuing.

Then revert the temporary change:

```bash
git checkout src/shared/task-board-contract/index.ts
```

Run `npm run typecheck` again and confirm it PASSES.

- [ ] **Step 9: Commit**

```bash
git add src/web/task-board/wire.ts src/web/task-board/wire.test.ts src/web/task-board/client.ts
git commit -m "refactor: derive web wire types from the shared contract

Replaces the locally redeclared RawAgent/RawTask/RawRun status unions and
the runtime validator sets with contract-derived values, so a server-side
vocabulary change now fails the web build instead of returning undefined
from the projection maps at runtime.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Split client.ts by responsibility

With the duplication gone, `client.ts` is still one file holding wire types, ~40 validators, projection, and HTTP. Split it so each file has one job. This is a pure move — no behaviour changes.

**Files:**
- Create: `src/web/task-board/parse.ts`
- Create: `src/web/task-board/project.ts`
- Modify: `src/web/task-board/client.ts`
- Modify: `src/web/task-board/client.test.ts` (import paths only)

**Interfaces:**
- Consumes: everything from `./wire`.
- Produces:
  - `parse.ts` — the `Raw*` interfaces, the scalar validators (`record`, `exactRecord`, `string`, `boundedText`, `identifier`, `skillIdentifier`, `boolean`, `nullableString`, `integer`, `timestamp`, `nullableTimestamp`, `member`, `array`, `apiEntity`), and every `parse*` function (`parseProject` … `parseRawBoard`, `parseBoardSnapshot`, `parseBoardDocument`).
  - `project.ts` — `taskStatus(status, hasOpenQuestion)`, `agentStatus(status)`, `runStatus(status)`, `eventRunId`, `eventWakeReason`, `newest`, `documentSummary`, `documentProjection`, `projectProjection`, `workItemProjection`, `normalize(boards, listedProjects, rawMessages, rawWorkItems)`.
  - `client.ts` — unchanged public surface, including `createTaskBoardClient` and `interruptRun`.

- [ ] **Step 1: Confirm the current suite is green before moving anything**

Run: `npm run test:web`
Expected: PASS. Record the test count — it must be identical after the split.

- [ ] **Step 2: Move parsing into parse.ts**

Create `src/web/task-board/parse.ts` and move the blocks listed under
*Produces* above, verbatim. Add the module comment:

```ts
/**
 * Validation of untrusted board API responses.
 *
 * Every function takes the raw value plus a dotted `path` used only to build
 * a readable error message when validation fails — e.g. "board.tasks[3].status".
 * Nothing here projects or renames; that is ./project.ts.
 */
```

Export everything the other two modules need. Keep `identifierPattern`,
`skillIdentifierPattern`, and the `maximum*` parsing limits here — they are
parsing policy and belong beside the validators.

- [ ] **Step 3: Typecheck the move**

Run: `npm run typecheck`
Expected: PASS once `client.ts` imports the moved names from `./parse`.

- [ ] **Step 4: Move projection into project.ts**

Create `src/web/task-board/project.ts` with the wire→view functions. Add:

```ts
/**
 * Wire -> view projection.
 *
 * The board speaks one vocabulary and the interface speaks another, on
 * purpose. The server reports an agent as `idle`; the interface shows
 * `sleeping`. A task is `in_progress` on the wire and `running` on screen,
 * and a task with an unanswered question is `waiting_for_human` regardless
 * of what the wire says. Keeping the mapping explicit here is what stops
 * server vocabulary leaking into components.
 */
```

Each mapping stays a `Record<Wire…, View…>` so it remains exhaustive.

- [ ] **Step 5: Typecheck and test**

Run: `npm run typecheck && npm run test:web`
Expected: PASS, with the same test count recorded in Step 1.

- [ ] **Step 6: Confirm client.ts is now HTTP-only**

Run: `wc -l src/web/task-board/*.ts`
Expected: `client.ts` substantially smaller; `parse.ts` and `project.ts` carry the moved code.

Read through `client.ts` and confirm no `parse*` or `*Projection` function bodies remain — only imports and HTTP concerns.

- [ ] **Step 7: Verify the build and the e2e suite**

Run: `npm run build:web`
Expected: PASS.

Run: `npm run test:e2e`
Expected: PASS — this is a pure refactor, so the browser-level behaviour is unchanged. If any spec fails, the move was not behaviour-preserving; fix before committing.

- [ ] **Step 8: Commit**

```bash
git add src/web/task-board/parse.ts src/web/task-board/project.ts src/web/task-board/client.ts src/web/task-board/client.test.ts
git commit -m "refactor: split client.ts by responsibility

Separates response validation (parse.ts) and wire-to-view projection
(project.ts) from the HTTP client, leaving each file with one job.
Pure move; no behaviour change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done When

- `src/web` contains no redeclaration of a wire status union or protocol constant.
- Adding a member to any contract union fails `npm run typecheck` (verified in Task 3, Step 8).
- `npm run typecheck:all`, `npm run test:web`, `npm run test:runtime`, and `npm run test:e2e` all pass.
- `git diff --stat src/server` is empty across the whole plan.
- The view-model projection in `types.ts` is unchanged.
