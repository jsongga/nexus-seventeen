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

**Exit:** the contract round-trips a repository through both the board and worker boundaries; a
declared child without `repositoryId` still parses; `contract-drift.test.ts` passes.

## Task 3 — one resolution helper

The correctness core. Today eight call sites read `project.repo_path` to decide which working
tree to operate on: `collaborators/{runs, merge-executor, base-branch-poll, interface-context,
onboarding-check}.ts`, `pipeline-inspection.ts`, `persistence/workflow.ts`,
`docs-publish/enumerate.ts`.

Introduce one helper that resolves a checkout **from a work item**, not from a project, falling
back to the project's primary repository when `repository_id` is null. Convert all eight in the
same task.

**The helper must not accept a project.** If it does, a caller can pass the project of a work
item whose repository differs and get the wrong tree with no error. Making the wrong call
inexpressible is the point; a half-converted caller is silent, not loud, which is why this is one
task and not eight.

**Exit:** no production file outside the helper and the projection layer reads `repo_path` for a
work item; a test proves a work item with a non-primary `repository_id` resolves to that
repository while its siblings resolve to the primary.

## Task 4 — decomposition across repositories

Declared children carry `repositoryId`; materialization stores it; readiness
(`decomposition-readiness.ts`) and the merge policy treat two children in one project and two
repositories exactly as they treat two children in two projects today — campaign 10 keyed that on
phases, not location, so this should be a narrowing of an existing rule rather than a new one.
Verify that claim before relying on it.

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
