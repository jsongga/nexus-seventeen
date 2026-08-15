# Cross-project coordinator design

Status: Superseded by `orchestrator-design.md` (repo root) — its §2 access rule
(a task on project A reads only project B's `interface.md`) and §9 cross-repo
phases (expand/migrate/contract as parent/child tasks) replace the coordinator
role, cross-project reads, and wake-on-settle designed here.
Author: John Song + Claude (design)
Date: 2026-08-11
Scope: Let one work item span multiple projects — a coordinator agent reads
every involved project's context, implements small changes directly across
repos, and delegates larger ones as per-project work items

## Summary

The board is strictly project-scoped: agents, work items, workflows, tasks,
and documents all carry a `NOT NULL project_id`, every lane's worker is
sandboxed to one repo, and nothing can depend on another project. A feature
that touches two repos (a backend API change plus its mobile consumer) is
today two unrelated work items with the operator as the only coordinator.

This design adds a **coordinator**: a third agent role beside manager and
engineer. A work item may target "multiple projects"; the coordinator claims
it, reads the involved projects' existing memory (documents, handoff history,
artifacts), and then either implements the change itself — its lane can hold
several repo roots — or files per-project work items into the target
projects, where the normal manager/engineer machinery takes over. When a
delegated item settles, the board wakes the coordinator; it never polls.

No new engine: no cross-project workflow dependencies, no program schema
layer. Sequencing between the halves is the coordinator's job, the way it
would be a human's.

## Decisions made (with the operator)

1. **Coordinator role for cross-project read.** Only coordinator credentials
   can read other projects' documents, history, and handoff context — one
   auditable role check on read routes. Writes remain scoped to what the
   agent owns. (Rejected: per-agent grant lists, all-agents-read-all.)
2. **Wake-on-settle.** A delegated work item reaching a terminal state wakes
   the coordinator via the existing wake machinery plus one new wake reason.
   No scheduled check-ins, no polling. Tokens are spent only when there is
   news — consistent with the lazy-identity decision from the audit campaign.
3. **Lazy sole coordinator**, matching the sole-manager pattern: created on
   the first cross-project work item, dormant (zero token cost) otherwise.
   The UI surfaces its lane config the same way it does for new
   managers/engineers.
4. **Small vs large is the coordinator's judgment**, set by its role prompt:
   implement directly when the change is contained; delegate per-project
   work items when it is not.

## How a cross-project item flows (worked example)

"Add a vitals-export endpoint to the backend and a download button in the
caregiver app":

1. The operator submits a work item with target **Multiple projects**,
   selecting the backend and mobile projects (schema support exists: the
   intake table's `target_project_id` is already nullable — the hole the
   removed "Auto" option left).
2. First such item → the coordinator identity is created; the operator adds
   its lane (workspaces: both repo paths) to the fleet config shown by the UI.
3. The coordinator wakes, reads both projects' documents/handoff history
   (coordinator-role read), and judges scope.
   - **Small**: it edits both repos from its multi-root lane, commits per
     repo, reports one result on the estate item.
   - **Large**: it writes a contract document (the API shape both halves
     share), files a work item into each target project referencing it, and
     ends its run. Each project's manager plans normally.
4. A delegated item settles → the board wakes the coordinator
   (`delegation_settled`). It reviews, files follow-ups if needed (e.g. the
   mobile half was blocked on a contract gap), and settles the estate item
   when all halves are done.

## Stream A — Estate intake

- Work-item submission gains a **Multiple projects** target: the item stores
  `target_project_id = NULL` plus an explicit involved-projects list (new
  join table `work_item_projects(work_item_id, project_id)`).
- Estate items appear in a dedicated intake view (not attached to any single
  project's board) with the involved projects shown as chips.
- Single-project behavior is untouched; "Multiple projects" is one more
  option in the existing project selector, requiring ≥2 selections.

## Stream B — Coordinator identity and authorization

- `AGENT_ROLES` gains `coordinator` (shared contract → SQL CHECKs, schemas,
  and validators pick it up from the single source).
- Read routes for documents, events/history, artifacts, and work items
  accept a coordinator credential for any project; every other role keeps
  today's own-project-only behavior. One helper owns the check; route tests
  cover engineer-denied/coordinator-allowed per route class.
- Writes: the coordinator creates work items in target projects (that is the
  delegation), and writes documents in projects involved in its active estate
  item. All other cross-project writes stay forbidden.
- Lifecycle: lazily created on first estate intake; token rotation,
  quarantine, and `lastError` behave exactly as for other agents.

## Stream C — Multi-root lanes

- Fleet lane config: `workdir: string` becomes `workspaces: string[]`
  (single-entry for existing lanes; config parser accepts the old key as an
  alias so current fleet files keep working).
- The contained CLI launcher grants the worker write access to every listed
  root (both Codex and Claude CLIs support additional writable directories);
  the primary workspace stays the process cwd.
- Worker protocol: commits are per repo, never spanning; the run report
  lists per-repo outcomes so the board shows which repos changed.

## Stream D — Delegation linkage and wake-on-settle

- A delegated work item records its origin (`origin_work_item_id` on the
  intake table); the estate item's detail view lists its delegations with
  live status.
- `WAKEUP_REASONS` gains `delegation_settled`. When a work item with an
  origin reaches a terminal state, the settle transaction enqueues a wake
  for the coordinator (after commit, like all events). The wake carries the
  settled item's id so the coordinator resumes with context.
- The estate item is settled only by the coordinator (or the operator); the
  operator can answer, cancel, and archive it through the same work-item
  detail actions that exist today.

## Out of scope

Cross-project workflow-dependency edges; a program/system schema layer;
multiple coordinators or per-domain coordinators; atomic cross-repo commits;
automatic root-cause routing of single-project items (the "Auto" resolver
remains future work); cross-project reads for managers/engineers.

## Verification bar

Per task: `npm run typecheck:all` plus the relevant suite green before
commit. New coverage: role-check matrix per route class (coordinator
allowed, engineer denied), estate-intake round-trip, join-table integrity,
wake-on-settle enqueued inside the settle transaction and delivered after
commit (crash-window test at that seam, per the audit campaign's pattern),
multi-root launcher grants, config alias parsing. E2e: submit estate item →
delegations visible → settle wakes coordinator (fleet stubbed). Dual review
(Claude + `codex review`) per task; both-model whole-branch review before
merge.

## Alternatives considered

- **Linked work items only (no coordinator)** — visibility without an actor:
  the operator still sequences the halves and carries the contract between
  them. Kept as the degenerate case: an estate item's delegations are exactly
  that linkage when the coordinator chooses to delegate everything.
- **Cross-project workflow dependencies** — enforcing "mobile starts when
  backend settles" in the engine means dependency edges, eligibility, and
  event feeds crossing the project boundary; large surgery on seams the
  audit campaign just hardened, for sequencing a coordinator can do with
  judgment.
- **Program/system schema layer** — a grouping entity above projects with
  its own intake and views; heavier than needed while one coordinator
  suffices, and nothing in this design blocks adding it later.
- **All agents read all projects** — simplest, but discards the isolation
  the audit campaign built; a leaked lane token would read every project.
- **Per-agent read grants** — finer control than a role, but a bigger auth
  surface and standing config to keep truthful; revisit if non-coordinator
  agents ever genuinely need cross-project context.
- **Scheduled check-ins instead of wake-on-settle** — simpler, but burns
  runs on silence and adds latency to every hand-back; wake machinery
  already exists per-project and the trigger is one settle-path addition.
