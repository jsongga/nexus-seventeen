# Codebase health audit — readability, reusability, structure

Status: proposed · Author: Claude (5 reviewers: 4× opus, 1× codex) · Date: 2026-08-29
Scope: the whole repository at `e2c7c78` (campaign 10 shipped). Reports: `.superpowers/sdd/2026-08-28-decomposition-cross-repo/` is the campaign ledger; the five audit reports live in the session scratchpad (`audit/{structure,reusability,readability,outside-src}.md`, `audit/codex-audit.log`).

## Summary

Five independent reviews of the same tree. They converge on four things and disagree on one.

**Converged (act on these):**

1. **Layering is inverted where it matters.** `persistence/` and `collaborators/` are mutually dependent — `persistence/workflow.ts` imports values from three collaborators while 18 of 24 collaborators import back. 15,328 lines across 32 files are _named_ as layers that do not exist, so no import-direction rule can be enforced. Both reviewers rank this the top structural risk.
2. **Plumbing is copied, not shared.** Four byte-identical `git()` factories (same MD5), the `-c core.fsmonitor=…` prelude at 12 sites, two rival `ls-tree` parsers, two bounded-JSON HTTP clients (~120 duplicated lines), `runtime/claude.ts` ≡ `codex.ts` (35 lines including a `FAILURE_STATES` _policy_), and seven browser date formatters.
3. **Comments are the real gap, not nesting.** 0.9% comment density against the reference repo's 14.8%; 51% of source files have zero comments; only 4 of 138 production modules open with a header; 38 of the 53 files over 200 lines are under 1%.
4. **Two policies exist twice, and one of the copies is weaker.** `derive.ts`'s sanitize chain is a second redaction that misses PEM blocks and AWS keys that `shared/redact.ts` catches; the automation stage→role table is implemented privately in both `validate.ts` and the web's `types.ts`. One is a security boundary, the other an authorization rule.

**Disagreement — the web tree.** The structure review proposes flattening `src/web/task-board/*` → `src/web/*` (73 files, 69 drop a level, **21 import lines**). Codex argues the web's problem is not depth but that `model/`/`views/` are generic layers with a muddled dependency direction (model imports data, data imports model, routing imports a view-owned `BoardPage` type), and prefers feature seams.

**Ruling:** do both, flatten first. The objection was to collapsing everything into one root, not to deleting a level that earns nothing — `src/web` holds exactly one app. Flattening first means the later feature seams land at `src/web/work-items/` instead of `src/web/task-board/work-items/`, so the two moves compose instead of colliding.

## What the user asked for, answered directly

| Complaint                                             | Finding                                                                                                                                                                                                                                              | Action                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| "File tree is too nested"                             | Real depth is 3–4 almost everywhere. The pain is _redundant_ levels, not depth: `src/web/task-board/` (one app), `web/task-board/project/` (4 components, one consumer), plus two dead barrels (`task-fleet/index.ts` has zero importers in `src/`). | Campaign 11 — five moves, ~30 import lines total                          |
| "Not enough comments"                                 | Confirmed and quantified above.                                                                                                                                                                                                                      | Campaign 11 — convention + the nine highest-value files, then incremental |
| "Look at how I did styling in DotBackendLuo-refactor" | Convention extracted and translated to TS.                                                                                                                                                                                                           | Adopted below                                                             |

## The comment convention (adopted)

```ts
/** Persists and advances confirmed workflows inside caller-owned transactions. */

/* —— Imports —— */

/* —— Plan lifecycle —— */

// Why: queue the event after commit so subscribers never observe rolled-back state.
```

- **Module header** — one sentence, line 1, saying what the module owns. Every production module.
- **Section banners** — `/* —— Section —— */`, block comment, two em-dashes, **column 0, top-level only**. Used once a file has 3+ conceptual regions (roughly >250 lines), about one per 100 lines. This exact form is what the user's Neovim config folds on (`after/ftplugin/{javascript,typescript,javascriptreact,typescriptreact}.lua` → `^/\* ——`), so indented or `//`-style variants are not banners.
- **Why-comments** — transaction ordering, recovery behaviour, compatibility shims, security bounds, intentionally surprising dependencies.
- **Never** — narrating syntax, restating types, per-field docs on the 200-export contract, banners in small files or tests, or a comment-density target.

**Enforcement:** not eslint (the repo has none; a header rule would cost ~4 deps + CI). A ~60-line `tests/tooling/code-style.test.mjs` in the existing `node --test` tier checks banner format and ratchets module headers against an allowlist of the 134 files currently lacking one.

**Prerequisite:** adopt **prettier** first as a standalone whitespace-only commit — 117 lines exceed 200 characters (one is 1,546), and comment work should land on formatted code. _(Width ruled at 120 after measurement: 120 leaves 297 lines over 120 chars, 200 leaves 3,580, for 4.6% more churn. Equivalence is proved by reproduce-from-HEAD identity, not `git diff -w`.)_

## Campaigns

**11. Codebase health — formatting, comments, shared plumbing.** Prettier commit → comment convention + the nine files below → `server/shared/git.ts` → single-source credential recognition and the automation stage→role table → the five cheap moves → delete the two genuinely dead exports (`versionedRecord` in `validate.ts`, `parseAgentRunOutput` in `task-worker/schema.ts` — locate by symbol; the formatter moved every line number in this document) → one date formatter. _Exit: `code-style.test.mjs` green with an allowlist that only shrinks; zero duplicate git factories._

Files to comment first: `contract/index.ts` (1,392 loc, fan-in 109) · `validate.ts` (3,984 / 18 comment lines) · `persistence/workflow.ts` (2,567 / 11) · `store.ts` (migration ladder) · `collaborators/runtime.ts` (774 / **0**, fan-in 17) · `verify-attempts.ts` (935 / **0**) · `projects.ts` (2,243 / 5) · `web/data/client.ts` (1,000 / 1) · `web/components/ui.tsx` (the 9.6 anchored-Modal rules).

**12. Layering — workflow orchestration out of persistence.** Break the `persistence/` ↔ `collaborators/` cycle; split `ProjectsCollaborator` (catalog+artifacts / merge+final approval / decomposition reconciliation) and `validate.ts` (scalars / entities / plan graph / worker boundary / board boundary) behind unchanged façades — zero caller edits despite 26 and 102 importers. Define and then _enforce_ the allowed import direction. _Exit: a dependency-direction test that fails on a back-import._

**13. Web feature seams.** Flatten `web/task-board/*` → `web/*`; move `BoardPage` to routing ownership; split `WorkItemDetail.tsx` (1,986 lines, 29 `useState`) — **five test files already split it along disjoint component sets**, so the seam is pre-designed; then slice `model/`+`views/` into feature folders. _Exit: no file over ~600 lines in `src/web`; model→data direction one-way._

**Into 9.7 (naming, already queued):** the four-way `runtime` collision, `steward` vs `nexus-seventeen`, `provider` vs `runtime`, `collaborators`, and the nine basename hand-offs the structure review listed.

**Into the test contract (9.7 or its own):** promote the `*.flow.test.ts` split to core — 38 of 86 server files have no mirror test, so `mapping.ts` falls back to the whole directory and editing `service.ts`/`projects.ts`/`runs.ts`/`workflow.ts` runs all 30,878 lines of `tests/server/task-board` including the real-git e2e suite. Move `board.test.ts:7678-8409` (17 schema tests) to a real `persistence/store.test.ts`; adopt the existing `helpers.ts` (there are **17** independent `git()` helpers and 3 byte-identical `jsonRequest()` copies in tests); write `docs/TESTING.md` (the tier ladder exists in five places and nowhere completely — `verify:full` omits `test:e2e`, CI omits `test:container`).

## Fix now, outside a campaign

| Defect                  | Where                                                             | Why now                                                     |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Weaker second redaction | `runtime/derive.ts` sanitize chain vs `shared/redact.ts`          | Security boundary: misses PEM blocks and AWS keys           |
| `Invalid Date` rendered | `AutomationPage.tsx:91`                                           | The one date formatter without a NaN guard; already drifted |
| Stale doc claim         | `docs/AGENT_SYSTEM.md:11` says the automation registry is dormant | Contradicted by `runs.ts:1189`; misleads the next reader    |

## Alternatives considered

- **Flatten `src/server/agents/`** — refused by both reviewers: ~100 sites, 11 `package.json` keys, 8 tsconfig paths, and it would merge ten distinct process/security boundaries into one undifferentiated package.
- **Collapse `src/shared/task-board-contract/`** — refused: 116 sites, no benefit; browser-safe contracts and Node-only utilities have different dependency constraints, so `src/shared` and `src/server/shared` stay separate.
- **Subdivide `model/` (30 files) or `views/` (19) on count alone** — refused: 24 of those are colocated tests, and `views/` being flat is a _symptom_ of `WorkItemDetail.tsx`, not a folder problem. Split by dependency and feature ownership instead.
- **Split `runs.ts` (1,835) and `worker.ts` (1,463)** — refused for now: each is one transactional state machine with real invariant commentary. Header + banners first; revisit if they grow.
- **Enforce comment density** — refused: headers, section maps and why-comments help; percentage targets produce narrated code.
- **eslint for the header rule** — refused: cost out of proportion; the existing `node --test` tier does it.
