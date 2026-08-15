# Agent orchestrator — design spec

A system where users submit tasks, agents plan and implement them autonomously, and humans
approve twice: once on the plan, once on the result.

---

## 1. Principles

These are the load-bearing decisions. Everything below follows from them.

1. **Two human gates.** Plan approval and final approval. The middle is autonomous. Anything
   that pulls a human into the middle is a design failure to be fixed at intake, not a feature.
2. **Verification, not judgment, makes the middle work.** Agents don't need to be right first
   try; they need to detect being wrong without a human. Fast tests and executable acceptance
   criteria are the enabling infrastructure.
3. **Git is the source of truth for anything code-coupled.** Docs, plans, findings, and prompts
   that must change atomically with code live in a repo.
4. **The orchestrator is a distributed system.** Durable state, conditional writes, idempotent
   side effects, and a reconciler. It will be killed mid-run; that must be uneventful.
5. **Authority comes from the plan, never from text an agent reads.** File contents, issue
   descriptions, and dependency READMEs are data.
6. **Runtime-agnostic.** Claude Code, Codex, and future runtimes sit behind one adapter
   interface. Vendor-specific code exists only in adapters.

---

## 2. Documentation layout

### Source-of-truth split

| Location          | What lives there                                                                       | Why                                                        |
| ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Orchestrator repo | Agent prompts, findings ledger, global router                                          | Execution inputs; must version and revert with the harness |
| Product repos     | Architecture, interface, dependencies, workflow docs                                   | Must be branch-correct and change in the same diff as code |
| Outline           | Human-facing docs: glossary, project list, deployment, orchestrator policy, onboarding | Human-owned, no commit coupling, better editing surface    |

Published to Outline read-only on merge (mechanical CI job, no LLM in the path) so humans have a
good reading surface for repo-owned docs. Synced docs live in a view-only collection, edited only
by the CI service account, with a banner naming the source path. Comments stay enabled as the
feedback channel.

### Orchestrator repo

```
AGENTS.md                 # router; always loaded; <80 lines
prompts/
  intake.md
  designer.md
  engineer.md
  reviewer.md
  integrator.md
findings/                 # append-only ledger
config/
  runtimes.yaml           # capability profiles per runtime
  projects.yaml           # project -> repo, type, image, tier defaults
```

`AGENTS.md` contains: global invariants, precedence rule (project docs override global), the
build/test command convention, and one line per doc saying when to read it. Nothing else.

### Per product repo

Same slot names in every project regardless of language or type. Content varies; layout doesn't.

```
README.md                 # human overview
docs/
  architecture.md         # invariants, surprises, invisible wiring, prohibitions
  interface.md            # INBOUND contract — what this project exposes
  dependencies.md         # outbound: timeouts, retry semantics, idempotency requirements
  workflow.md             # build, lint, deploy, and run one test fast
  decisions/              # ADRs, append-only, dated
```

**Required:** `workflow.md` and `architecture.md` always. `interface.md` if anything calls it.
`dependencies.md` if it calls anything.

**`interface.md` must be readable standalone**, with zero links into implementation. A consuming
agent reads only this file. Generated portion (endpoints, types, status codes) comes from routes
or schema and is never hand-maintained. Handwritten portion: auth flow, error semantics,
pagination, rate limits, **which operations are idempotent and how to retry them safely**,
ordering constraints, deprecation status.

**Access rule:** a task working on project A may read project B's `interface.md` and nothing else
from B. If the integration can't be completed from that alone, it's a defect in B's interface doc
— file it as a finding rather than reading around it.

---

## 3. Task model

### States

```
queued -> planning -> plan_approval -> designing -> implementing
       -> verifying -> reviewing -> fixing -> final_approval -> merged
                                            \-> parked
                                            \-> abandoned | dead_letter
```

Reverse edges: `reviewing -> fixing` (defect), `reviewing -> planning` (built the wrong thing),
`fixing -> verifying`, `parked -> {planning|implementing}` on answer,
`final_approval -> implementing` on base-branch push (see §4, Final approval).

### Rules

- **Every stage entry is a durable write before the agent starts.** A reconciler sweeps tasks
  stuck in any stage past a threshold and re-enters cleanly.
- **Claiming is a conditional write**, not a lock:
  `UPDATE tasks SET state='planning', claimed_by=? WHERE id=? AND state='queued' AND claimed_by IS NULL`
  — affected row count resolves the race between workers.
- **All external side effects are idempotent**, keyed on stable IDs: PR creation keyed on task ID,
  comments keyed on finding ID. A resumed task must not open a second PR.
- **Heartbeat from the running agent** distinguishes "working" from "died silently". The
  reconciler keys on heartbeat age, not wall-clock alone.

### Task record

Raw request (immutable, verbatim), enrichment fields, state, tier, change shape, declared scope,
worktree path, branch, PR URL, elapsed time per stage and task total, and — pinned at claim time —
runtime, runtime version, model, and prompts SHA. Without those four you cannot attribute quality
changes to anything.

**Plan and design live in the DB, not on the branch.** They are injected directly into a newly
spawned agent's context rather than read from disk, so a fresh Fix session starts with the same
grounding as Implement did. The plan is also **rendered into the PR description** on PR creation —
goal, assumptions, acceptance criteria, non-goals — so the human at the final gate sees it beside
the diff on GitHub. The DB copy is canonical; the PR body is a projection.

No token accounting. Runaway containment is the per-stage time cap and the round caps.

---

## 4. Pipeline stages

### Intake

**Reads:** raw request; target project's `architecture.md`, `interface.md`, `workflow.md`; global
conventions.

**Produces the plan record:**

- Restated goal, and the raw request preserved verbatim alongside it
- **Change shape**: mechanical sweep | feature work | blast-radius change
- **Split decision** with one line of justification
- Tier: standard | hazardous (hazardous = concurrency, money, auth, migrations, cross-project
  contracts, anything with a retry or timer). **The agent's classification is trusted.** Optionally,
  `projects.yaml` may carry path patterns that force hazardous regardless — migrations directory,
  payments module, auth — as cheap insurance where a wrong call is expensive.
- Declared file scope (directory-prefix granularity)
- Acceptance criteria, written as executable checks
- Explicit non-goals
- **Assumptions list** — every decision where a reasonable person could have gone the other way
- **Declared mechanical/generated portions** of the change (stated, not detected)
- Blocking questions, if any, presented at the gate with a recommended default

**Decision-enumeration pass:** for each acceptance criterion, name every decision required to
satisfy it, then apply the reversibility test — would reversing this later require changing a
published interface, a schema or data already written, or code outside declared scope? If yes it's
a question for the gate. If no it's an assumption.

Never writes code.

### Plan approval (human gate)

Reviews assumptions, non-goals, change shape, and any blocking questions with defaults
pre-selected — so the common case is one click. One revision allowed; a second means the request
itself is unclear.

### Design (hazardous tier only)

**Produces the design record:** state list and legal transitions; for each transition crossing a process
or network boundary, what is durably recorded before the boundary and what the recovery is;
failure-point table (crash before send / after send before response / after response before commit
/ after commit before ack / duplicate delivery / concurrent invocation) with resulting state and
recovery mechanism for each; idempotency key lifecycle — where generated, where persisted, how
reused.

**Standing prohibitions for this stage:**

- Locks are an optimization to reduce duplicate work, never the correctness boundary. Correctness
  comes from conditional writes whose affected-row count resolves the race.
- "Unknown outcome" is a distinct state, never collapsed into failure. Resolved by querying the
  remote, never by assuming.
- Idempotency keys are generated once, persisted with the intent record, reused verbatim on retry.
- Timer, cleanup, and retry paths are participants in the state machine and appear in the
  transition table.

Emits fault-injection cases that become tests in the next stage.

### Implement

**Context:** plan and design records injected directly at spawn. Reads from disk: target project's
`architecture.md` and `conventions/<language>.md`, plus `interface.md` for any other project it
calls.

**Core loop:** write failing test (where criteria allow) -> implement -> **run the fast tier** ->
read actual failure output -> fix -> repeat until green. Does not exit on a red suite. This loop
is what separates the stage from a code generator.

**The inner loop uses the fast tier only** (see §5). Area tier runs once before handing off; full
tier belongs to Verify. Running the full suite every iteration is what quietly burns the task
budget, and its output is ~95% passing-test names that displace useful context.

**Then hygiene, in order:** lint, type check / LSP diagnostics, doc updates in the same commit
(`architecture.md` if invariants or wiring changed, `interface.md` if the published surface
changed, an ADR for a real decision).

**Staged commits, always.** Logical units — schema, then core logic, then wiring, then tests —
never one squashed blob. This is what makes a large diff reviewable without decomposing it.

**Mid-run decisions:** reversible ones are appended to the assumptions list with reasoning and
surfaced at the final gate. Irreversible ones park.

**Before parking, finish what survives either answer.** Record the question with options and a
recommendation, identify answer-independent remaining work, complete it, commit, then park. Do
not build both branches speculatively. Do not write a placeholder for the contested part — leave
an obvious hole named in the park record.

**Bright lines — fire mid-loop, park immediately:** file outside declared scope; unplanned schema
or migration change; new external dependency; change to a published interface; anything the
non-goals excluded; plan found infeasible; deleting or skipping an existing test.

**Must not:** delete files it didn't create (dynamically loaded modules, plugin registrations, and
fixtures look unused to every static analyzer); refactor outside declared scope; modify an existing
test to reach green; modify or skip a test to make a run faster.

**Before handing off:** run the area tier once. If it can't produce a working fast tier for this
project, report that as a gap rather than silently falling back to full-suite runs each iteration.

### Verify

Machine only, no agent. Full tier, lint, type check, acceptance criteria, and fault-injection runs
for hazardous tier. Separate from Implement because it's the objective gate the agent can't
rationalize past. The agent's own green run is a working signal; this is the gate.

### Review

**Different runtime/model from Implement.** A model reviewing its own output shares its blind
spots.

**Reads:** the diff, plus the plan and design records injected at spawn. Not the implementer's
reasoning.

**Checks:** files touched vs. files the plan predicted (highest-signal check — catches scope creep
before reading a line); each acceptance criterion actually met; for hazardous tier, each failure
point traced to the line that guarantees it; docs updated in the same diff; any change to existing
tests, flagged prominently.

**Review depth follows change shape:** spot-check a mechanical sweep, read feature work line by
line, review a blast-radius change per consumer.

**Emits structured findings** — file, line, category, severity, expected vs. actual — appended to
the ledger. Only correctness, security, and plan deviation block. Style nits don't.

### Fix

**Fresh session**, given the diff plus findings, never the prior conversation — by round three a
continued session is full of its own superseded reasoning.

Fixes, then **re-traces the whole flow, not just the patch**. Returns to Verify, never straight to
Review. Capped at 3 rounds.

### Parked

Catches everything abnormal: bright line hit, budget exhausted, plan infeasible, round cap. The
scheduler immediately picks up another task — nothing waits on a human.

**On unpark:** re-validate declared scope against merged work and rebase. If the rebase conflicts
materially, return to Intake, not Implement.

Ages with in-app notification; auto-abandon at threshold.

### Final approval (human gate)

Shows: the diff (via GitHub), the assumptions list with mid-run additions flagged, findings across
all rounds, test results, and files-touched vs. files-predicted. Approve -> human merges on GitHub.
Reject -> back to Fix with a note.

**Base-branch push cancels a pending approval.** A webhook on push to the base branch checks
whether the task is in `final_approval`; if so it withdraws the pending approval, returns the task
to `implementing`, and the agent rebases and re-runs Verify before returning to the gate. Two
requirements: the human who was mid-review gets an in-app notice explaining the withdrawal, or it
reads as a bug; and the rebase is a normal agent step under the same bright lines — if resolving
conflicts would take it outside declared scope, it parks rather than improvising.

---

## 5. Test tiering

Every project defines three tiers in `workflow.md`. This is a required deliverable of onboarding
(§6), not a nice-to-have — the autonomous middle depends on it.

| Tier     | Scope                           | Target            | Used by                               |
| -------- | ------------------------------- | ----------------- | ------------------------------------- |
| **Fast** | Tests matching the current diff | seconds           | Implement inner loop, every iteration |
| **Area** | Affected package or module      | under ~2 min      | Once, before handing to Verify        |
| **Full** | Everything                      | whatever it takes | Verify only                           |

**Why the fast tier is load-bearing.** The Implement loop is write -> run -> read failure -> fix.
Under ~10 seconds, running is cheaper than deciding whether to run, so the agent iterates freely
and one small change per run means a failure points at one cause. Above roughly a minute, running
becomes a decision, the agent batches five changes per run, and a failure could be any of them or
an interaction between them — compounding uncertainty instead of convergence. Slow feedback is
also where "fixed the symptom, introduced a new bug" comes from.

**Deriving the fast command.** Prefer having the agent compute it from its own diff —
`git diff --name-only` against the base, map changed source files to test files by the project's
stated convention, run those paths. This works in any language with no plugin and stays fast as
the suite grows. `workflow.md` states the source-to-test mapping convention; onboarding determines
it.

Framework-native selection is a fine shortcut where it exists: `jest --onlyChanged`,
`vitest --changed`, Go's per-package caching, `pytest --lf` for iterating on a failure (true
change-aware selection needs `pytest-testmon`), Nx or Turborepo affected-graphs in a monorepo.

**Selection is not the same as speed.** A suite running three tests still takes 30 seconds if
setup spins up a database, applies migrations, and seeds fixtures. The real work of onboarding is
usually fixture surgery: keep service dependencies warm in the container across iterations, use
transaction rollback rather than table truncation, and mark slow integration tests so they're
excluded from the fast tier.

**Long runs use background execution, not blocking calls.** Kick the run off writing to a log file,
poll for completion, read the tail. The agent stays responsive, doesn't hold a tool call open past
its harness timeout, and ingests only the tail rather than the entire run. A blocking call that
exceeds the harness timeout returns no result at all — the agent then guesses at whether it passed,
which is worse than a slow failure.

---

## 6. Project onboarding

A first-class task type, run once per project before it accepts real tasks. Flows through the
normal pipeline with a human gate, and doubles as a low-risk proof that the pipeline works against
that repo.

**Deliverables:**

- The five doc slots created — `interface.md`'s mechanical portion generated from routes or schema,
  handwritten layer stubbed
- The `agent` Dockerfile target (§10)
- **The three test tiers defined and verified working**, including the source-to-test mapping
  convention and any fixture surgery needed to make the fast tier fast
- Branch protection configured
- `projects.yaml` entry: repo, type, image, tier defaults, any forced-hazardous path patterns
- A gap report for what it could not fix — no test suite, no lockfile, unfixturable dependencies

The gap report is the important output. A project that can't produce a fast tier will run more
review rounds, and the ledger should be able to show that cost rather than having it appear as
mysterious slowness.

---

## 7. Decomposition

**Decided by the agent at Intake, declared explicitly in the plan. No size thresholds.**

| Change shape                                                           | Split behavior                                                     | Review style         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------- |
| Mechanical sweep (comments, package swap, rename, codemod)             | Never split — splitting leaves the codebase in a mixed state       | Spot-check + tooling |
| Feature work                                                           | Split when pieces are independently mergeable; keep whole when not | Read line by line    |
| Blast-radius change (shared helper, published interface, schema, auth) | Split by consumer or phase regardless of size                      | Per consumer         |

**Hard requirement for any split:** each child must be independently mergeable and leave the system
working. If child 2 breaks main until child 3 lands, the decomposition is wrong.

Parent task = grouping with a completion condition and a single final approval. Children flow
through the normal pipeline; independent ones run in parallel, dependent ones queue on edges.

Generated and mechanical portions are **declared in the plan**, not detected by heuristic.

---

## 8. Scheduling and concurrency

- **Concurrency is across tasks, not within one.** Two agents in one worktree produce lost updates.
  If work splits into independent file sets, that's two tasks.
- **Scope-overlap check gates the claim.** A task whose declared scope overlaps an in-flight task's
  queues instead of starting. Directory-prefix matching, conservative — a false serialization costs
  latency, a false parallelization costs a merge conflict found after two expensive runs.
- **One git worktree and branch per task.** For a monorepo, scope is package/directory paths rather
  than repo names; the mechanism is unchanged.
- Parallel within a task is limited to read-only exploration (Intake) and independent verification
  jobs (Verify).
- Per-task wall-clock cap prevents a long task from starving the queue.

---

## 9. Cross-repo changes

Cross-repo atomicity does not exist. Three phases, each an independently safe child task:

1. **Expand** — provider adds the new capability alongside the old, publishes updated
   `interface.md`, merges and deploys alone. Old consumers unaffected.
2. **Migrate** — one child per consumer repo, all parallel (different repos, no scope overlap).
   Each reads the provider's published interface, never the provider's source.
3. **Contract** — provider removes the old path. Gated on all migrate children merged **and
   deployed**. Requires a human gate regardless of tier — it's the only irreversible step.

**Rollback rule:** additive changes only; new code tolerates old data; new sentinel values that old
code silently accepts are a deploy-order bug, not a code bug.

---

## 10. Execution environment

Docker container per task, torn down at task end.

**Image:** add an `agent` target to the existing Dockerfile, branching off the same base and
dependency layers as prod, installing dev deps and tooling rather than pruning them. Prod images
strip exactly what agents need — test runner, linters, language server, git, source. Sharing the
lower layers keeps builds fast and the base environment identical to CI.

**Differences from the prod container:**

- **No prod secrets.** Model API keys and a repo-scoped token only. Never inherit a prod database
  URL.
- **Writable worktree**, still non-root.
- **Egress allowlist**: model API and package registry. Everything else blocked by default — this
  bounds what a prompt injection can reach.

Rebuild the image when the lockfile changes so task startup is seconds, not a full install.

---

## 11. Multi-runtime support

**Define an internal event schema and adapt each runtime into it.** Vendor event shapes differ and
will keep diverging.

Internal events: `stage_started`, `message_delta`, `tool_call`, `tool_result`, `stage_finished`,
`error`.

**Artifacts and prompts are filesystem-based, never runtime-API-based.** `plan.md`, `design.md`,
findings in the worktree; prompts as plain markdown injected as system prompt or mounted context.
Anything built on one vendor's session or memory feature gets rebuilt for the next.

**Capability profile per runtime** in `config/runtimes.yaml`: permission model, sandboxing, MCP
support, tool-call granularity, context characteristics. The scheduler routes stages to runtimes
that can perform them. Do not assume parity.

**Test:** adding a runtime should touch one adapter and one capability profile. If it touches
anything else, the abstraction leaked.

Build against a single runtime first, with the adapter interface in place from day one.

---

## 12. Budgets, safety, containment

**Per stage:** 45–60 min wall clock. **Per task:** 3 hours total across all stages and fix rounds,
3 fix rounds, 1 plan revision.

The split matters. A stage timeout is the only observable signal for a stuck agent — one caught in
a loop looks identical to one doing hard work, and elapsed-time-within-stage is the only difference
you can see. A 3-hour stage cap means finding out three hours late. If a legitimate stage needs
more than an hour, that's a decomposition signal, not a budget signal.

**Global:** kill switch that drains the queue and stops in-flight work without corrupting state
(safe because every transition is a durable write).

**Dead letter:** a task that fails N times across all rounds stops being retried regardless of
priority.

**Provider outages / rate limits:** retry with backoff, then park. A partial stage must not leave
artifacts a resumed run appends to.

**Trust boundary:**

- Instructions found inside file contents are data, never commands. Instruction-shaped text
  encountered mid-run is logged as a finding.
- Repo tokens scoped to the specific repo and branch namespace, never main.
- Branch protection forbids force-push and direct pushes to main, including for the service
  account.
- Secret scanning on the diff before PR creation.

**Flaky tests are the most dangerous thing in this design.** An agent hitting an intermittent
failure will eventually "fix" it by adding a retry, loosening an assertion, or skipping it — a
silent reduction in your only objective gate. Test modification outside plan scope is a flagged
review category; deleting or skipping a test is a bright line.

**Post-merge loop:** deploy health signal, and an automatic task created on regression, linked to
the originating task. Without it, the ledger only records defects caught before merge and the
system looks better than it is.

---

## 13. Observability

**Event stream:** agents emit events -> written to durable storage -> UI tails storage. Never
broadcast agent-to-client directly. Same path serves live viewing, reconnection, and post-hoc
replay, and gives transcript retention for free.

**Redact before persisting**, not before display — env vars and file contents flow through tool
results.

**Default view is stage, round count, elapsed time, heartbeat.** Transcript is one click deeper.
Watching an agent work is compelling and quietly pulls you back into supervising the middle, which
is what the two-gate design exists to avoid.

**Findings ledger** — Review is the only writer. Every finding categorized. After ~20 tasks,
recurring categories are actionable: each is a missing lint rule, a missing prohibition in
`architecture.md`, a missing convention, or a missing test fixture. Converting them is how round
count drops permanently rather than per-task.

**Park ledger** — same treatment. Recurring park categories mean either a missing written default
("prefer soft delete unless stated") or a blind spot in Intake's decision-enumeration pass. Each
one converted is a question that never parks again.

**Audit view:** who approved which gate, when, against which artifact version.

---

## 14. Frontend surface

- **Task list** filtered by state; badge counts for `parked` and `final_approval`.
- **Task detail:** plan, assumptions (mid-run additions flagged), findings by round, test results,
  files predicted vs. touched, stage timeline.
- **Diff:** rendered read-only inline for context; approve/merge redirects to GitHub, which stays
  the system of record.
- **Transcript:** virtualized list, tool calls collapsed by default, one click from task detail.
- **Notifications:** records in the DB with a delivery adapter, so adding email or Slack later is
  one adapter rather than a redesign.

---

## 15. Build order

1. Durable task state + conditional-write claiming + reconciler
2. Container execution + worktree isolation
3. Fast verify path (single command, ~10s relevant test run)
4. Intake -> plan approval -> implement -> verify, single runtime
5. Review + fix loop with structured findings
6. Findings ledger + park ledger
7. Second runtime adapter
8. Decomposition / parent-child tasks
9. Cross-repo phase sequencing

Items 1–3 are infrastructure; nothing works reliably without them. Items 6 is what makes quality
improve over time rather than plateau.
