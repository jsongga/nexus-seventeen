# Orchestrator campaign 3 — fast verify path

Status: Approved in brainstorming (operator picked full-tier composition and
approved the design; spec open for review)
Author: Claude, from `orchestrator-design.md` §5 and `orchestrator-roadmap.md`
campaign 3
Date: 2026-08-18
Scope: the three-tier test contract in `docs/workflow.md`, a diff-derived
fast tier, a verify library + CLI with background execution for long runs —
nexus-seventeen onboarding itself as the proof

## Summary

§5 makes the Implement inner loop's speed load-bearing: under ~10 seconds an
agent runs tests after every small change and failures point at one cause;
above a minute it batches changes and failures stop converging. Today this
repo's only verification commands are all-or-nothing: `test:runtime` cleans
and rebuilds everything before running every server/shared test, so a
one-line change pays the full-build price every iteration.

This campaign installs the missing middle: a machine-readable three-tier
contract in `docs/workflow.md` (the repo's first §2 doc slot), a
`verify` library and CLI that derives the fast tier from the current git
diff, and background execution with tail-only ingestion for the full tier.
Campaign 4's Verify stage is the intended consumer of the library; until
then the CLI is the proof and the operator's tool.

**Measured basis (2026-08-18, this machine):** full `tsc --noEmit` on the
runtime config is ~1.8 s; one compiled test file runs in ~0.13 s. The 10 s
budget is spent almost entirely in the `clean + full rebuild` chaining, not
in test execution — so the design's critical surgery is incremental
compilation, not test parallelism.

**Full-tier composition (operator decision, 2026-08-18):**
`typecheck:all` + `test:all` + `test:container` (Docker required). Playwright
`test:e2e` stays outside the tiers — it needs browsers and a running web
app, and no pipeline consumer exists for it yet; revisit at campaign 8
onboarding.

## The contract — `docs/workflow.md`

The first §2 per-repo doc slot this repo grows. Human-readable sections on
build, test, and run; inside it, exactly one fenced ```json block is the
machine contract the verify library parses:

- `version: 1`, closed-world validated in the fleet-config `exact()` style —
  unknown fields reject, malformed contract refuses to run (it is
  load-bearing; no silent defaults).
- `tiers.fast` — `diffDerived: true`, a compile step (incremental, below),
  and the ordered **mapping rules** (next section).
- `tiers.area` — same compile step; changed areas map to whole test
  directories. Target: under ~2 minutes (expected ~10–20 s here).
- `tiers.full` — the three commands above, run sequentially; Verify-only;
  always executed in the background runner.

The prose around the block explains the tiers for humans and states the
source-to-test convention in words, per §5's "workflow.md states the
mapping convention."

## Diff-derived mapping (fast tier)

`git diff --name-only <base>` (default base: `main`; `--base` overrides;
untracked files included via `git status --porcelain`) feeds ordered rules;
first match wins per file:

| Changed path | Fast-tier selection |
| --- | --- |
| `tests/container/**` | **escalate** — docker-gated tests cannot run in the fast tier; the run reports "run full" |
| `tests/**/*.test.ts` | itself (compiled path under `.test-dist/`) |
| `package.json`, `package-lock.json`, `tsconfig*.json` | **escalate** — build-affecting, unmappable |
| `src/server/<area>/.../<name>.ts` | mirror `tests/server/<area>/.../<name>.test.ts` if it exists, else that test directory |
| `src/shared/**` | all of `tests/shared/**` plus all of `tests/server/**` mirror dirs that import the contract — approximated as `tests/server/**` (the contract is imported everywhere; precision here is not worth import-graph analysis) |
| `src/web/**` | co-located spec (`<name>.test.ts`/`.test.tsx` sibling) via `vitest run <files>` when it exists, else `vitest run src/web` |
| `tooling/**` | `vitest run tooling` |
| `deploy/**`, `Dockerfile`, `scripts/**` | dockerless container-adjacent tests: `tests/server/agents/task-container/**` |
| `docs/**`, `*.md` | nothing (documentation) |
| anything unmatched | **escalate: the fast run fails closed with "unmapped change, run area/full"** — never a silent skip |

A mapping rule that selects a test path that does not exist fails the run
naming the rule — that is a mapping bug to fix, not a skip. Area tier uses
the same rules at directory granularity: each changed file's area maps to
its whole `tests/<...>/` directory (web/tooling map to their whole vitest
target).

## The runner — `src/server/agents/verify/`

Library first, CLI on top, so campaign 4's Verify stage consumes functions,
not shell strings.

- **`contract.ts`** — locate `docs/workflow.md` from the repo root, extract
  the single fenced json block, validate closed-world, return the typed
  contract. Two fenced json blocks or zero: error.
- **`mapping.ts`** — pure: `(changedFiles, rules) → selection`, where
  selection is node-test file list + vitest targets + `escalate` flag.
  Table-driven tests; no filesystem access except an injected
  `fileExists` for mirror checks.
- **`runner.ts`** —
  - fast/area: run foreground, streaming output through; exit code is the
    verdict. Steps: incremental compile, then the selected runners.
  - full: **background only**. Detached spawn, stdout+stderr appended to
    `.verify-runs/<id>/log`; `status.json` holds `{id, tier, command,
    pid, startedAt, endedAt?, exitCode?}`, written atomically on start and
    on exit (a wrapper process records the exit — the detached child is a
    small supervisor script, not the bare command, so exit codes are
    always captured). `status(id)` reads the file and probes the pid: a
    missing pid with no recorded exit reports `died`. `tail(id, bytes)`
    reads only the final N bytes (default 4 KB) — tail-only ingestion per
    §5. `.verify-runs/` is gitignored.
- **`main.ts`** — CLI: `verify fast [--base <ref>]`, `verify area
  [--base <ref>]`, `verify full` (prints the run id and returns
  immediately), `verify status <id>`, `verify tail <id> [--bytes N]`,
  `verify list`. npm scripts `verify:fast`, `verify:area`, `verify:full`
  wrap the first three.

## Incremental compilation (the fixture surgery)

The fast/area compile step must not clean. New npm scripts
`build:runtime:fast` and a matching fast test-compile:

- `tsc -p tsconfig.runtime.json --incremental` and `tsc -p
  tsconfig.test.json --incremental`, with `tsBuildInfoFile` placed INSIDE
  `build/` and `.test-dist/` respectively — the existing `clean:runtime`/
  `clean:tests` scripts then invalidate the buildinfo together with the
  output, closing the classic trap where a surviving tsbuildinfo makes tsc
  skip re-emitting into a deleted directory.
- The schema-write step (`write-agent-result-schema.mjs`) runs after the
  incremental compile (it is milliseconds).
- The existing `build:runtime` / `test:runtime` clean paths are untouched:
  CI-shaped commands keep their from-scratch guarantee; the tiers are the
  only consumers of the incremental path.

Expected fast-tier wall clock on this repo: ~3–6 s warm (incremental
compile + a handful of test files), first run after a clean ~8–10 s.

## Error handling

- Not a git repo / unknown base ref → clear error naming the base.
- Unparseable or missing workflow.md contract → refuse to run any tier.
- Unmapped changed file → fast tier fails closed telling the agent to run
  area/full (exit code distinct from test failure: 2 = escalate, 1 = tests
  failed, 0 = green).
- Background run whose supervisor died → `status` reports `died`; stale
  `.verify-runs` entries beyond a count cap (keep the 10 most recent) are
  pruned oldest-first on new runs.

## Testing

- Unit (always green, dockerless): contract extraction/validation; mapping
  table incl. mirror-exists fallback, escalation, nonexistent-selection
  error; runner background lifecycle against fake commands (start → status
  running → exit recorded; kill supervisor pid → `died`; tail returns only
  the last N bytes; prune cap).
- Integration (in the normal runtime suite): `verify fast` end-to-end
  against a temp git repo fixture with a miniature workflow.md and stub
  test commands — asserting selection, exit codes, and that no clean step
  ran.
- **Exit-criterion proof (controller-run, on this repo itself):** touch one
  runtime source file → `npm run verify:fast` green in under 10 s
  wall-clock; `verify full` started headless, progress observed only via
  `status`/`tail`, completes green (Docker running). Recorded in the
  campaign ledger with measured times.

## Alternatives considered

- **Pure npm-script chains, no library** — the diff mapping needs real
  logic, and campaign 4 needs callable functions with typed results;
  shell strings would be re-parsed by the next consumer. Rejected.
- **Framework-native selection as the primary mechanism** — `vitest
  --changed` covers only the web slice; `node --test` has no
  changed-selection; §5 itself prefers portable diff-derived mapping.
  Native selection remains a permitted shortcut inside the web rule.
- **Import-graph analysis for precise `src/shared` mapping** — precision
  is not worth a TS dependency-graph walker for a contract imported by
  effectively every server test; the approximation (run `tests/server/**`)
  keeps shared-contract changes honest at area-tier cost.
- **Running TS tests directly via Node type-stripping** (skip compilation
  entirely) — the `#server/*` subpath imports resolve into `build/`, so
  source-direct execution breaks module resolution; restructuring imports
  is far outside this campaign's scope. Incremental tsc achieves the
  budget without touching module layout.
- **Playwright in the full tier** — needs browsers and a served web app;
  no pipeline consumer; deferred to campaign 8 onboarding (operator
  decision).
