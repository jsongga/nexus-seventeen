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
it lacks is everything that makes the design an _orchestrator_: the
ten-state task pipeline, git worktrees and PRs, per-task containers, test
tiering, the review/fix loop with a findings ledger, scheduling, budgets,
and Outline. The plan is a retrofit in `§15` build order, not a rewrite: ten
campaigns, each independently shippable, riding on the hardened store.

## Gap analysis

| Design §                                                                                                                                                                         | State                   | Evidence / gap                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3 durable writes, conditional claim, reconciler                                                                                                                                 | **Have**                | Audit campaign: `BEGIN IMMEDIATE` validate-before-write, claim replay protection, ready-node reconciler                                                 |
| §13 event stream (durable → tail, replay)                                                                                                                                        | **Have**                | After-commit events, SSE with sequence cursor                                                                                                           |
| §12 trust boundary (tokens)                                                                                                                                                      | **Partial**             | Credential versioning/rotation/quarantine exist; repo-scoped git tokens, secret scanning, egress control do not                                         |
| §4 plan approval gate                                                                                                                                                            | **Partial**             | Confirm/reject on manager plans exists; the rich plan record (change shape, tier, declared scope, executable acceptance criteria, assumptions) does not |
| §11 runtime adapter                                                                                                                                                              | **Partial**             | Contained CLI launcher wraps Codex/Claude; no internal event schema, no capability profiles                                                             |
| §3 task states, heartbeat, pinned claim metadata                                                                                                                                 | **Missing (conflicts)** | Board vocabulary is intake-era; no heartbeat; nothing pinned at claim                                                                                   |
| §4 stages (Intake→…→merged), §10 containers, git/PR flow, §5 tiers, §6 onboarding, review/fix + ledgers, §8 scheduling, §12 budgets, §7 decomposition, §9 cross-repo, §2 Outline | **Missing**             | The build below                                                                                                                                         |

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

**0. Project picker** _(shipped 2026-08-15)_ — registration front door
for onboarding. Exit: add a project by picking a discovered repo. Small;
ships while campaign 1 is specced.

**1. Task record and state machine** _(shipped 2026-08-16; §3; §15 item 1 delta)_ — v19
migration to `queued → planning → plan_approval → designing → implementing →
verifying → reviewing → fixing → final_approval → merged` plus
`parked | abandoned | dead_letter`; heartbeat writes and a reconciler keyed
on heartbeat age; claim-time pinning (runtime, version, model, prompts SHA);
per-stage elapsed tracking; forward-tolerant web enum parsing (closes the
parked audit finding). Exit: a task can be driven through the full state
graph by tests, and a killed run is swept and re-entered cleanly.

**2. Worktree + container execution** _(shipped 2026-08-18; §10; item 2)_ — one git worktree and
branch per task; Docker `agent` image target for nexus-seventeen itself;
container-per-task lifecycle behind the runtime adapter; egress allowlist;
no prod secrets. Exit: a task runs in a disposable container against its own
worktree and the container's death is uneventful.

**3. Fast verify path** _(shipped 2026-08-19; §5; item 3)_ — three-tier test contract in
`workflow.md`, diff-derived fast tier, background execution for long runs;
nexus-seventeen onboards itself as the proof. Exit: fast tier under ~10 s
here, full tier runs headless with tail-only ingestion.

**4. Pipeline v1: Intake → plan gate → Implement → Verify** _(shipped 2026-08-19, local-first — GitHub PR slice deferred; §4; item 4)_ —
single runtime; the full plan record (change shape, tier, declared scope,
acceptance criteria, assumptions, decision-enumeration); plan-approval UI;
Implement's bright lines and staged commits; machine-only Verify; PR keyed
on task id with the plan rendered into the body; human merges on GitHub.
Serial execution (one task at a time) defers §8. Exit: a real task flows
request → approved plan → green Verify → PR → merge with no human in the
middle.

**5. Review + Fix loop** _(shipped 2026-08-19; §4; item 5)_ — reviewer on a different
runtime/model; structured findings; files-touched vs predicted; fix rounds
(cap 3) with fresh sessions; dead letter; Design stage for hazardous tier
with its failure-point table. Exit: a seeded defect is caught, fixed, and
re-verified without human input.

**6. Ledgers + observability** _(shipped 2026-08-20; §13; item 6)_ — findings and park ledgers
with categories; park lifecycle (age, notify, auto-abandon); stage
timeline / round count / heartbeat default view; audit view; redact before
persisting. Exit: recurring finding categories are queryable, park reasons
reviewable.

**7. Scheduling + budgets** _(shipped 2026-08-21; §8, §12)_ — scope-overlap claim gating;
per-stage and per-task wall-clock caps; kill switch; base-branch-push
webhook withdrawing a pending final approval. Concurrency >1 turns on here.
Exit: overlapping tasks serialize, a runaway stage is caught by its cap, the
kill switch drains cleanly.

**8. Second runtime + onboarding task type** _(shipped 2026-08-25; §11, §6; item 7)_ — internal
event schema, capability profiles, second adapter; onboarding as a pipeline
task producing the doc slots, tiers, `agent` image, and gap report for the
first product repos (start with the Cicada estate's most active pair). Exit:
adding the second runtime touched one adapter + one profile; one external
repo onboarded end to end.

**9. Outline + docs pipeline** _(shipped 2026-08-27; §2)_ — self-hosted Outline (Dokploy);
read-only CI publish of repo docs on merge; board pen-documents retired
(export, then remove editor and routes). Runs parallel to 7–8 once 4 exists;
listed here because retirement waits for the replacement. Exit: repo docs
readable in Outline with source banners; Documents page gone.

**9.5. File diet + consolidation** _(shipped 2026-08-27; approved 2026-08-26; from the five-agent
layout/dead-code analysis)_ — Tier A: `.gitignore` the `.superpowers/`
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

**9.6. Board UX polish** _(shipped 2026-08-28; requested 2026-08-26; spec 2026-08-27)_ — no browser-native
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

**9.6.1. Anchored-dialog follow-ups** _(shipped 2026-08-28; parked at the 9.6 fix-wave cap)_ —
clean (non-dirty) cross-dialog switches request close twice before React commits
(pending open can be clobbered); clicking the _other_ Add-task trigger while the
form is open drops the re-anchor; a `lg` breakpoint crossing during an in-flight
pause hides a later 409/network error and the typed reason; no Playwright flow
opens `Approve and merge pipeline`; the scrimless anchored panel's edge relies on
the elevation shadow alone. None destroys data; a second click or retry recovers.

**9.7. Naming audit** _(queued 2026-08-28; analysis first, renames as reviewed
mechanical tasks)_ — sweep code, config, docs, and UI copy for inconsistent
vocabulary (`steward` vs `nexus-seventeen`, `provider` vs `runtime`, `intake` /
`onboarding` / `work item` / `task`, `lane` vs `worker`), file names vs their
primary export, folder names vs the seam they hold, abbreviations and
misleading names; produce a renaming plan with ripple costs and the
migration-sensitive exceptions (Dokploy volume names, pinned identifiers,
external env vars) called out.

**9.8. Load-tolerant pipeline e2e timing** _(queued 2026-08-29)_ — the
`machine-verify-integration` and `pipeline-e2e` arcs pin fixed windows
("verify sweep did not reach reviewing"; a 122 s kill-switch run gets
wall-clock-parked) and fail whenever a reviewer runs tests concurrently;
campaign 10 needed repeated isolated/quiet reruns; the Playwright
`a pending pause keeps its reason and error when the rail breakpoint changes`
arc is intermittent under load too (0/5 failures isolated, 1/3 loaded). Make the windows scale with
observed sweep latency (or gate on state transitions instead of elapsed
time) so a loaded machine cannot fake a regression.

**9.9. Repository identity separate from the product project** _(specced
2026-09-06 as campaign 16; spec
`docs/superpowers/specs/2026-09-06-repository-identity.md`)_ — a Project has
exactly one `repo_path` and a declared child targets a Project, so the unit of
grouping and the unit of checkout are the same thing. A product whose code spans
several repositories — Cicada Sense/HomeDots is exactly this shape — can either
be one Project it cannot decompose, or several Projects that fragment its agents
and threads. Repositories become records, a Project has many, and a declared
child names one. The seam is that all thirty `repoPath` mentions resolve the same
way today, so one helper that takes a **work item** rather than a project
replaces all eight git call sites at once — a half-converted caller operates on
the wrong tree silently. Migration v26 → v27 is additive: one repository per
existing project, `work_items.repository_id` null everywhere, and
`projects.repo_path` kept as a maintained mirror so a v26 worker still reads
something true. **The rollout order is still workers-first, and the earlier note
here saying otherwise conflated two things.** The schema migration is order-
independent; the claim payload is not — task 4a adds `providerWorkItemId` to
`crossRepoContext`, and `docs/WORKFLOW_ARCHITECTURE.md` records that older
workers use a closed claim schema and reject any claim carrying an unknown
field. Same constraint campaign 10 documented, for the same reason. Exit: a `pipeline-e2e` arc lands two children in one project and
two repositories. Rollout, from review of the v27 migration: take a copy before
upgrading. A pre-existing foreign-key violation in a v26 database now fails
`open()` permanently where the v26 build opened it fine, because reaching
`SCHEMA_VERSION` skips the ladder entirely — and if the ladder is interrupted
mid-climb, rolling the binary back does **not** rescue the database.

**9.10. Credential filter precision at the agent boundary** _(shipped
2026-09-02; queued 2026-08-31)_ — `assertCredentialSafe` rejects a whole prompt,
context, provider output or diagnostic fail-closed, and the context carries the
work item's own words, so "Bearer authentication" — fourteen characters of
ordinary prose — killed an agent run. The bearer rule now requires a **digit**
within twelve or more token characters. Not "a non-letter": `.` `-` `/` `_` are
all token characters, so that rule rejected "Bearer authentication." — the same
bug, one keystroke away — and review caught it before it shipped. Not a length
net either: at any threshold low enough to catch a digit-free token it also
catches `AuthenticationMiddleware`. Two gaps kept as decisions: an all-letter
token passes at any length (0.36% of 32-character base62, ~1 in 8 at twelve,
where tokens are uncommon anyway), and an identifier carrying a digit
("OAuth2Middleware") is still rejected. Persistence redacts in every one of these
cases; only the send path is affected.

**9.11. Move the agent credential boundary from rejection to redaction**
_(proposed 2026-09-02)_ — 9.10 is the third attempt to make a fail-closed filter
precise enough for prose, and each attempt has had a false-positive class found
by review rather than by testing: a length floor rejected "Bearer
authentication", a non-letter rule rejected it with a full stop, a length net
rejected class names. The pattern says the axis is wrong: any rule that guesses
must sometimes guess fatally, because rejection kills a run. Redaction cannot —
a false positive costs the agent one word, replaced by a marker it can see. The
work is not the switch itself but what makes it honest: the agent must be told
its input was altered, and the human must see it in the run's activity, or a
redacted prompt becomes a confusing failure instead of a loud one. Own spec.

**10. Decomposition + cross-repo** _(shipped 2026-08-29)_ — parent/child work
items (`coordinating` parent, children created pre-confirmed at plan confirm),
the independently-mergeable split rule by change shape, Expand → Migrate →
Contract with auto-merge under the parent plan and a human gate on Contract
after deployment attestation, the published-interface rule for consumers
(`docs/interface.md` at the Expand merge sha), and the parent/child web surface.
Exit met: `pipeline-e2e` lands a blast-radius change as phased children across
two repositories with real git and fake CLIs. Rollout notes: v18 → v26 migration
(legacy-quoted tables canonicalized; `projects.repo_path` must be set explicitly
after upgrade — the description fallback is a shim); upgrade workers before the
board (claims now carry `phase` + `crossRepoContext`). Limits: one level of
decomposition; one repository per Project (→ 9.9); an abandoned Expand/Migrate
leaves cancel as the only exit.

**11. Codebase health — formatting, comments, shared plumbing** _(shipped
2026-08-31; proposed 2026-08-29; spec
`docs/superpowers/specs/2026-08-29-codebase-health-audit.md`)_ — prettier at
printWidth 120 as one formatter-only commit, then the adopted comment convention
(`/** header */` + `/* —— Section —— */` banners, ratcheted by a tooling test,
not eslint — the repository has no eslint, which also answers 9.7's D2); one
`server/shared/git.ts` replacing four byte-identical git factories, the
`core.fsmonitor=`/`core.hooksPath=` prelude at twelve sites and two rival
`ls-tree` parsers, with credential-safe failures; one credential vocabulary
under two policies (redaction over-matches, the agent boundary rejects
fail-closed with prose-safe narrowings) and one exported stage→role table; the
web tree flattened out of `src/web/task-board/`, declared-scope checking moved
beside its git runner, one date formatter for eight, one dead barrel and two
dead exports. Exit met: `code-style.test.mjs` green, allowlist 125 → 120 and
only ever shrinking, one `execFileSync("git")` site in `src/`. Corrections to
the audit found during implementation: `task-fleet/index.ts` is not a dead
barrel (`#server/agents/task-fleet` publishes it), and `model/project.ts` is
view projection, not data. Not done here: the persistence/collaborators cycle
(12), web feature seams (13), renames (9.7), the credential filter's remaining
prose false positive (9.10).

**12. Layering and file size** _(shipped 2026-09-01; spec
`docs/superpowers/specs/2026-08-31-layering-and-file-size.md`)_ — the
`persistence/` ↔ `collaborators/` cycle was two import statements, both pointing
at misfiled modules: `work-item-transitions.ts` (a transaction state machine) moved
to `persistence/`, `pipeline-inspection.ts` (a leaf over git) to the task-board
root. `persistence → collaborators` is **0 edges**, held by
`tests/tooling/layer-direction.test.mjs`, which resolves specifiers to real files,
counts subpath imports (`#server/task-board/*` — both reviewers found that hole
independently), follows re-exports transitively across `src/`, and reports rather
than throws on an unresolvable specifier. Then `validate.ts` — 5,068 lines, the
largest file in the repository — split at its banner boundaries into six modules
behind a façade that re-exports the same 112 names, so **zero callers changed**;
generated rather than typed, and held to declaration-level identity (234 before,
234 after, zero body text changed, 29 `export` prefixes). Exit met on both counts.
Follow-ups it named rather than did: `validate/entities.ts` is still 2,163 lines
and wants an `entities/` package around its shared `shape`/`entity` core — the same
mechanical shape as this task; `persistence/workflow.ts` (3,040) is now the
largest file in the repository; and `collaborators/projects.ts` (2,451) still has
undrawn seams.

**13. Web feature seams** _(shipped 2026-09-06; spec
`docs/superpowers/specs/2026-09-02-web-feature-seams.md`)_ — `BoardPage` moved to
routing ownership; 27 prop-driven helpers became six `views/work-item/*` modules
and seven became four `board/*`; the four oversized view files split, with
`WorkspacePages.tsx` deleting itself once its two pages moved out; and
`data/parse.ts` (717) became a 104-line façade over five acyclic modules with
zero caller edits. Every task held to declaration identity — text unchanged
except where a commit says otherwise. Exit, as restated when the campaign was
specced: every file in `src/web` under 600 **except** the shells. Three
exceptions rather than two — `BoardApp.tsx` 1,381, `WorkItemDetail.tsx` 1,237,
and `data/client.ts` 832, whose factory is the same shape of problem (→ 15).
Follow-up the review surfaced: 13 of `parse.ts`'s 15 importers are type-only
and want nothing but `Raw*`, so `parse/types` is the real import target and
the façade is two edits from removable — unlike `validate.ts`, whose caller
migration genuinely may never happen.
The roadmap's original premise for this item was wrong and the split proved it:
`WorkItemDetail`'s five test files overlap on four symbol groups, so the "seam
they already use" does not exist — a test file names a scenario, not a module.

**14. The two web shells** _(proposed 2026-09-02)_ — `WorkItemDetail` (1,169
lines, 40 hook calls, 46 local declarations before ~676 lines of JSX) and
`BoardApp` (1,184, same shape) reduce to composition over extracted hooks. This
is the only part of the web work where a mistake is invisible: moving a
prop-driven component cannot change what renders, but moving a `useState` between
components changes when it resets, and a `useEffect` dependency array can start
firing on a different schedule. Own review budget, own Playwright arcs.
Exit: the audit's original bar — no file in `src/web` over ~600 lines.

**17. Repository-aware agent identity** _(proposed 2026-09-07; found by campaign
16's exit arc)_ — campaign 16 gives a work item a repository on the board side,
and the worker side cannot honour it. A worker's repository comes from its own
static configuration (`task-fleet/runtime.ts` sets
`repositoryPath: config.workingDirectory`) and a claim carries no repository at
all: the board routes work by agent identity, and an agent belongs to a
**project**. That was sufficient while a project had exactly one repository,
because project determined repository. It no longer does — nothing stops a
worker configured for repository A from claiming a child targeting repository B
and committing into the wrong tree. The likely shape is to scope an agent to a
repository rather than a project, so routing by agent identity determines the
checkout again and campaign 10's model generalizes; the alternative is to put
the resolved path on the claim and let a worker refuse work it cannot reach.
Until this ships, decomposition across repositories **within one project** is
modelled but not executable — across projects it works, because a project still
determines a repository there. Exit: the campaign 16 arc in `pipeline-e2e`
un-skips and passes.

**15. The task-board client factory** _(proposed 2026-09-06)_ —
`createTaskBoardClient` is 582 of `data/client.ts`'s 832 lines: one factory, 48
methods, all closing over five mutable `Map`s and a shared `request`. Campaign 13
extracted what was mechanical (agent-query prompts, response envelopes) and
stopped, because getting under 600 means giving those methods an explicit context
object instead of a closure. That is a harder core than `validate.ts`'s shared
helpers were: a mistake produces two contexts where there was one and breaks
caching invisibly rather than failing to compile. Same reason campaign 14 exists,
different technique — a context object, not custom hooks.

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
