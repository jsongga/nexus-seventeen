# Orchestrator roadmap

Status: Draft for review
Author: Claude (from `orchestrator-design.md`, the source of truth)
Date: 2026-08-15
Scope: Gap analysis of the design against the existing nexus-seventeen
codebase, and a phased campaign plan to build it. Each campaign gets its own
spec → plan → implementation cycle (Codex implements, dual review per task).

## Summary

Nexus-seventeen already contains the design's §3 foundations — durable
SQLite state with validate-inside-transaction writes, conditional claiming
with replay protection, a reconciler, after-commit events with SSE replay —
plus credential fencing and a proto-adapter over the Codex/Claude CLIs. What
it lacks is everything that makes the design an *orchestrator*: the
ten-state task pipeline, git worktrees and PRs, per-task containers, test
tiering, the review/fix loop with a findings ledger, scheduling, budgets,
and Outline. The plan is a retrofit in `§15` build order, not a rewrite: ten
campaigns, each independently shippable, riding on the hardened store.

## Gap analysis

| Design § | State | Evidence / gap |
| --- | --- | --- |
| §3 durable writes, conditional claim, reconciler | **Have** | Audit campaign: `BEGIN IMMEDIATE` validate-before-write, claim replay protection, ready-node reconciler |
| §13 event stream (durable → tail, replay) | **Have** | After-commit events, SSE with sequence cursor |
| §12 trust boundary (tokens) | **Partial** | Credential versioning/rotation/quarantine exist; repo-scoped git tokens, secret scanning, egress control do not |
| §4 plan approval gate | **Partial** | Confirm/reject on manager plans exists; the rich plan record (change shape, tier, declared scope, executable acceptance criteria, assumptions) does not |
| §11 runtime adapter | **Partial** | Contained CLI launcher wraps Codex/Claude; no internal event schema, no capability profiles |
| §3 task states, heartbeat, pinned claim metadata | **Missing (conflicts)** | Board vocabulary is intake-era; no heartbeat; nothing pinned at claim |
| §4 stages (Intake→…→merged), §10 containers, git/PR flow, §5 tiers, §6 onboarding, review/fix + ledgers, §8 scheduling, §12 budgets, §7 decomposition, §9 cross-repo, §2 Outline | **Missing** | The build below |

**Conflicts to migrate, not build around:** the task state machine (v19
schema migration through the single-sourced enums — old open tabs must
tolerate unknown states, a known parked issue); fleet's long-lived lanes vs
per-task containers (lanes become the "local process" runtime adapter during
transition); persistent per-project manager/engineer identities vs stage
prompts (identity/credential machinery is reused for runner credentials);
board pen-documents (frozen now, retired in campaign 9).

## Campaigns

Follows `§15`'s order, with scheduling/budgets and Outline inserted where
their prerequisites exist; each campaign names its design sections and its
exit criterion.

**0. Project picker** *(shipped 2026-08-15)* — registration front door
for onboarding. Exit: add a project by picking a discovered repo. Small;
ships while campaign 1 is specced.

**1. Task record and state machine** *(shipped 2026-08-16; §3; §15 item 1 delta)* — v19
migration to `queued → planning → plan_approval → designing → implementing →
verifying → reviewing → fixing → final_approval → merged` plus
`parked | abandoned | dead_letter`; heartbeat writes and a reconciler keyed
on heartbeat age; claim-time pinning (runtime, version, model, prompts SHA);
per-stage elapsed tracking; forward-tolerant web enum parsing (closes the
parked audit finding). Exit: a task can be driven through the full state
graph by tests, and a killed run is swept and re-entered cleanly.

**2. Worktree + container execution** *(shipped 2026-08-18; §10; item 2)* — one git worktree and
branch per task; Docker `agent` image target for nexus-seventeen itself;
container-per-task lifecycle behind the runtime adapter; egress allowlist;
no prod secrets. Exit: a task runs in a disposable container against its own
worktree and the container's death is uneventful.

**3. Fast verify path** *(shipped 2026-08-19; §5; item 3)* — three-tier test contract in
`workflow.md`, diff-derived fast tier, background execution for long runs;
nexus-seventeen onboards itself as the proof. Exit: fast tier under ~10 s
here, full tier runs headless with tail-only ingestion.

**4. Pipeline v1: Intake → plan gate → Implement → Verify** *(shipped 2026-08-19, local-first — GitHub PR slice deferred; §4; item 4)* —
single runtime; the full plan record (change shape, tier, declared scope,
acceptance criteria, assumptions, decision-enumeration); plan-approval UI;
Implement's bright lines and staged commits; machine-only Verify; PR keyed
on task id with the plan rendered into the body; human merges on GitHub.
Serial execution (one task at a time) defers §8. Exit: a real task flows
request → approved plan → green Verify → PR → merge with no human in the
middle.

**5. Review + Fix loop** *(shipped 2026-08-19; §4; item 5)* — reviewer on a different
runtime/model; structured findings; files-touched vs predicted; fix rounds
(cap 3) with fresh sessions; dead letter; Design stage for hazardous tier
with its failure-point table. Exit: a seeded defect is caught, fixed, and
re-verified without human input.

**6. Ledgers + observability** *(shipped 2026-08-20; §13; item 6)* — findings and park ledgers
with categories; park lifecycle (age, notify, auto-abandon); stage
timeline / round count / heartbeat default view; audit view; redact before
persisting. Exit: recurring finding categories are queryable, park reasons
reviewable.

**7. Scheduling + budgets** *(shipped 2026-08-21; §8, §12)* — scope-overlap claim gating;
per-stage and per-task wall-clock caps; kill switch; base-branch-push
webhook withdrawing a pending final approval. Concurrency >1 turns on here.
Exit: overlapping tasks serialize, a runaway stage is caught by its cap, the
kill switch drains cleanly.

**8. Second runtime + onboarding task type** *(shipped 2026-08-25; §11, §6; item 7)* — internal
event schema, capability profiles, second adapter; onboarding as a pipeline
task producing the doc slots, tiers, `agent` image, and gap report for the
first product repos (start with the Cicada estate's most active pair). Exit:
adding the second runtime touched one adapter + one profile; one external
repo onboarded end to end.

**9. Outline + docs pipeline** *(shipped 2026-08-27; §2)* — self-hosted Outline (Dokploy);
read-only CI publish of repo docs on merge; board pen-documents retired
(export, then remove editor and routes). Runs parallel to 7–8 once 4 exists;
listed here because retirement waits for the replacement. Exit: repo docs
readable in Outline with source banners; Documents page gone.

**9.5. File diet + consolidation** *(shipped 2026-08-27; approved 2026-08-26; from the five-agent
layout/dead-code analysis)* — Tier A: `.gitignore` the `.superpowers/`
scratch; move the company bootstrap into `config/`; mirror-rule fix (move
the 10 collaborator-named tests into
`tests/server/task-board/collaborators/`, relocate the stray persistence
test); delete the completed `docs/superpowers/{plans,specs}` (keep the
active campaign's pair until it ships) + `scripts/agent-container-smoke.mjs`;
dead code (`proposals.ts`+test, `parseWakeupEntity`, `apiEntity`,
`parseTaskPhase`, dead barrel line, `public/cicada-mark.svg`, npm scripts
`dev:task-worker`/`preview`/`test:watch`, `TASK_RETRY_REQUIRED` error code);
move the bootstrap tooling test under `tests/tooling/` and retire its
redundant dedicated build and test entries. Tier B: **consolidate 11 skill
directories into one sectioned `config/skills.md`** (`## <skill-id>`
sections; digests are content-only so plan pins survive); micro-module merges (`runtime/{events,errors}`→`adapter`, the three
SQL-constant files into their hosts, `data/{uuid,concurrency}`→`client`,
`dialog-discard`→`dialog-stack`, `safe-error-detail`→`redact`); remove the
25 barrel-only export lines + strip the 103 redundant `export` keywords;
fold `docs/TASK_FLEET.md` into README; prune the stale 105-line plan section
in `WORKFLOW_ARCHITECTURE.md`; document the 16 undocumented `STEWARD_*` env
vars and `bootstrap:apply`. Tier C: **consolidate 23 prompt files into one
sectioned `config/prompts.md`** (`## <template>` sections, bodies verbatim →
promptsSha and the 10 goldens stay byte-identical); prompt configuration now
uses `promptsFile` and `STEWARD_TASK_WORKER_PROMPTS_FILE`. Explicitly kept:
`scripts/export-documents.mjs` (needed
against the pre-v25 production DB), this roadmap file, all schema fixtures,
`config/`/`docker_image/`/`public/`/tsconfig placement. Exit: non-code tracked
files ≲72, `src`+`tests` ≲260, zero single-file directories outside
mandated conventions, gates + goldens green.

**9.6. Board UX polish** *(shipped 2026-08-28; requested 2026-08-26; spec 2026-08-27)* — no browser-native
dialogs anywhere: replace the pause-reason `globalThis.prompt` at
`BoardApp.tsx:566` with a custom anchored popover (reason field + confirm,
matching the design system) — this is the only native dialog in the app;
rework the "Add a task" full-screen modal (`CreateDialogs.tsx`) into an
anchored/inline surface (popover or side panel) so creating a task never
feels like leaving the task-board page; audit the other create/confirm
modals for the same takeover feel. Exit: zero `globalThis.prompt/confirm/
alert` calls; task creation keeps the board visibly present behind it.
Shipped 2026-08-28; deliberate audit residue left as takeovers: `Cancel work item`,
`Reject proposed plan`, `Request implementation changes`, the agent-type editor, and the project picker.

**9.6.1. Anchored-dialog follow-ups** *(shipped 2026-08-28; parked at the 9.6 fix-wave cap)* —
clean (non-dirty) cross-dialog switches request close twice before React commits
(pending open can be clobbered); clicking the *other* Add-task trigger while the
form is open drops the re-anchor; a `lg` breakpoint crossing during an in-flight
pause hides a later 409/network error and the typed reason; no Playwright flow
opens `Approve and merge pipeline`; the scrimless anchored panel's edge relies on
the elevation shadow alone. None destroys data; a second click or retry recovers.

**9.7. Naming audit** *(queued 2026-08-28; analysis first, renames as reviewed
mechanical tasks)* — sweep code, config, docs, and UI copy for inconsistent
vocabulary (`steward` vs `nexus-seventeen`, `provider` vs `runtime`, `intake` /
`onboarding` / `work item` / `task`, `lane` vs `worker`), file names vs their
primary export, folder names vs the seam they hold, abbreviations and
misleading names; produce a renaming plan with ripple costs and the
migration-sensitive exceptions (Dokploy volume names, pinned identifiers,
external env vars) called out.

**10. Decomposition + cross-repo** *(§7, §9; items 8–9)* — parent/child
tasks, independently-mergeable split rule, expand/migrate/contract phase
sequencing with the human gate on contract. Exit: one blast-radius change
lands as phased children across two repos.

## Migration risks

- **State-machine cutover (campaign 1)** is the contract quake: enums, SQL
  CHECKs, schemas, web, worker, fixtures all move together (single-sourced,
  so one place — but v19 must map every live status and old tabs must
  degrade gracefully).
- **Fleet transition (2–4)**: lanes keep working as the local-process
  adapter until containers prove out; the two coexist behind the adapter
  interface rather than a flag-day swap.
- **Identity repurpose (4)**: manager/engineer identities stop being spawned;
  existing credential/rotation machinery becomes runner credentials. Boards
  with live agents need a mapping, not deletion.
- **Documents (9)**: frozen immediately (decided 2026-08-15), removed only
  after Outline is up — no data loss, export first.
- **GitHub coupling (4, 7)**: PR flow, branch protection, and the push
  webhook assume repos live on GitHub with a service account; org setup is a
  prerequisite task in campaign 4, and the webhook needs a reachable
  endpoint (Tailscale funnel or polling fallback — decided in campaign 7's
  spec).

## Open decisions (deferred to their campaign's spec)

First runtime for pipeline v1 (Codex vs Claude CLI); container base for
non-Node product repos; Outline hosting shape on Dokploy (Postgres/Redis);
whether `AGENTS.md` and `config/` land in this repo or a sibling
orchestrator repo (§2 layout — this repo currently plays both roles);
webhook exposure.

## Out of scope

Multi-operator/multi-tenant concerns; deploy-health post-merge loop beyond a
stub (§12 names it; it needs deployment signals the estate doesn't emit
yet); token/cost accounting (explicitly excluded by §3).
