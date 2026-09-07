# Plan: repository identity (roadmap 9.9, campaign 16)

Spec: `docs/superpowers/specs/2026-09-06-repository-identity.md`. Base: `e09fd87`.

Five tasks. The order is forced by the migration: nothing can reference a repository before the
table exists, and no caller can be converted before there is something to convert it to.

| #   | Task                              | Deliverable                                                                                        | Why here                                                 |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Schema v27                        | `repositories` table, `work_items.repository_id`, migration from v26, `repo_path` kept as a mirror | Everything else references it                            |
| 2   | Contract and projection           | `Repository` entity, `DeclaredChild.repositoryId`, parsing on both boundaries                      | The wire shape before the behaviour                      |
| 3   | One resolution helper             | Every git caller resolves a checkout from a work item, not from a project row                      | The correctness core — a half-converted caller is silent |
| 4   | Decomposition across repositories | Children target repositories; readiness and merge honour it; the e2e arc                           | The campaign's exit                                      |
| 5   | Web surface                       | See a project's repositories, add and re-point them, choose one when declaring a child             | Without it X is API-only                                 |

Not in this campaign: dropping `projects.repo_path` (a later version, once no supported worker
reads it), repository sharing between projects, and monorepo subdirectory scoping.

## Task 1 — schema v27

Add `repositories(repository_id, project_id, name, path, is_primary, version, created_at,
updated_at)` and `work_items.repository_id` (nullable, no default).

`store.ts:255` states the ladder's rules: never rewrite an applied migration, add the next
version, bump `SCHEMA_VERSION`, add the `else if (version === 26)` branch, and update `SCHEMA` so
a fresh database receives the same shape. `open()` defines execution order and it differs from
source order — read it before assuming.

The migration inserts one repository per existing project from `projects.repo_path`, marked
primary, named after the project. **`projects.repo_path` stays and stays correct**: it mirrors
the primary repository's path, because a v26 worker still reads it and campaign 10's rollout
requires workers to upgrade before the board.

**Exit:** a test opens a real v26 database, migrates it, and asserts every project has exactly
one primary repository whose path equals the old `repo_path`; a fresh v27 database has the same
shape as a migrated one; `board.test.ts`'s schema block covers the new table.

## Task 2 — contract and projection

`Repository` in `src/shared/task-board-contract/index.ts`; `repositoryId` optional on
`DeclaredChild`; parsers in `validate/entities.ts` and `validate/requests.ts`; row projection in
`persistence/rows.ts`; the web's `Raw*` shape in `src/web/data/parse/types.ts`.

Optional means absent keeps its current meaning — the project's primary repository — so every
plan written before this change still validates and still means what it meant.

**Reconciliation, not just a forward dual-write.** Review of task 1 established that the
backfill runs only during 26 → 27 and never again, while `createProject`
(`collaborators/projects.ts:1202`) inserts into `projects` alone and `updateProject` changes
`repo_path` without touching the primary. So every project created between task 1 and this task
has no repository row **permanently**. Task 2 must therefore backfill missing primaries and
resync drifted paths on open, not merely start writing both from now on.

Note while there: `createProject` stores `request.repoPath ?? request.description`, so a project
can be born with its description as its repository path. That is campaign 10's documented shim,
not a new bug — but the reconciliation will copy it into a repository record, so decide
deliberately whether to carry it or reject it.

**Exit:** the contract round-trips a repository through both the board and worker boundaries; a
declared child without `repositoryId` still parses; a project created without a repository row
gains one; `contract-drift.test.ts` passes.

## Task 3 — one resolution helper

The correctness core. **Measured, not assumed** — the first version of this list was wrong in
both directions. Six files resolve a checkout by joining `projects` and reading `repo_path`:

`collaborators/runs.ts` (lines 178, 234, 287, 888, 1944), `collaborators/projects.ts` (313),
`collaborators/base-branch-poll.ts` (57), `collaborators/verify-attempts.ts` (592),
`collaborators/decomposition-readiness.ts` (176), `persistence/workflow.ts` (693, 770, 921).

Five files the earlier list named — `merge-executor`, `interface-context`, `onboarding-check`,
`pipeline-inspection`, `docs-publish/enumerate` — take a path as a parameter and need **no
change at all**. Converting those while missing three real resolvers is exactly the silent
wrong-tree failure this task exists to prevent.

Introduce one helper that resolves a checkout **from a work item**, not from a project. The
fallback chain is `work_items.repository_id` → the project's primary repository →
`projects.repo_path`. **The last step is not optional.** `repo_path` is `NOT NULL` and always
present, while "the project's primary repository" can be absent for any project created before
task 2's reconciliation runs — so a fallback that stops at the primary throws on exactly the
rows this campaign introduced. Convert all eight call sites in the same task.

**The helper must not accept a project.** If it does, a caller can pass the project of a work
item whose repository differs and get the wrong tree with no error. Making the wrong call
inexpressible is the point; a half-converted caller is silent, not loud, which is why this is one
task and not eight.

**Exit:** no production file outside the helper and the projection layer reads `repo_path` for a
work item; a test proves a work item with a non-primary `repository_id` resolves to that
repository while its siblings resolve to the primary.

## Task 4a — children target repositories

**Base shas are keyed by project and must become keyed by repository.**
`pipelineBaseShasForConfirm` (`persistence/workflow.ts:972`) builds
`Map<projectId, baseSha>` from `pipelineBaseShaForProject`. Two children in one project and two
repositories would therefore share a base sha taken from the project's primary — each child's
branch based on the wrong tree's HEAD. Nothing in the campaign's reviews caught this because it
is not a `repo_path` read; it is a correct read of the wrong key. Key by resolved repository.

Materialization (`workflow.ts:1037`) must store `child.repositoryId` into
`work_items.repository_id`, and must **reject a `repositoryId` belonging to a project other than
the child's `projectId`** — task 2 accepts and discards it today, so a cross-project target is
silently allowed. This is the task that starts reading it, so this is where that check lands.

Then the three debts the reviews recorded:

1. The published-interface cache is populated with the work-item chain
   (`decomposition-readiness.ts`) and evicted with the project chain (`runs.ts`, keyed on
   `crossRepoContext.providerProjectId`). Identical today; diverges the moment a provider Expand
   item carries a `repository_id`, leaving a poisoned entry alive. Carry the provider's resolved
   path or its owner work-item id on `CrossRepoContext` — `prepareCrossRepoContext` already has
   `owner.work_item_id`.
2. `decomposition-readiness.ts` pairs a repository path with `projects.name` as `repoName`, so an
   agent is told the project's name for a tree that may not be the project's. `repositories` has
   its own `name`.
3. `verify-attempts.ts`'s `JOIN projects` is dead after task 3.

**Exit:** two children in one project and two repositories materialize with distinct
`repository_id` and distinct base shas; a cross-project `repositoryId` is rejected; the three
debts are closed.

### Decisions 4a surfaced rather than absorbed

**Pin a child to its resolved repository, or leave it unpinned?** Today materialization stores
`child.repositoryId ?? null`, so a child that resolved to the primary is stored _unpinned_ while
its `base_sha` is pinned. Re-pointing the primary's path, or moving `is_primary`, then gives that
child one tree and another tree's sha — the campaign's own failure mode, and likelier now that a
project can hold several repositories. Storing the resolved id fixes it, and `pipelineRepositoryTarget`
already returns that id.

It was tried and reverted: it makes `repository_id` non-null for every child, including those in
single-repository projects, which changes what null means and fails eight existing decomposition
tests. That is a semantic decision with its own test updates, not something to absorb inside a
fix round. Decide it deliberately here.

**`WorkItem` has no `repositoryId`.** `workItemFromRow` drops the column, so a child's repository
target is invisible in every API projection and to the human confirming a decomposition. Task 5
needs it on the wire; deciding the pinning question first avoids exposing a field whose meaning
is about to change.

**Rollout note for whoever deploys 4a.** `CrossRepoContext` gained `providerWorkItemId`. It is
never rendered to the agent, but it travels on the wire and so enters `migrateContextEstimate`'s
byte count and `estimate.digest`. Every Migrate node blocked before this change carries a
residual `interfaceContextDigest` that no longer matches, so those nodes un-block and retry once
on deploy, and a context within ~50 bytes of budget can flip to `over_budget`.

## Task 4b — the exit arc (partially delivered; the arc itself is outstanding)

**What 4b established, and it is the campaign's premise.** Building the arc found that the
phased-declaration rules were keyed on _project_ identity:
`migrate children must use projects other than the parent project`. Campaign 10 could equate
"different repository" with "different project" because a project had exactly one — and that
assumption forbids exactly the case this campaign exists to enable. The rules now discriminate on
the `(projectId, repositoryId)` pair. A contract test covers it, including the limit: a child
omitting `repositoryId` beside one naming the primary explicitly is the same checkout after
resolution but indistinguishable in a validator with no database, so materialization owns that
case.

Children are also now **pinned** to the repository resolved at confirmation, which was 4a's open
question. Pinning keeps repository identity and base sha stable together; the alternative left a
primary-resolving child unpinned while its base sha was pinned. `TaskBoard.addRepository` is the
supported writer, with rollback coverage.

**The arc is not delivered.** It was written, run, and observed asserting the core claim — two
children of one project resolving to two repositories with distinct base shas from their own
trees — and it reaches the contract gate correctly. It cannot yet carry the contract child to
merge, because the fake provider CLI has no contract implementation for a one-project arc. That
is fixture work. It was reverted rather than committed skipped, after an edit intended for it
damaged campaign 10's arc instead — the two share assertion shapes, and a first-match edit hit
the wrong one.

**Next session:** re-add the arc against `campaign 10 exit: a blast-radius change lands as phased
children across two repos` as the template, extend the fake CLI's provider mode with a contract
implementation for `joinProjectIndex` fixtures, and edit by line range rather than by matching
text that both arcs share.

## Task 4b (original brief) — the exit arc

Readiness (`decomposition-readiness.ts`) and the merge policy must treat two children in one
project and two repositories exactly as they treat two children in two projects today — campaign 10 keyed that on
phases, not location, so this should be a narrowing of an existing rule rather than a new one.
Verify that claim before relying on it.

**A third debt, from task 3's review.** `runs.ts` evicts the published-interface cache using the
_project_ chain on `crossRepoContext.providerProjectId`, while the entry is populated using the
_work-item_ chain via `decomposition-readiness.ts`. Identical today; once a provider Expand item
carries a `repository_id`, the eviction targets a key that was never inserted and the poisoned
entry survives. The shape fix is to carry the provider's resolved path (or its owner work-item
id) on `CrossRepoContext` — `prepareCrossRepoContext` already has `owner.work_item_id`. Also:
`decomposition-readiness.ts` now pairs a repository path with `projects.name` as `repoName`, so
the agent is told the project's name for a tree that may not be the project's, and
`verify-attempts.ts`'s `JOIN projects` is now dead.

**Two debts from task 2's review land here, not later.** `DeclaredChild.repositoryId` is
currently accepted, shape-validated, and then discarded — `materializeDeclaredChildrenInTransaction`
(`persistence/workflow.ts:973`) drops it, and nothing in `src/` writes
`work_items.repository_id`. So today a `repositoryId` naming a repository in a _different_ project
than the child's `projectId` is silently accepted. That is harmless only while nothing reads it.
**The task that starts reading it is this one**, so it must also reject a cross-project target —
a child must not be able to check out a tree its project does not own.

Also note for task 5: `updateProject` moves the primary repository's `path` but never its `name`,
while reconciliation seeds `name` from the project. Rename a project and two repositories end up
named differently depending on which writer created them. Cosmetic, but the UI will show it.

**Exit:** a `pipeline-e2e` arc lands a blast-radius change as two children in one project and two
repositories, with real git and fake CLIs, and Playwright stays green.

## Task 5 — web surface

A project's repositories are visible; one can be added, renamed and re-pointed; the declare-child
flow picks one. Follows campaign 13's structure — new modules under `views/`, each under 600
lines, colocated tests.

**Exit:** Playwright covers adding a second repository to a project and declaring a child against
it, on both projects.

## Per task

Codex implements where the task is mechanical; the controller implements where it is not, and
says which. Gates run outside the sandbox: `typecheck:all`, `test:all`, Playwright for anything
touching `src/web`, and **`test:container` for tasks 1 and 3** — the container tier is the one
that exercises a real database and a real checkout. Claude reviewer and `codex review`
serialized, never concurrent with a gate. Fix rounds cap 5.

**Rollout note to carry into the roadmap when this ships:** v26 → v27 is additive and workers
may lag the board, unlike campaign 10's v18 → v26, which required the reverse order. Say so
explicitly, because the previous campaign's note said the opposite and an operator following the
older instruction would be upgrading in the wrong order for no reason.
