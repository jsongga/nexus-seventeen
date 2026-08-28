# Campaign 9.5: File diet + consolidation

**Status:** Approved for implementation
**Author:** Claude (from the five-agent layout/dead-code analysis of 2026-08-26; every item approved by the owner)
**Date:** 2026-08-27
**Scope:** roadmap campaign 9.5. Structural only — no behavior change except where a mechanism must change shape to hold fewer files (prompt/skill loaders). Local-first; nothing pushed.

## Summary

The repo carried ~270 files in `src`+`tests` and 108 elsewhere for a small product, with single-file
folders (`catalog/`, `config/`, 11 `skills/<id>/`), 23 one-to-twenty-line prompt files, 26 completed
campaign plan/spec documents nobody reads, a handful of dead exports, and a test-layout bug that
silently narrows the verify tier's test selection. This campaign consolidates without weakening any
assertion or changing any pin (prompt sha, skill digests).

Targets: non-code tracked files ≲ 50 (from 108), `src`+`tests` ≲ 260, zero single-file directories
outside tool-mandated conventions, all gates + goldens green.

## Part A — Deletions and moves (no mechanism change)

- Root `.gitignore` gains `.superpowers/`.
- `catalog/company-bootstrap.json` → `config/company-bootstrap.json` (2 script-relative code refs in
  `scripts/reconcile-bootstrap.mjs:15` / `scripts/bootstrap-lib.test.mjs:15`, 2 doc links); delete `catalog/`.
- Delete every completed campaign document under `docs/superpowers/{plans,specs}` (git history keeps
  them; zero live readers verified) **except this campaign's own spec + plan**. Delete
  `docs/superpowers/specs/agentic-workspace-design.html` with them. Delete `scripts/agent-container-smoke.mjs`
  (its last reference dies with the plans).
- Dead code: `src/web/task-board/model/proposals.ts` + `.test.ts` (zero importers);
  `parseWakeupEntity` (`validate.ts`), `apiEntity` and `parseTaskPhase` (`web/data/parse.ts`); the
  dead barrel line `src/web/task-board/index.ts:2`; `public/cicada-mark.svg`; npm scripts
  `dev:task-worker`, `preview`, `test:watch`; the never-produced `TASK_RETRY_REQUIRED` error code
  (contract + `unions.test.ts` existence assertion). `bootstrap:apply` stays and gets documented.
- `scripts/bootstrap-lib.test.mjs` → `tests/tooling/bootstrap-lib.test.mjs` (picked up by the existing
  glob); drop `test:bootstrap`, `build:bootstrap-contract`, `tsconfig.bootstrap.json`; `test:all` loses
  its bootstrap stage (the tooling stage now covers it).

## Part B — Code consolidation

- **Mirror-rule fix**: move the 10 collaborator-named tests (`base-branch-poll`, `board-pause`,
  `ledgers`, `merge-executor`, `notifications`, `park-lifecycle`, `scope-check`, `verify-attempts`,
  `wall-clock`, `work-item-transitions`) from `tests/server/task-board/` into
  `tests/server/task-board/collaborators/`; move `tests/server/task-board/persistence/workflow.test.ts`
  up one level and delete the `persistence/` test dir so `persistence/*.ts` fail closed to the area tier
  instead of selecting one unrelated file. Relative imports adjust; nothing else.
- **Micro-module merges** (import sites in parentheses): `runtime/events.ts` + `runtime/errors.ts` →
  `runtime/adapter.ts` (20); `persistence/retired-wakeups.ts` + `pending-wakeups.ts` →
  `persistence/workflow.ts`, `work-item-priority-sql.ts` → `store.ts` (11); `web/data/uuid.ts` +
  `concurrency.ts` → `web/data/client.ts` (3); `web/components/dialog-discard.ts` (+ its 20-line test) →
  `dialog-stack.ts` (3); `server/shared/safe-error-detail.ts` → `redact.ts` (3). `registry.ts` stays
  (merging creates an import cycle).
- **Export hygiene**: remove the 25 barrel-only export lines; strip the `export` keyword from the 103
  symbols used only inside their own file (one-token edits; typecheck is the proof).

## Part C — Single-file prompts and skills

- **`config/prompts.md`** replaces `prompts/` (23 files). Format: `## <template-name>` at column 0
  opens a section (names obey today's filename regex); the body is the old file's text verbatim. The
  loader `PromptRegistry.loadSync(file)` parses sections into the same name→content map; a body
  containing a column-0 `## ` line is rejected (unambiguous format). **`promptsSha` is computed over
  (name, content-digest) pairs exactly as before, so it — and the 10 rendered-prompt goldens — stay
  byte-identical.** Wiring: default `"prompts"` → `"config/prompts.md"` (worker + fleet entrypoints);
  fleet config `promptsRoot` → `promptsFile`; env `STEWARD_TASK_WORKER_PROMPTS_ROOT` →
  `STEWARD_TASK_WORKER_PROMPTS_FILE`; ~15 test call sites; verify rule `prompts/**` → `config/prompts.md`.
- **`config/skills.md`** replaces `skills/` (11 dirs). Same section format with `## <skill-id>`; each
  section body is the old `SKILL.md` verbatim **including its YAML frontmatter** (the registry keeps
  validating `name:` == id). Digest = sha256 of the section body — identical bytes ⇒ identical digests ⇒
  every `plan_revisions.skill_digests_json` pin stays valid. `SkillRegistry(file)`; the one
  construction site (`collaborators/projects.ts:107`) and `Dockerfile:25`'s `COPY` update.

## Part D — Docs

Fold `docs/TASK_FLEET.md` into README's run-locally section (−1); prune the stale 105-line
"Implementation plan" block in `docs/WORKFLOW_ARCHITECTURE.md`; document the 16 undocumented
`STEWARD_*` env vars and `bootstrap:apply` (in README or TASK_FLEET's landing spot); update every
path mention (`prompts/`, `skills/`, `catalog/`, `promptsRoot`).

## Testing

Every task: `npm run typecheck:all && npm run test:all`. Part C additionally: the prompt goldens
unchanged (byte-compare before/after), `promptsSha` equality asserted across the old directory and the
new file in a one-off migration test (delete after), skill digests equality likewise. Close: container
tier (Dockerfile COPY change) + Playwright.

## Explicitly kept

`scripts/export-documents.mjs` (production pre-v25 DB still needs draining), this roadmap file, all
8 schema fixtures, `prompts`→`config` is a move not a split, tsconfig/`public/`/`docker_image/`
placement, `bootstrap:apply`.

## Alternatives considered

- Archive plans/specs under `docs/superpowers/archive/` — delta 0; rejected.
- `renderSection` partial-merge for prompts (−5) — superseded by the single file (−22).
- Flatten skills to `skills/<id>.md` (−0 files, −11 dirs) — superseded by the single file (−10, −11).
- Regroup `collaborators/` into subfolders — would multiply the mirror bug; revisit after the fix.
- Shared test-helper module — +1 file for ~20 duplicated lines; rejected.
