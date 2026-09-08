# Plan: naming audit renames (roadmap 9.7)

Spec: `docs/superpowers/specs/2026-09-08-naming-audit.md`. Base: `64982df`.

**T1 is decided: the user's word for a `WorkItem` is "Request".** `BoardTask` keeps "task", so
the collision the audit ranked worst disappears. Every task below assumes that.

Four tasks. T4 needs no rename (glossary only, folded into T0), T6 is deferred until a campaign is
already in those files, and T7 is not proposed.

| #   | Task                        | Deliverable                                                               | Proof                 |
| --- | --------------------------- | ------------------------------------------------------------------------- | --------------------- |
| T0  | Glossary                    | `docs/GLOSSARY.md`, one page, source of truth for the rest                | review only           |
| T2  | Copy-only pass              | "Request" across ~30 UI strings; drop "thread" and the bare "intake" noun | web + Playwright      |
| T3  | Operator surface            | `provider`→`runtime`, and colliding `runtime`→`launchMode`, both aliased  | container tier + docs |
| T5  | Internal mechanical renames | Five files whose names state something untrue                             | `typecheck:all`       |

## T0 — glossary

`docs/GLOSSARY.md` defining: Request (user-facing) vs `WorkItem` (type) · Task · Agent · Worker ·
Lane · Runtime · Provider (interface sense) · Stage (its three scopes) · Phase (its two) ·
Workspace vs Repository · Run · Park → Abandon → Dead letter.

It is the source of truth for T2–T5, so it lands first. Include the audit's finding that
`provider` in `decomposition-readiness.ts` is the _interface_ sense and is correct as-is — a
glossary that only lists problems teaches nobody which uses are right.

## T2 — copy only

Apply "Request" across the UI strings the audit lists. **No type, field or route renames** —
`WorkItem` stays `WorkItem` in code. This is the task where a diff should be almost entirely
string literals; if it is not, something has been over-reached.

Watch the e2e and web suites: they assert UI copy, so this task legitimately changes test
expectations. Every changed assertion must be a copy change, not a behaviour change.

**Exit:** no UI string calls a `WorkItem` a "task"; `BoardTask` copy still says "task"; Playwright
green on both projects.

## T3 — the operator surface

`provider` → `runtime` in fleet config, env vars and messages, **and** the colliding fleet key
`runtime` (local-process | container) → `launchMode`. Both old keys accepted with a deprecation
warning for one version.

This is the only task carrying operator risk, and the audit found the earlier
`2026-08-28-naming-audit-design.md` got it wrong: it renamed `provider`→`runtime` without noticing
`runtime` was already taken, which would have collided two concepts onto one key. **Do both halves
or neither.**

**Exit:** an old config still loads with a warning; a new config loads clean; `test:container`
green; README and `docs/AGENT_SYSTEM.md` updated.

## T5 — internal renames

`collaborators/runtime.ts`→`board-runtime.ts` (17 importers), `task-fleet/runtime.ts`→
`worker-factory.ts` (+ its two test files), `merge-executor.ts`→`pipeline-merge.ts`, and the
remaining names the audit lists as stating something untrue.

**Move hazards, learned the hard way in campaigns 11–13:** the module-header allowlist and its
baseline must move with the files (or the file earns a header and the allowlist shrinks); `docs/`
carries links into `src/`; a module leaving a directory published in `package.json`'s `imports`
map can silently downgrade a bare specifier; and the verify-contract mirror
(`src/server/a/b.ts` ↔ `tests/server/a/b.test.ts`) must stay paired.

**Exit:** `typecheck:all` clean, `test:all` green, no file name states something untrue.

## Per task

Codex implements T2, T3 and T5; the controller writes T0. Gates outside the sandbox:
`typecheck:all`, `test:all`, `test:container` for T3, Playwright for T2. Claude reviewer and
`codex review` serialized, never concurrent with a gate. Fix rounds cap 5.

**Watch for:** T2 and T5 both touch test files for legitimate reasons, which is exactly the shape
that hides a real change among mechanical ones. A reviewer should confirm every changed assertion
in T2 is a string, and that T5 changed no assertion at all.
