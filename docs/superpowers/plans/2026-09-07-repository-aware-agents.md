# Plan: repository-aware agent identity (roadmap 17, campaign 18)

Spec: `docs/superpowers/specs/2026-09-07-repository-aware-agents.md`. Base: `d41a973`.

Three tasks. The first two are X; the third is Y. Z (a worker declaring the tree it holds) is
deferred by the spec.

| #   | Task                     | Deliverable                                                                  | Why here                                    |
| --- | ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Schema v28               | `agents.repository_id`, nullable, migrating from v27                         | Everything else references it               |
| 2   | Identity and eligibility | `AgentProfile.repositoryId`, `createAgent` accepts one, and the claim clause | The campaign 16 arc un-skips here           |
| 3   | Fleet and docs           | One worker per repository, and the operator instructions to run several      | X is unusable without a way to configure it |

## Task 1 — schema v28

`agents.repository_id TEXT NULL REFERENCES repositories(repository_id)`. Null means the
project's primary repository — **not** "any repository", which is the reading that causes the
defect. Follow the ladder's conventions exactly as campaign 16 task 1 did: never rewrite an
applied migration, add the `else if (version === 27)` branch, update `SCHEMA`, and use the
frozen historical shape rather than the live constant for any migration that recreates `agents`.

That last point is not hypothetical — campaign 16 task 1 found that applied migrations
interpolated the _live_ `work_items` constant, so adding a column silently rewrote two earlier
migrations to reference a table those versions did not have. Check whether `agents` is recreated
by any applied migration before adding a column to its schema constant.

**Exit:** a real v27 database migrates with every agent's `repository_id` null; fresh and
migrated shapes match; the primary-per-project invariant is untouched.

## Task 2 — identity and eligibility

`AgentProfile.repositoryId` and `CreateAgentRequest.repositoryId`, both optional. Parse on both
boundaries. Reject a `repositoryId` that belongs to another project — campaign 16 task 4a has
the pattern, and the same argument applies: an agent must not be scoped to a tree its project
does not own.

The claim clause sits beside the existing project and role checks in `runs.ts` (see the
`TASK_PROJECT_MISMATCH` / `TASK_REQUIRED_ROLE_MISMATCH` pair around line 413). Resolve both
sides through campaign 16's shared fragment; do not add a second way to answer "which tree".

**Un-skip the campaign 16 exit arc** (`tests/server/task-board/pipeline-e2e.test.ts`) and make
it pass. Its fixture already has `joinProjectIndex` and threads a repository id to the planner;
what it lacks is agents scoped to the second repository. That arc passing **is** this task's
exit criterion — it is the reason both campaigns exist.

**Exit:** an agent scoped to repository A cannot claim a task targeting repository B; the
campaign 16 arc passes; every existing claim test passes unchanged, because null still means the
primary.

## Task 3 — fleet and docs

`task-fleet` configuration for one worker per repository, and the operator instructions for
running several against one project. `README.md`'s run-locally section and
`docs/AGENT_SYSTEM.md` both describe the single-repository shape today.

**Exit:** the container tier covers two workers on one project and two repositories; the docs
say how to configure it.

## Per task

Codex implements tasks 1 and 3; **the controller implements task 2**, because its exit criterion
is an e2e arc that must be observed passing and Codex's sandbox cannot bind loopback listeners —
that mismatch is what produced campaign 16's report on an arc that had never run.

Gates outside the sandbox: `typecheck:all`, `test:all`, `test:container` for tasks 1 and 3, and
Playwright only if `src/web` is touched. Claude reviewer and `codex review` serialized, never
concurrent with a gate. Fix rounds cap 5.

**Watch for:** the `test:all` runtime tier now reports one skipped test. When task 2 lands, that
count must go to zero — a skip that survives this campaign means the arc was un-skipped in name
only.
