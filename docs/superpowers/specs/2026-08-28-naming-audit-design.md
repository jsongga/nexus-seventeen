# Campaign 9.7: Naming audit — glossary, vocabulary, and mechanical renames

**Status:** Proposed (audit complete 2026-08-28; awaiting the owner's picks on the two wording decisions)
**Author:** Claude (from two read-only audits: vocabulary; files/folders/symbols)
**Scope:** naming only — zero behavior change; every rename is a reviewed mechanical task with typecheck as the proof.

## Summary

The repo's naming is unusually consistent *by review discipline* (no linter exists): `parse*`/`load*`/`read*` are cleanly split, `*InTransaction` is never violated, 97.7% of test titles are behavioral. The real problems are few and specific:

1. **"task" means two things on one page** — the human's request (`WorkItem`) and the agent job (`BoardTask`). "Add task" creates a `WorkItem`.
2. **"runtime" means three things** — AI adapters (`agents/runtime/`), the container engine (`task-fleet/runtime.ts`), and the board orchestration runtime (`collaborators/runtime.ts`, which also imports the first).
3. **"intake" means three things** — a route, a lifecycle phase, and a run flag.
4. **"provider" survives only as an operator alias for `runtime`** (env var, fleet key, one UI string, two types).
5. Copy drift: `abandoned`→"Cancelled" on chips but "Park auto-abandoned" in notifications; `dead_letter`→"Failed" collides with task `failed`; docs say "kill switch" for what the product calls "pause".
6. Folder/file names that describe mechanism or pattern roles: `collaborators/` (7 of 21 files aren't collaborators), `tests/tooling/` (tests `scripts/`, not `tooling/`), `docker_image/` (only snake_case folder), `merge-executor.ts` (no executor), `arguments.ts`.
7. `parse.ts` re-exports validators as `string`/`boolean`/`array`/`record` — keyword shadowing.

## Pinned — deliberately NOT renamed (each needs a migration window)

`STEWARD_*` env prefix (44 names, set in Dokploy/Dockerfile), contract version `steward.task-board/v1` (persisted in artifacts), actor ids `system:steward-default` etc. (live DB rows), Dokploy volume `steward-data`, `steward.cicadasystem.com`, `cicada-steward-agent-token`, `/opt/steward` + `/var/lib/steward` image paths, bootstrap project key `cicada-steward`, `twe_/twa_/tws_` id prefix values (persisted + SQL GLOB), all contract enums and DB names, the `POC` prompt marker (reaches the model). These are recorded as a deferral, not forgotten.

## Decisions needed from the owner

- **D1 — the UI word for a `WorkItem`:** "Request" (recommended: "Add request", "Request list", "Cancel request") or "Work item". `BoardTask` keeps "task" (or becomes "job").
- **D2 — adopt a linter** (`@typescript-eslint/naming-convention` + duplicate-basename/duplicate-export CI grep) to make the conventions enforceable. Recommended yes; it is the only way the current quality survives.

## Plan (tiers; each a dual-reviewed task)

**T0 — Glossary first.** `docs/GLOSSARY.md` (published to Outline): Request / Intake (phase only) / Job|Task / Node / Run / Stage (scoped) / Runtime / Worker vs Lane vs Agent / Pause / Park→Abandon→Dead letter / Archive, plus the abbreviations (`twe_`, POC, CAS). Source of truth for every later rename.

**T1 — Copy-only (no code semantics):** apply D1 across ~14 UI strings + e2e selectors; unify park/abandon/dead-letter labels; "kill switch"→"board pause" in docs and the test actor id; `docs/AGENT_SYSTEM.md` and the two boot/usage strings say Nexus Seventeen; UI badge "Point of contact"; "lane/worker/agent" one-word-per-layer in status copy.

**T2 — Internal mechanical renames (typecheck-proven):** `collaborators/runtime.ts`→`board-runtime.ts`; `task-fleet/runtime.ts`→`worker-factory.ts` (+ its test `container-runtime.test.ts`); `merge-executor.ts`→`pipeline-merge.ts`; `arguments.ts`→`run-plan.ts`; `parse.ts` primitives→`parseString/…`; `TaskBoardClient`×2→`BoardApiClient`/`WorkerBoardClient`; `Tolerant*Record`→`Tolerant*Entity`; `migrationVersion4To5`→`migrationSql4To5`; `tests/tooling/`→`tests/scripts/` (one glob); `docker_image/`→`docker-image/` (build paths — isolated commit); route `kind:'intake'`→`'workItem'` with a legacy-hash fallback; `twe_/twa_/tws_` prefixes become exported constants (values unchanged); `Provider*`/`TaskFleetProvider` types→`Runtime*`.

**T3 — Operator-surface `provider`→`runtime` with an alias window:** fleet key `runtime` (accept `provider` with a deprecation warning), `STEWARD_TASK_WORKER_RUNTIME` (old name honored + warned), README rows, UI snippet generator. Precedent: `promptsRoot`→`promptsFile`.

**T4 — Optional/deferred:** `collaborators/`→`domains/` + move the 7 non-collaborator files (largest diff; after T2); Docker network/label/image-name `steward-*`→`nexus-*` (needs live container drain); `.steward-data/`→`.nexus-data/`; drop the `task-` folder prefix (rejected: 4 string-matched `package.json` subpath aliases for four characters); `*.flow.test.ts` suffix convention for the 35 non-mirror test files.

**Conventions to write down (in CONTRIBUTING or README, enforced by D2):** one word one meaning; a file is named for its primary export; folder names are domain nouns not pattern roles; keep the `parse*/load*/read*` split; booleans read as assertions; test files declare their kind.

## Alternatives considered

- Rename the pinned `steward` surfaces now — rejected: each needs dual-read/dual-write or an infra migration; no user value until a product rename is decided.
- Rename contract enums (`abandoned`, `dead_letter`, the three `*_STAGES`) — rejected: persisted values; copy-level fixes achieve the reader-facing goal.
