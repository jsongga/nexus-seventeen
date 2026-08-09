# Audit-fix campaign design

Status: Approved
Author: John Song + Claude (design), audit by 4 Claude reviewers + Codex
Date: 2026-08-09
Scope: Fix all findings from the 2026-08-08 five-reviewer audit of nexus-seventeen

## Summary

A five-reviewer audit (four Claude subagents + Codex, reconciled) found that the core
operator loop does not close (inert intake, unrouted "Auto" default, unrecoverable
failed tasks, invisible credentials), that server lifecycle sequences commit partial
state whose retries skip repair (permanently stuck runs, nodes, and lanes), and that
the shared contract shares only types, so validation is hand-rolled in triplicate.

This campaign fixes all of it in six ordered streams: CI safety net first, server
atomicity, fleet resilience, operator-loop closure, web data-layer correctness, and
contract consolidation last. Codex implements each task; Claude and `codex review`
check every diff; each finished task is committed on the `audit-fixes` branch.

## Decisions made (with the operator)

1. **"Auto" project target: removed.** Submission requires an explicit project.
   Auto-routing may return later as a real feature with a resolver behind it.
2. **Work items get a detail view** on the existing task-detail pattern: answer,
   confirm/reject plan, cancel, archive. `parked/` is salvaged for reusable logic,
   then deleted.
3. **Full recovery set** for failed/blocked/interrupted tasks: Reassign, Retry,
   Return-to-backlog. Resume on a terminal task returns a clear 409, never a
   false success.
4. **Fleet quarantine policy:** transient errors retry with capped backoff and never
   park; non-transient errors settle the poisoned claim as failed on the board and
   the lane continues. Agent status carries `lastError` for the UI.
5. **Lazy identities, manual lanes:** the sole manager is auto-created when a
   project's first work item arrives; engineer identities are created when a
   confirmed plan needs one. The fleet stays config-driven; the UI surfaces
   ready-to-paste lane config for new identities and supports token rotation.
   (Context: dormant identities cost zero model tokens; only launched processes
   spend them. The board's persisted history/handoff context is the memory that
   carries across short-lived runs.)
6. **Contract consolidation: constants now, validators last.** Enums/regexes/page
   sizes derive from the shared contract early; the three hand-rolled validators
   unify into one contract-owned runtime validator only after everything else is
   green.

## Stream E1 — CI safety net (first)

- Run `tooling/vite-security.test.ts` in CI (it guards the operator-token proxy;
  currently excluded by `test:web`'s `src/web` glob).
- Add `test:bootstrap` to `test:all` and the GitHub workflow.
- Give `tests/e2e/` typechecking (own tsconfig; wire into `typecheck:all`).
- CI node matrix 22 + 24 (matches `.nvmrc` and `engines`).
- Fix the `build` → `build:all` → `build:web` alias chain; stop
  `tsconfig.test.json` double-compiling `src/` into `.test-dist`.

## Stream A — Server atomicity and lifecycle

Principle: **validate before committing; retries repair rather than skip.**

- **Settlement** (`collaborators/runs.ts`): handoff validation and `settleAttempt`
  move inside the settle transaction. The duplicate-retry path re-runs any
  unfinished workflow half (idempotent repair). Fixes stuck-`active` nodes.
- **Claim** (`runs.ts` + `persistence/workflow.ts`): `claimContext` (including the
  skill-digest check) runs before the claim commits; a 409 can no longer strand a
  committed claim and dead-lock the agent.
- **Work-item planning** (`collaborators/work-items.ts`, `service.ts`): work item +
  planning task + link become atomic; a duplicate POST re-triggers
  `startWorkItemPlanning` when the link is missing.
- **Node activation** (`collaborators/projects.ts`): `createTask` + `linkAttempt`
  atomic; a reconciler re-activates orphaned `ready` nodes on startup, confirm,
  and settle. (Lazy identity creation in Stream C removes the no-compatible-agent
  stranding at the root.)
- **CR poison pill**: worker normalizes CRLF/CR to LF at the output boundary
  (`task-worker/worker.ts` flush path) so board `text()` validation cannot reject
  a journaled result forever.
- **Interrupt** (`contained-cli-launcher.ts`, `worker.ts`): terminate the process
  group first, credential-scrub the reason only for reporting; do not cache a
  rejected interrupt settlement; fix the shutdown-path unhandled rejection.
- **Ordering/visibility**: `proposeWorkflowForAgent` no longer commits before the
  settle transaction it belongs to; workflow SSE events emit after commit
  (documents.ts pattern), and a throwing listener cannot abort a transaction.
- **HTTP hygiene**: `POST /v1/plans/:id/confirm` gets schema validation and the
  terminal-work-item guard; route segments are percent-decoded so identifiers with
  `@`/`:` round-trip (`bot@host` can claim).
- **Recovery endpoints** for Stream C: retry, reassign, return-to-backlog; resume
  on terminal → 409 `TASK_TERMINAL`.
- **Tests**: every fix lands with a failure-boundary test — crash-window and
  retry-idempotency coverage over the seams the current suites skip.

## Stream B — Fleet resilience

`task-fleet/runtime.ts` + `fleet.ts`: transient → capped exponential backoff, never
park; non-transient → settle the claim as failed on the board, record `lastError`
on the agent, continue the lane. No silent permanent stalls; tests for both paths.

## Stream C — Operator loop closure

- **Intake**: remove "Auto"; work-item detail pane (open, answer, confirm/reject
  plan, cancel, archive terminal items); delete `parked/` after salvage.
- **Lazy identities**: manager auto-created on first work item; engineers created
  when a confirmed plan lacks a compatible agent; UI surfaces lane config
  (id/token/workdir) for new identities; token rotation on the agent page.
- **Recovery UI**: Reassign / Retry / Return-to-backlog on failed, blocked, and
  interrupted tasks.
- **Error pipeline**: mutation failures are per-action inline errors or dismissible
  toasts; the "unavailable" banner is reserved for actual connectivity failures;
  polling never clears a mutation error; all submit paths respect the success
  boolean (kills the answer-wipe by construction).
- **Input safety**: form state survives polls (no reset on `defaultAgentId`
  change); dirty dialogs guard Escape/backdrop; the detail pane shows a
  "task removed" state instead of silently swapping tasks; selected task id joins
  the hash route (deep links; Back closes the detail).
- **Flow polish**: worker-connection state visible at assignment with an offline
  warning; "Pause Agents" gains a confirmation and consistent Interrupt naming;
  ThreadPipelineTable drops the git-PR vocabulary for the shared status names;
  first-run empty state points at "Add project"; the project-path field explains
  its validation; `explicitPointOfContact` is respected by AgentPage.

## Stream D — Web data-layer correctness

- Timestamps parse to epoch millis at the parse boundary; all ordering compares
  numbers (feeds, chats, documents, runs, resources).
- Message pagination uses a contract-declared page size, not a client constant.
- The 5s poll skips when a refresh is in flight instead of aborting it;
  mutation-triggered refreshes take priority over polls.
- AutomationPage saves invalidate in-flight loads (sequence bump on save).
- SSE frame parsing unified with the correct document-stream parser (CRLF,
  optional-space `data:`).
- Artifact object-URL leak fixed (revoke on post-cleanup resolution).
- Missing `orderKey` is a parse error, not a synthesized cross-project index.
- The run/event join prefers events carrying `taskId`/`wakeReason` over ones
  without (instead of array-order last-wins), and a run whose own `taskId` is
  null is kept, not dropped.

## Stream E2 — Contract consolidation (last)

- Enums, `AGENT_ROLES`, `WAKEUP_REASONS`, identifier grammar, and page sizes
  derive from `#shared/task-board-contract` everywhere (web types, worker types,
  SQL CHECK generation, JSON schema); the agent-result schema gets one source.
- Then: one contract-owned runtime validator replaces `data/parse.ts`,
  `task-board/schema.ts`, and `task-worker/schema.ts` hand-rolled trio.
- Finish the structural migrations: split `client.ts` (SSE parser, storage lease,
  concurrency mapper, uuid → own modules) and finish `BoardApp.tsx`'s move into
  `views/`/`model/`.

## Out of scope

Fleet auto-discovery (manual lanes chosen); snapshot/incremental-sync redesign
(the poll fix bounds the damage; the N+1 snapshot cost is a future campaign);
richer per-agent memory documents; deployment features.

## Verification bar

Per task: `npm run typecheck:all` plus the relevant suite green before commit;
flow changes add e2e coverage. Per stream: full `npm test`. End of campaign: a
both-model review of the whole branch before handing over for merge.

## Alternatives considered

- **Implement auto-routing now** — rejected: a new feature (resolver design,
  manager heuristics) grafted onto a fix campaign; removal is the smallest
  correct fix and keeps the option open.
- **Un-park the old workflow UI wholesale** — rejected: it was parked
  deliberately and may not match current intent; salvage-then-delete keeps the
  useful logic without resurrecting stale UX.
- **Backoff-retry everything in the fleet** — rejected: a poisoned claim would
  retry forever and misconfiguration would never surface; quarantine keeps lanes
  alive *and* keeps the board truthful.
- **Provision manager + engineer at project creation** — rejected in favor of
  lazy identities: same zero token cost, but avoids unused identities and the
  "exactly one manager" silent no-op class entirely.
- **Full validator unification up front** — rejected: the riskiest refactor
  would precede the bug fixes and everything would depend on it; sequencing it
  last keeps risk at the end.
- **Restrict the identifier grammar** (drop `/`, `:`, `@`) instead of fixing
  round-tripping — rejected: breaking change to existing data for a bug that
  symmetric decoding fixes compatibly.
