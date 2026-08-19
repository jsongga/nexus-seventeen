# Campaign 3 — Fast Verify Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A diff-derived three-tier verify path — `verify:fast` under 10 s, `verify:area` under 2 min, `verify full` background-only with status/tail ingestion — driven by a machine-readable contract in `docs/workflow.md`.

**Architecture:** Incremental (no-clean) compile scripts remove the build tax; a `verify` library (`contract.ts` parse → `mapping.ts` pure diff→selection → `runner.ts` foreground/background execution) with a thin CLI on top; the contract lives as one fenced json block in the repo's first §2 doc slot.

**Tech Stack:** Node 24 / TypeScript, `node:test` on compiled `.test-dist` output, tsc `--incremental`, no new npm dependencies (hand-rolled mini-glob).

**Spec:** `docs/superpowers/specs/2026-08-18-fast-verify-path-design.md`

## Global Constraints

- **No new npm dependencies** (repo has exactly 3 runtime deps). Glob matching is a ~20-line hand-rolled `**`/`*` → RegExp converter.
- **Runtime tests are `node:test`** under `tests/`, compiled via `tsc -p tsconfig.test.json` into `.test-dist/`, importing production code via `#server/...` subpath imports resolving into `build/`.
- **Existing clean paths untouched:** `build:runtime`, `test:runtime`, `test:container`, `test:all` keep their exact current behavior (from-scratch guarantee). The tiers are the only consumers of the new incremental scripts.
- **tsbuildinfo lives inside the output dirs** (`build/.tsbuildinfo`, `.test-dist/.tsbuildinfo`) so the existing clean scripts invalidate it with the output — a surviving buildinfo over a deleted output dir would make tsc skip re-emitting.
- **Exit codes:** 0 = green, 1 = tests failed, 2 = escalate (unmapped/build-affecting/docker-gated change) — distinct and stable; campaign 4 will branch on them.
- **Fail closed:** unparseable/missing contract refuses to run; unmapped changed file escalates; a mapped test path that doesn't exist fails naming the rule. Never a silent skip.
- **Full tier = `npm run typecheck:all` + `npm run test:all` + `npm run test:container`**, background-only, tail-only ingestion (default 4096 bytes). Playwright excluded (operator decision).
- **`.verify-runs/` is gitignored**; keep the 10 most recent runs, prune oldest-first on new runs.
- **Behavior-preserving for all existing suites:** every pre-existing test passes unmodified.
- **Sandbox note for implementers (Codex):** no Docker, loopback network only. Run `npm run typecheck:runtime` and `npm run test:runtime` as your gate. Steps marked **[orchestrator verify]** (timing proofs, full-tier docker run) are executed by the controller afterward — say in your report that you did not run them.
- **Commit after each task** on branch `campaign-3-fast-verify`; never commit with failing tests. The controller stages and commits — leave the tree dirty.

## File Map

| File | Task | Responsibility |
| --- | --- | --- |
| `tsconfig.runtime.json`, `tsconfig.test.json`, `package.json` (scripts), `.gitignore` | 1 | Incremental compile path (`build:runtime:fast`, `build:tests:fast`), buildinfo placement, `.verify-runs/` ignore |
| `docs/workflow.md` (create) | 2 | Human build/test/run doc + the fenced json machine contract |
| `src/server/agents/verify/contract.ts`, `index.ts` (create); `package.json` (imports) | 2 | Contract extraction + closed-world validation |
| `src/server/agents/verify/mapping.ts` (create) | 3 | Pure diff→selection mapper incl. mini-glob |
| `src/server/agents/verify/runner.ts`, `supervisor.ts` (create) | 4 | Foreground tier runs; background full runs with status/tail/prune |
| `src/server/agents/verify/main.ts` (create); `package.json` (scripts) | 5 | CLI (`fast|area|full|status|tail|list`) + `verify:*` npm scripts + integration test |
| `orchestrator-roadmap.md` | 6 | Campaign 3 status annotation; exit-criterion proof is controller-run |
| Tests: `tests/server/agents/verify/{contract,mapping,runner,integration}.test.ts` | 2–5 | Per-component suites |

---

### Task 1: Incremental compile path

**Files:**
- Modify: `tsconfig.runtime.json` (compilerOptions), `tsconfig.test.json` (compilerOptions), `package.json` (two scripts), `.gitignore`

**Interfaces:**
- Produces (Tasks 2–5 rely on): npm scripts `build:runtime:fast` = `tsc -p tsconfig.runtime.json && node scripts/write-agent-result-schema.mjs` and `build:tests:fast` = `tsc -p tsconfig.test.json` — both incremental, neither cleans.

Changes, exactly:

- `tsconfig.runtime.json` compilerOptions gains:

```json
    "incremental": true,
    "tsBuildInfoFile": "build/.tsbuildinfo",
```

- `tsconfig.test.json` compilerOptions gains (overriding the inherited path — the two projects must never share a buildinfo):

```json
    "incremental": true,
    "tsBuildInfoFile": ".test-dist/.tsbuildinfo",
```

- `package.json` scripts (alongside the existing ones, which do not change):

```json
    "build:runtime:fast": "tsc -p tsconfig.runtime.json && node scripts/write-agent-result-schema.mjs",
    "build:tests:fast": "tsc -p tsconfig.test.json",
```

- `.gitignore` gains a line: `.verify-runs/`

- [ ] **Step 1: Make the edits above.**
- [ ] **Step 2: Verify incrementality behaviorally**

Run, in order, and record the timings in your report:
```bash
npm run build:runtime 2>&1 | tail -1          # clean path still works
time npm run build:runtime:fast               # first incremental run (warms buildinfo)
time npm run build:runtime:fast               # second run — must be substantially faster (~<2s)
ls build/.tsbuildinfo                          # buildinfo inside the output dir
npm run clean:runtime && ls build/.tsbuildinfo 2>&1 | tail -1   # clean removes it (No such file)
npm run build:runtime:fast 2>&1 | tail -1     # re-emits fully after clean (build/ repopulated)
ls build/server/agents/verify 2>/dev/null; ls build/server/task-board/main.js
```
Expected: second fast run visibly faster than first; buildinfo removed by clean; post-clean fast build repopulates `build/` (this is the trap check — if `build/` stayed empty, the buildinfo placement is wrong).

- [ ] **Step 3: Full regression** — `npm run test:runtime` → all pass (the clean path must be unaffected).
- [ ] **Step 4: Commit** — `git add tsconfig.runtime.json tsconfig.test.json package.json .gitignore` … `chore: incremental compile path for verify tiers`

---

### Task 2: Contract — `docs/workflow.md` + `contract.ts`

**Files:**
- Create: `docs/workflow.md`, `src/server/agents/verify/contract.ts`, `src/server/agents/verify/index.ts`
- Modify: `package.json` (imports: `"#server/agents/verify": "./build/server/agents/verify/index.js"`, `"#server/agents/verify/*": "./build/server/agents/verify/*.js"`)
- Test: `tests/server/agents/verify/contract.test.ts`

**Interfaces:**
- Produces (Tasks 3–5 rely on — exact shapes):

```typescript
export type VerifyRuleAction =
  | Readonly<{ kind: "self" }>                       // the changed test file itself
  | Readonly<{ kind: "mirror" }>                     // src mirror → test file, fallback its test dir
  | Readonly<{ kind: "fixed"; nodeTestDirs?: readonly string[]; vitest?: readonly string[] }>
  | Readonly<{ kind: "colocated"; vitestFallback: string }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "escalate" }>;

export interface VerifyRule { readonly match: string; readonly action: VerifyRuleAction }

export interface VerifyContract {
  readonly version: 1;
  readonly compile: readonly string[];               // npm commands, run in order before fast/area tests
  readonly rules: readonly VerifyRule[];             // ordered, first match wins
  readonly full: readonly string[];                  // npm commands, run in order, background-only
}

export class VerifyContractError extends Error {}    // name: "VerifyContractError"

/** Reads <repoRoot>/docs/workflow.md, extracts exactly one fenced ```json block, validates closed-world. */
export function loadVerifyContract(repoRoot: string): Promise<VerifyContract>
export function parseVerifyContract(markdown: string): VerifyContract   // pure; exported for tests
```

Validation rules (closed-world, `exact()`-style like `task-fleet/config.ts`): unknown top-level or per-rule fields throw; `version` must be 1; `compile`/`full` are non-empty arrays of non-empty strings ≤512 chars without control chars; `rules` non-empty, ≤64 entries; `match` is a glob ≤256 chars; `action.kind` one of the six; `fixed` requires at least one of `nodeTestDirs`/`vitest`; extraction errors ("no fenced json block", "multiple fenced json blocks", invalid JSON) are `VerifyContractError`s with those phrases.

`docs/workflow.md` content — write exactly this (prose may be lightly re-worded, the json block is exact):

````markdown
# Workflow — nexus-seventeen

How to build, test, and run this repo. The fenced `json` block below is the
machine-readable verify contract consumed by `npm run verify:*`
(`src/server/agents/verify/`); edit it and the prose together.

## Build

- `npm run build` — full build (runtime tsc → `build/`, web vite → `dist/`).
- `npm run build:runtime:fast` — incremental runtime build, no clean. Used by
  the verify tiers; CI-shaped commands use the clean `build:runtime`.

## Test tiers

Three tiers per orchestrator-design §5. Fast is diff-derived: changed files
map to tests by the conventions encoded in the contract's `rules` (source
`src/server/a/b.ts` mirrors to `tests/server/a/b.test.ts`; web specs are
co-located; docker-gated `tests/container` and build-affecting files
escalate). Unmapped changes fail closed to a bigger tier — exit code 2.

| Tier | Command | Scope | Target |
| --- | --- | --- | --- |
| fast | `npm run verify:fast` | tests matching the current diff | < 10 s |
| area | `npm run verify:area` | whole test dirs of changed areas | < 2 min |
| full | `npm run verify:full` | everything incl. docker-gated | background |

Full runs in the background: the command prints a run id; observe with
`node build/server/agents/verify/main.js status <id>` / `tail <id>`.

```json
{
  "version": 1,
  "compile": ["npm run build:runtime:fast", "npm run build:tests:fast"],
  "rules": [
    { "match": "tests/container/**", "action": { "kind": "escalate" } },
    { "match": "tests/**/*.test.ts", "action": { "kind": "self" } },
    { "match": "tests/**", "action": { "kind": "escalate" } },
    { "match": "src/server/**/*.ts", "action": { "kind": "mirror" } },
    { "match": "src/shared/**", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server", "tests/shared"] } },
    { "match": "src/web/**", "action": { "kind": "colocated", "vitestFallback": "src/web" } },
    { "match": "tooling/**", "action": { "kind": "fixed", "vitest": ["tooling"] } },
    { "match": "deploy/**", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/task-container"] } },
    { "match": "Dockerfile", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/task-container"] } },
    { "match": "scripts/**", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/task-container"] } },
    { "match": "docs/**", "action": { "kind": "none" } },
    { "match": "**/*.md", "action": { "kind": "none" } },
    { "match": "package.json", "action": { "kind": "escalate" } },
    { "match": "package-lock.json", "action": { "kind": "escalate" } },
    { "match": "tsconfig*.json", "action": { "kind": "escalate" } },
    { "match": ".gitignore", "action": { "kind": "none" } }
  ],
  "full": ["npm run typecheck:all", "npm run test:all", "npm run test:container"]
}
```

## Run

- Board: `npm run dev:task-board` · fleet: `npm run dev:task-fleet` (config
  via `STEWARD_TASK_FLEET_CONFIG`) · web dev server: `npm run dev`.
````

- [ ] **Step 1: Write the failing tests** — `tests/server/agents/verify/contract.test.ts`, `node:test` + `assert/strict` style:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVerifyContract, parseVerifyContract, VerifyContractError } from "#server/agents/verify";

test("parses the real repo contract from docs/workflow.md", async () => {
  const contract = await loadVerifyContract(process.cwd());
  assert.equal(contract.version, 1);
  assert.deepEqual(contract.compile, ["npm run build:runtime:fast", "npm run build:tests:fast"]);
  assert.deepEqual(contract.full, ["npm run typecheck:all", "npm run test:all", "npm run test:container"]);
  assert.equal(contract.rules[0]?.match, "tests/container/**");
  assert.equal(contract.rules[0]?.action.kind, "escalate");
  assert.ok(contract.rules.length >= 10);
});

test("rejects malformed contracts closed-world", () => {
  const wrap = (json: string) => "# t\n\n```json\n" + json + "\n```\n";
  assert.throws(() => parseVerifyContract("# no block here"), VerifyContractError);
  assert.throws(() => parseVerifyContract(wrap("{}") + wrap("{}")), /multiple fenced json blocks/u);
  assert.throws(() => parseVerifyContract(wrap("not json")), VerifyContractError);
  assert.throws(() => parseVerifyContract(wrap('{"version":2,"compile":["x"],"rules":[{"match":"a","action":{"kind":"none"}}],"full":["y"]}')), /version/u);
  assert.throws(() => parseVerifyContract(wrap('{"version":1,"compile":["x"],"rules":[{"match":"a","action":{"kind":"none"}}],"full":["y"],"extra":1}')), /unknown field/iu);
  assert.throws(() => parseVerifyContract(wrap('{"version":1,"compile":["x"],"rules":[{"match":"a","action":{"kind":"fixed"}}],"full":["y"]}')), /fixed/u);
  assert.throws(() => parseVerifyContract(wrap('{"version":1,"compile":[],"rules":[{"match":"a","action":{"kind":"none"}}],"full":["y"]}')), /compile/u);
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test:runtime` → FAIL (unresolvable `#server/agents/verify`).
- [ ] **Step 3: Implement** `contract.ts` (extraction via a `/^```json\s*$[\s\S]*?^```\s*$/mu`-style scan collecting ALL fenced json blocks, erroring on 0 or >1; validation helpers modeled on `task-fleet/config.ts`'s `record`/`exact`/`text` style), `index.ts` re-exports, `docs/workflow.md`, package.json imports.
- [ ] **Step 4: Run to verify pass** — `npm run typecheck:runtime && npm run test:runtime` → PASS.
- [ ] **Step 5: Commit** — `feat: verify contract in docs/workflow.md with closed-world parser`

---

### Task 3: Diff→selection mapper

**Files:**
- Create: `src/server/agents/verify/mapping.ts` (export from `index.ts`)
- Test: `tests/server/agents/verify/mapping.test.ts`

**Interfaces:**
- Consumes: `VerifyContract`, `VerifyRule` from Task 2.
- Produces (Tasks 4–5 rely on):

```typescript
export type VerifyTier = "fast" | "area";

export interface VerifySelection {
  readonly nodeTestFiles: readonly string[];   // SOURCE paths, e.g. tests/server/agents/task-fleet/config.test.ts
  readonly nodeTestDirs: readonly string[];    // SOURCE dirs, e.g. tests/server/agents/task-fleet
  readonly vitestTargets: readonly string[];   // args for `vitest run`, e.g. src/web or specific files
  readonly escalations: readonly string[];     // changed files that force exit 2, with reason baked in: "<file> (<why>)"
  readonly unmatched: readonly string[];       // files no rule matched (also escalate)
}

export interface MappingHost { fileExists(path: string): boolean; directoryExists(path: string): boolean }

export function globToRegExp(glob: string): RegExp    // exported for tests: `**` = any depth, `*` = within segment
export function mapChangedFiles(
  changed: readonly string[], rules: readonly VerifyRule[], tier: VerifyTier, host: MappingHost,
): VerifySelection
```

Semantics (first matching rule wins per file; results deduped, sorted):

- `self`: fast → the file into `nodeTestFiles`; area → its containing directory into `nodeTestDirs`.
- `mirror`: `src/server/a/b.ts` → `tests/server/a/b.test.ts` (replace leading `src/` with `tests/`, `.ts` → `.test.ts`). fast → that file if `host.fileExists`, else its directory `tests/server/a` if `directoryExists`, else the file goes to `escalations` with reason `no mirror test or directory`. area → the directory (same existence check).
- `fixed`: both tiers → listed `nodeTestDirs` (each must `directoryExists`, else escalation with reason `configured test dir missing`) and `vitest` targets verbatim.
- `colocated`: derive sibling `<name>.test.ts` / `<name>.test.tsx`; fast → that file into `vitestTargets` if it exists, else `vitestFallback`; area → always `vitestFallback`.
- `none`: nothing, both tiers.
- `escalate`: file → `escalations` with reason `rule <match> escalates`.
- No rule matched → `unmatched`.
- The mini-glob: `**` crosses `/`, `*` does not, everything else is literal (regex-escaped); anchored both ends.

- [ ] **Step 1: Write the failing tests** — table-driven over a fake host:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { globToRegExp, mapChangedFiles } from "#server/agents/verify";
import type { MappingHost, VerifyRule } from "#server/agents/verify";

const RULES: readonly VerifyRule[] = [
  { match: "tests/container/**", action: { kind: "escalate" } },
  { match: "tests/**/*.test.ts", action: { kind: "self" } },
  { match: "src/server/**/*.ts", action: { kind: "mirror" } },
  { match: "src/shared/**", action: { kind: "fixed", nodeTestDirs: ["tests/server", "tests/shared"] } },
  { match: "src/web/**", action: { kind: "colocated", vitestFallback: "src/web" } },
  { match: "docs/**", action: { kind: "none" } },
];
const host = (files: string[], dirs: string[]): MappingHost => ({
  fileExists: (p) => files.includes(p),
  directoryExists: (p) => dirs.includes(p),
});

test("globToRegExp semantics", () => {
  assert.ok(globToRegExp("src/server/**/*.ts").test("src/server/a/b/c.ts"));
  assert.ok(!globToRegExp("src/server/*.ts").test("src/server/a/b.ts"));
  assert.ok(globToRegExp("Dockerfile").test("Dockerfile"));
  assert.ok(!globToRegExp("Dockerfile").test("sub/Dockerfile"));
  assert.ok(globToRegExp("tsconfig*.json").test("tsconfig.test.json"));
});

test("mirror fast prefers the exact test file, falls back to dir, escalates when neither exists", () => {
  const h = host(["tests/server/x/a.test.ts"], ["tests/server/x"]);
  const hit = mapChangedFiles(["src/server/x/a.ts"], RULES, "fast", h);
  assert.deepEqual(hit.nodeTestFiles, ["tests/server/x/a.test.ts"]);
  const dirOnly = mapChangedFiles(["src/server/x/b.ts"], RULES, "fast", h);
  assert.deepEqual(dirOnly.nodeTestDirs, ["tests/server/x"]);
  const nothing = mapChangedFiles(["src/server/y/c.ts"], RULES, "fast", h);
  assert.equal(nothing.escalations.length, 1);
  assert.match(nothing.escalations[0] ?? "", /no mirror/u);
});

test("first match wins, escalate and unmatched are reported, docs map to nothing", () => {
  const h = host([], ["tests/server", "tests/shared"]);
  const sel = mapChangedFiles(
    ["tests/container/x.test.ts", "docs/a.md", "weird.bin", "src/shared/contract.ts"],
    RULES, "fast", h,
  );
  assert.equal(sel.escalations.length, 1);
  assert.deepEqual(sel.unmatched, ["weird.bin"]);
  assert.deepEqual(sel.nodeTestDirs, ["tests/server", "tests/shared"]);
});

test("area tier lifts self and mirror to directories and colocated to the fallback", () => {
  const h = host(["src/web/x.test.tsx"], ["tests/server/x"]);
  const sel = mapChangedFiles(
    ["tests/server/x/a.test.ts", "src/server/x/a.ts", "src/web/x.tsx"],
    RULES, "area", h,
  );
  assert.deepEqual(sel.nodeTestFiles, []);
  assert.deepEqual(sel.nodeTestDirs, ["tests/server/x"]);
  assert.deepEqual(sel.vitestTargets, ["src/web"]);
});
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**, **Step 4: `npm run typecheck:runtime && npm run test:runtime` → PASS**, **Step 5: Commit** — `feat: diff-to-selection mapper for verify tiers`

---

### Task 4: Runner — foreground tiers + background full

**Files:**
- Create: `src/server/agents/verify/runner.ts`, `src/server/agents/verify/supervisor.ts` (exports from `index.ts`)
- Test: `tests/server/agents/verify/runner.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 exports.
- Produces (Task 5 relies on):

```typescript
export interface VerifyRunnerOptions {
  readonly repoRoot: string;
  readonly runsRoot?: string;          // default <repoRoot>/.verify-runs
  readonly keepRuns?: number;          // default 10
  /** Command executor injection for tests. Default: spawn via shell:false, argv = command.split(" "). */
  readonly execute?: (argv: readonly string[], options: { cwd: string }) => Promise<number>;
}

export type ForegroundResult =
  | Readonly<{ outcome: "green" }>                                     // exit 0
  | Readonly<{ outcome: "failed"; step: string }>                      // exit 1
  | Readonly<{ outcome: "escalate"; reasons: readonly string[] }>;     // exit 2

export class VerifyRunner {
  constructor(options: VerifyRunnerOptions);
  /** Changed files vs base: `git diff --name-only <base>` + untracked from `git status --porcelain`. */
  changedFiles(base: string): Promise<readonly string[]>;
  /** compile steps, then node --test on selection (compiled paths), then vitest targets. */
  runForeground(tier: "fast" | "area", base: string): Promise<ForegroundResult>;
  startFull(): Promise<string>;                                        // returns run id; prunes beyond keepRuns
  status(id: string): Promise<VerifyRunStatus>;
  tail(id: string, bytes?: number): Promise<string>;                   // default 4096, last N bytes only
  list(): Promise<readonly VerifyRunStatus[]>;
}

export interface VerifyRunStatus {
  readonly id: string;                 // <yyyymmdd-hhmmss>-<4 hex>
  readonly state: "running" | "green" | "failed" | "died";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly command: string;            // display string of the full-tier steps
}
```

Implementation notes (concrete, not optional):

- Selection→execution: `nodeTestFiles`/`nodeTestDirs` are SOURCE paths; convert to compiled: `tests/x/y.test.ts` → `.test-dist/tests/x/y.test.js`, dir → `.test-dist/<dir>/**/*.test.js` glob argument. One `node --test` invocation with all args. Vitest: one `npx vitest run <targets...>` invocation when targets exist. Empty selection with no escalations (e.g. docs-only change): green without running compile — print "nothing to verify".
- Escalations or unmatched non-empty → return `escalate` (no test execution) with the reasons.
- A selected compiled test path that does not exist AFTER compile → `failed` with `step: "selection (<source path> missing after compile — mapping bug)"`.
- Background: `startFull()` creates `<runsRoot>/<id>/`, writes initial `status.json` `{state:"running", exitCode:null, endedAt:null,...}` atomically (tmp+rename), then spawns DETACHED: `node <repoRoot>/build/server/agents/verify/supervisor.js <runDir> <json-encoded argv-list>` with `stdio: "ignore"`, `detached: true`, `unref()`. The supervisor (plain module with a `main` guard) runs each full step sequentially via `spawn(shell:false)`, appending both streams to `<runDir>/log`, stops at first failure, then atomically rewrites `status.json` with `endedAt`, `exitCode`, `state: exitCode===0 ? "green" : "failed"`, and its own record of the failed step appended to the log. It also writes its pid into status.json at start.
- `status()`: read status.json; if `state==="running"` and `process.kill(pid, 0)` throws ESRCH → report `died`.
- Prune: on `startFull`, list run dirs sorted by name (ids sort chronologically), remove oldest beyond `keepRuns - 1` before creating the new one.
- `changedFiles(base)`: `git diff --name-only <base> --` plus untracked (`git status --porcelain` lines starting `??`), deduped, filtering out `.verify-runs/`. Unknown base → error naming the base (`git rev-parse --verify <base>` first).

- [ ] **Step 1: Write the failing tests** — fake `execute` for foreground; real (tiny) commands for background:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerifyRunner } from "#server/agents/verify";
// Foreground tests construct a VerifyRunner over a temp repoRoot containing a
// minimal docs/workflow.md (compile: ["echo compile"], rules as needed) plus a
// fake execute that records argv and returns scripted exit codes. Assert:
// 1. docs-only change → green, zero executions ("nothing to verify").
// 2. escalation (tests/container change) → escalate, zero executions, reason mentions the rule.
// 3. mapped runtime change → executions are exactly [compile1, compile2, node --test <compiled path>] and green when all exit 0.
// 4. a failing test step (exit 1) → failed with that step named; later steps not executed.
// 5. missing compiled file after compile → failed with "mapping bug" in the step.
// Background tests use the REAL supervisor with sh-free tiny commands:
// full: ["node -e process.exit(0)"] style entries written into the temp workflow.md.
// 6. startFull → status running → (poll ≤5s) → green with exitCode 0; log tail contains the child output; tail(id, 8) returns exactly the last 8 bytes.
// 7. full: [passing, failing, never-reached] → failed, log shows the failing step, third step absent.
// 8. kill the supervisor pid mid-run (a sleeping step) → status reports died.
// 9. keepRuns: 2 → third startFull leaves exactly 2 run dirs (newest two).
```

Write these as real tests (the comment block above is the required scenario list — implement each as its own `test()` with full assertions; scenario 6–9's full-step commands must avoid shell features since argv is split on spaces: use `node .test-helpers/exit0.mjs` style helper files written by the test).

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** `runner.ts` + `supervisor.ts`, **Step 4: `npm run typecheck:runtime && npm run test:runtime` → PASS**, **Step 5: Commit** — `feat: verify runner with background full tier and tail-only status`

---

### Task 5: CLI, npm scripts, end-to-end integration test

**Files:**
- Create: `src/server/agents/verify/main.ts`
- Modify: `package.json` (scripts)
- Test: `tests/server/agents/verify/integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4. Produces: the CLI contract below (campaign 4's Verify stage and the operator both consume it).

`main.ts` — argv dispatch, no deps:

```
verify fast [--base <ref>]     → runForeground("fast", base ?? "main"); exit 0/1/2; prints escalation reasons
verify area [--base <ref>]     → same for area
verify full                    → startFull(); prints the run id; exits 0 immediately
verify status <id>             → prints status json; exit 0 (running/green), 1 (failed/died)
verify tail <id> [--bytes N]   → prints the tail; exit 0
verify list                    → one line per run: id, state, startedAt
anything else                  → usage to stderr, exit 64
```

`package.json` scripts:

```json
    "verify:fast": "npm run build:runtime:fast >/dev/null && node build/server/agents/verify/main.js fast",
    "verify:area": "npm run build:runtime:fast >/dev/null && node build/server/agents/verify/main.js area",
    "verify:full": "npm run build:runtime:fast >/dev/null && node build/server/agents/verify/main.js full",
```

(The pre-step guarantees the CLI itself is built; the runner's own compile steps then keep everything else fresh — both are incremental so the double tsc costs ~nothing warm.)

- [ ] **Step 1: Write the failing integration test** — `tests/server/agents/verify/integration.test.ts`: build a temp GIT repo fixture (init -b main, commit a base) containing: `docs/workflow.md` with a miniature contract (compile: `["node compile-marker.mjs"]` which appends to a marker file; rules: mirror for `src/**` plus a `none` md rule; full: two tiny node commands), a `src/x.ts` + matching `tests-fixture` layout matching its rules, and stub test commands. Then drive the REAL CLI via `execFile("node", [join(process.cwd(), "build/server/agents/verify/main.js"), "fast", "--base", "main"], { cwd: fixtureRepo })` after modifying `src/x.ts`:
  - asserts exit code 2 vs 1 vs 0 scenarios (escalating change; failing mapped test; green mapped test),
  - asserts the compile marker ran (and that NO clean happened: pre-create a sentinel file inside the fixture's fake build dir and assert it survives),
  - `full` → id printed; poll real `status` to green; `tail` returns bounded bytes.
  (The fixture's workflow.md rules must select node --test files that exist pre-compiled in the fixture — simplest: the fixture's "compile" is a no-op marker and its mapped "test" is a plain `node` script path listed via a `fixed` rule's vitest… NO — keep it honest: fixture rule `{"match":"src/**","action":{"kind":"mirror"}}` with a real `tests/x.test.ts` present, and the fixture's compile step copies `tests/*.ts` to `.test-dist/tests/*.js` via a 3-line node script so the runner's source→compiled conversion finds real files. Write that copy script into the fixture.)
- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** `main.ts` + scripts, **Step 4: `npm run typecheck:runtime && npm run test:runtime` → PASS**, **Step 5: Commit** — `feat: verify CLI and npm verify scripts`

---

### Task 6: Self-onboarding proof + roadmap

**Files:**
- Modify: `orchestrator-roadmap.md` (campaign 3 lead-in: `**3. Fast verify path** *(§5; item 3)*` → `**3. Fast verify path** *(spec/plan 2026-08-18, in flight; §5; item 3)*` — the controller flips it to shipped after merge)

- [ ] **Step 1: Make the roadmap edit.** Nothing else in the file changes.
- [ ] **Step 2 [orchestrator verify]: Exit-criterion proof on this repo** —
  1. `touch src/server/agents/task-fleet/runtime.ts` (whitespace edit + revert after) then `time npm run verify:fast` → green, **wall clock < 10 s** (record the time).
  2. Change one line in a web component → `time npm run verify:fast` → vitest path exercised, < 10 s warm.
  3. `npm run verify:full` → prints id; observe ONLY via `status`/`tail` until green (Docker running). Record total duration and that ingestion was tail-only.
  4. Edit `package.json` trivially → `verify:fast` exits 2 with the escalation reason.
- [ ] **Step 3 [orchestrator verify]: Full regression** — `npm run typecheck:all && npm run test:all` → PASS.
- [ ] **Step 4: Commit** — `docs: campaign 3 in flight on the roadmap`

---

## Deferred / explicitly out of scope (do not build)

- Playwright in any tier (operator decision; campaign 8 revisits).
- Import-graph precision for `src/shared` mapping (spec's accepted approximation).
- Pipeline consumption of the library (campaign 4 wires Verify to it).
- Area-tier timing proof beyond structure (its <2 min bound is trivially met here; the fast-tier bound is the measured gate).
