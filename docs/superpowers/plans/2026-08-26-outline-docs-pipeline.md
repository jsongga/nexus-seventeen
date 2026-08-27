# Outline + Docs Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the mechanical docs publisher (repo docs → view-only Outline collections with source banners, proven against a real containerized Outline) and retire the board's pen-documents feature (export, then remove schema/routes/editor/page), plus inert CI + Dokploy activation artifacts.

**Architecture:** New standalone package `src/server/docs-publish/` (enumerate-from-git-ref → banner → `DocsSink` diff/upsert; `OutlineSink` over Outline's REST API with a JsonClient-shaped HTTP client). Retirement in two gates: server/schema first (snapshot keeps an empty `documents` key), then contract+web+Playwright. Export is a from-scratch standalone script read directly from SQLite. Docker-tier e2e boots pinned outline+postgres+redis with the tier's hand-rolled `docker run` primitives and provisions the API token by direct postgres seeding.

**Tech Stack:** TypeScript / Node 24, node:test + vitest + Playwright, node:sqlite (export script), Docker (e2e). **No new npm dependencies anywhere** — postgres seeding runs via `docker exec <pg> psql`.

**Spec:** `docs/superpowers/specs/2026-08-26-outline-docs-pipeline-design.md` (seam facts: `.superpowers/sdd/campaign9-exploration.md`)

## Global Constraints

- **No new dependencies; no GitHub pushes; nothing deploys.** CI workflow ships inert (`if: vars.DOCS_PUBLISH_ENABLED == 'true'`).
- **Publisher reads git refs, not worktrees** (`git show <ref>:<path>` via injectable runner — the `onboarding-check.ts` precedent); runs outside the agent sandbox; markdown only.
- **Outline mirror semantics:** one collection per repo named `<repoName> docs`, `permission: "read"`; upsert keyed by exact title == repo-relative path; source-absent titles are **archived, never deleted**; every published body starts with the source banner (exact format in Task 4).
- **Config discipline** = `src/server/agents/runtime/profiles.ts` pattern (hand-rolled validators, `O_RDONLY|O_NOFOLLOW`, regular-file, ≤1 MiB, `Object.freeze`, reject unknown keys). Token ONLY from `STEWARD_OUTLINE_API_TOKEN`; `baseUrl` must be https unless `allowInsecureBaseUrl: true`.
- **HTTP client** copies the `JsonClient` shape (`src/server/agents/task-worker/http-board-client.ts:239-292`): injectable fetch, per-call AbortController + unref'd timeout, bounded response reader, `redirect:"error"`/`credentials:"omit"`/`referrerPolicy:"no-referrer"`, typed error. Retry ABOVE the client only: 3 attempts, 1 s → 8 s backoff, on 429/5xx/network errors only.
- **Migration discipline:** SCHEMA_VERSION 24 → 25; `DROP TABLE document_events` before `documents`; `DOCUMENT_SCHEMA` stays inside `MIGRATE_VERSION_3_TO_4`, leaves the base `SCHEMA`; golden `tests/server/task-board/fixtures/v24-schema.sql` (generated, not hand-typed); contract-drift + fresh-vs-upgraded equivalence updated.
- **`TASK_MESSAGE_ACTOR_TYPES` survives** (it feeds the live `task_messages.actor_type` CHECK) — re-root it as the primary constant, value `["human","agent"]` unchanged; `store.ts`'s CHECK text unchanged.
- **Snapshot-revision arithmetic** (`src/web/task-board/model/project.ts:358` sums a documents term): adjust deliberately with its tests when the term goes; never leave it referencing a removed field.
- Assertions relocate, never weaken. Gate per task (outside any sandbox): `npm run typecheck:all && npm run test:all`. Docker tier + Playwright at campaign close.
- Implementers do not commit; the controller commits.

---

### Task 1: Pen-documents export script

**Files:**
- Create: `scripts/export-documents.mjs`
- Test: `tests/tooling/export-documents.test.mjs` (the `test:tooling` suite already globs `tests/tooling/`)

**Interfaces:**
- Produces: CLI `node scripts/export-documents.mjs <sqlite-path> <out-dir>`. Exit 0 on success (including zero documents); exit 1 with a one-line stderr message when the DB is missing, unreadable, or lacks the `documents` table (pre-v4 or post-v25 DB).

**Behavior (exact):** open the DB read-only via `node:sqlite`. For every `documents` row (join `projects` for the project name): write `<out-dir>/<project-slug>/<document-slug>.md` where slug = lowercased name/title with `[^a-z0-9]+` → `-`, trimmed, uniqued with `-2`, `-3` suffixes on collision; file starts with a metadata header:

```markdown
---
title: <title>
project: <project name> (<project_id>)
documentId: <document_id>
contentVersion: <content_version>
updatedAt: <updated_at>
exportedAt: <ISO now>
---

<content verbatim>
```

Beside it, `<document-slug>.events.jsonl`: one JSON line per `document_events` row (all columns, ordered by `sequence`). Create directories `0700`-style defaults; refuse to overwrite an existing non-empty `<out-dir>` (exit 1) so reruns are explicit.

**Steps:**
- [ ] Failing tests first: build a fixture DB in the test using the real store (`openStore` from `build/server/task-board/persistence/store.js` — the tooling tests already run against build output; check how `tests/tooling/*` import compiled code and follow it) with one project, two documents (one with 3 events), then: export produces the expected tree/contents byte-for-byat including the events.jsonl ordering; slug collision uniquing; empty-DB export exits 0 with empty dir; missing table exits 1; non-empty out-dir exits 1.
- [ ] Implement; run `npm run test:tooling`.
- [ ] Gate: `npm run typecheck:all && npm run test:all`.

---

### Task 2: Server-side retirement — schema v25 + collaborator/routes removal (contract keeps the key)

**Files:**
- Modify: `src/server/task-board/persistence/store.ts` (SCHEMA_VERSION 25; `migrateVersion24To25` drops `document_events` then `documents`; `DOCUMENT_SCHEMA` removed from base `SCHEMA`, retained in `MIGRATE_VERSION_3_TO_4`), `src/server/task-board/persistence/rows.ts` (remove the four document mappers), `src/server/task-board/collaborators/runtime.ts` (remove `documentEvents` emitter: lines 61/74/731), `src/server/task-board/board.ts` (remove imports/field/7 methods; `snapshot()` line 569 becomes literal `documents: []` — the contract key survives until Task 3), `src/server/task-board/service.ts` (remove the five document routes, `#documentStreams`, `#documentActor`, `#openDocumentStream`, the shutdown loop entries; RENAME the shared `interface DocumentStream` → `SseStream` where `#projectStreams` uses it), `src/server/task-board/schema.ts` (remove the three document adapters)
- Delete: `src/server/task-board/collaborators/documents.ts`
- Create: `tests/server/task-board/fixtures/v24-schema.sql` (generated via the fixture-regeneration mechanism used for v23 — see the generation comment in that file)
- Test: update `tests/server/task-board/board.test.ts` (delete 7334 + 7369; REWORK 7865: it synthesizes a v3 DB by dropping the document tables — after this task that trick still works against a v24 fixture but the assertion "tables come back" becomes "v3→25 upgrade ends with NO document tables and intact data"), `tests/server/task-board/http.test.ts` (delete 1481), `tests/server/task-board/contract-drift.test.ts` (drop document CHECK assertions at 239-240; add v24→v25 fresh-vs-upgraded equivalence; assert both tables ABSENT in fresh and migrated DBs), migration suite (v24 fixture upgrades cleanly; legacy v3 fixture path still passes end-to-end)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a board whose `snapshot()` emits `documents: []` (key present, always empty), no document routes (404), schema v25. Task 3 removes the key.

**Steps:**
- [ ] Failing tests first: migration test (v24 fixture → v25: tables gone, all other tables byte-identical schema; fresh v25 == upgraded v25), route test (GET /v1/documents/x → 404), snapshot test (documents === []).
- [ ] Implement removal + migration; rework the three named tests; regenerate the v24 golden.
- [ ] Verify legacy ladder: run the existing v3-era migration test (board.test.ts 7865 rework) — v3 DB (with document tables created by MIGRATE_VERSION_3_TO_4) upgrades through to 25 with tables dropped.
- [ ] Gate: `npm run typecheck:all && npm run test:all` (web still compiles: contract untouched).

---

### Task 3: Contract + web + Playwright retirement — Documents page gone

**Files:**
- Modify: `src/shared/task-board-contract/index.ts` (remove the five document interfaces, three request types, `DOCUMENT_CONTENT_MAX_BYTES`, `DocumentContentType`, `BoardSnapshot.documents`; make `TASK_MESSAGE_ACTOR_TYPES = ["human","agent"] as const` primary — delete `DOCUMENT_ACTOR_TYPES` or alias it FROM the new primary if any server import remains), `src/shared/task-board-contract/validate.ts` (remove the five document validators + three board parse helpers; remove `documents` from the board-snapshot exact key list at 2145/2161), `src/server/task-board/board.ts` (drop the `documents: []` literal from Task 2)
- Delete: `src/web/task-board/views/DocumentsPage.tsx` + `.test.ts`, `src/web/task-board/model/document-drafts.ts` + `.test.ts`, `src/web/task-board/data/storage-lease.ts`, `docs/DOCUMENT_BROADCAST.md`
- Modify (web): `data/client.ts` (DocumentStreamError, documentClientId, methods 314-331, dispatchDocumentEvent, maximumDocumentEventBytes, consumeDocumentStream, impls 794-844), `data/parse.ts` (Raw shapes 133-135, parse fns, RawBoard.documents 145, projection 487), `data/wire.ts` (69, 109), `model/project.ts` (documentSummary 109, documentProjection 126, snapshot merge 345-368 — **the revision sum at 358 loses its documents term; update the staleness/refresh tests to pin the new arithmetic**), `types.ts` (298/306/321/336/472), `views/WorkspaceSidebar.tsx` (nav button + `'documents'` BoardPage arm), `routing/routing.ts` (+ its tests: segments, hashes, RouteSnapshotIds, fallback branch), `BoardApp.tsx` (import 8, branch 594-595, onSelectDocument 601, labels 740-741), `views/WorkspacePages.tsx` (projectDocuments 56, boardDocumentMeta 52, merges 194-196/264-265), `project/ContextSidebar.tsx` (only the `documentId` branch 105-115; the component and `href` branch survive), `index.ts` re-exports, `README.md` (drop the DOCUMENT_BROADCAST link at 105)
- Test: every vitest fixture with `documents: []` drops the key (BoardApp, CreateDialogs, WorkspacePages, workspace-model, project, parse [25 refs], client [60 refs], wire, routing [10 refs], observability-client, WorkItemObservability); Playwright `tests/e2e/task-board.spec.ts` — delete fixture harness 85-300 and tests 3005/3087/3181/3263, edit 922-926 (assert the rail has Task List/Automation/Ledgers and **no Documents button**) and 2731-2781 (project sidebar: metadata links only), drop `documents` from fixtures at 316/1934; `tests/e2e/project-picker.spec.ts:45` drops the key

**Interfaces:**
- Consumes: Task 2's key-present-empty snapshot.
- Produces: no `documents` anywhere in contract, server, or web; `#/documents` hashes fall back to the task list.

**Steps:**
- [ ] Failing web tests first: routing (documents hash → task-list fallback), sidebar render (no Documents button), project revision arithmetic (new sum pinned).
- [ ] Sweep the removals; typecheck-driven cleanup for stragglers (`grep -ri "document" src/web src/shared/task-board-contract` — remaining hits must each be justified in the report: e.g. `documentation` words, ContextSidebar's surviving shell).
- [ ] `npm run test:web` green; Playwright typechecks (`typecheck:all` covers e2e config); controller runs the browser suite at close.
- [ ] Gate: `npm run typecheck:all && npm run test:all`.

---

### Task 4: Publisher core — enumerate, banner, sink seam, publish, CLI, config

**Files:**
- Create: `src/server/docs-publish/enumerate.ts`, `banner.ts`, `sink.ts`, `publish.ts`, `config.ts`, `main.ts`, `config/docs-publish.json` (the spec's example, with this repo's entry), package.json script `"docs:publish": "npm run build:runtime && node build/server/docs-publish/main.js"` (match how existing entrypoints build+run — check `dev:task-fleet`'s pattern and mirror it)
- Test: `tests/server/docs-publish/enumerate.test.ts`, `banner.test.ts`, `publish.test.ts`, `config.test.ts`

**Interfaces (exact — Tasks 5-6 consume verbatim):**
```ts
// enumerate.ts
export interface DocSource { readonly path: string; readonly title: string; readonly markdown: string }
export interface EnumerateOptions { readonly exclude?: readonly string[] }   // glob-lite: '**' suffix prefixes only, e.g. "docs/superpowers/**"
export function enumerateDocs(repoPath: string, ref: string, options?: EnumerateOptions, runner?: GitRunner): readonly DocSource[]
// set = README.md (if present) + docs/**/*.md from `git ls-tree -r --name-only <ref>`; content via `git show <ref>:<path>`; title = repo-relative path
// banner.ts
export function withSourceBanner(source: DocSource, repoName: string, shortSha: string): string
// exact first line: `> **Read-only mirror.** Source: \`${repoName}/${source.path}\` @ ${shortSha}. Edit in the repository — this page is republished on merge. Comments are welcome here.`
// then "\n\n" then source.markdown unchanged
// sink.ts
export interface SinkCollection { readonly id: string; readonly name: string }
export interface SinkDocument { readonly id: string; readonly title: string; readonly text: string }
export interface DocsSink {
  ensureCollection(repoName: string): Promise<SinkCollection>;
  listDocuments(collection: SinkCollection): Promise<readonly SinkDocument[]>;
  createDocument(collection: SinkCollection, title: string, text: string): Promise<void>;
  updateDocument(documentId: string, title: string, text: string): Promise<void>;
  archiveDocument(documentId: string): Promise<void>;
}
// publish.ts
export interface PublishReport { readonly repo: string; readonly created: number; readonly updated: number; readonly archived: number; readonly unchanged: number; readonly failures: readonly string[] }
export async function publishRepo(entry: DocsPublishRepo, sink: DocsSink, runner?: GitRunner): Promise<PublishReport>
// diff rule: existing.text === desired text -> unchanged; differs -> update; absent -> create; sink title not in source set -> archive
// config.ts
export interface DocsPublishRepo { readonly name: string; readonly path: string; readonly ref: string; readonly exclude?: readonly string[] }
export interface DocsPublishConfig { readonly version: 1; readonly outline: { readonly baseUrl: string; readonly allowInsecureBaseUrl?: boolean }; readonly repos: readonly DocsPublishRepo[] }
export function parseDocsPublishConfig(value: unknown): DocsPublishConfig
export async function loadDocsPublishConfig(path: string): Promise<DocsPublishConfig>
```
`main.ts`: args `--config <path>` (default `config/docs-publish.json`), `--repo <name>` filter, `--dry-run` (prints per-repo report, sink untouched); token from `STEWARD_OUTLINE_API_TOKEN` via the `required()` env idiom (not needed for `--dry-run`); prints one report line per repo; exit 1 if any `failures`. GitRunner: reuse `runDeclaredScopeGit`/`GitRunner` from `src/server/task-board/collaborators/scope-check.ts` (the Task-6-of-campaign-8 precedent).

**Steps:**
- [ ] Failing tests: enumeration against a fixture git repo (README + docs tree + a docs/superpowers file excluded + an UNCOMMITTED worktree file proven invisible at the ref); banner byte-exactness; publish diff logic against an in-memory fake sink (create/update/unchanged/archive across two runs; failure isolation — one sink error lands in `failures`, others proceed); config parse/load (unknown key, bad version, http baseUrl without the flag, oversize, symlink all rejected).
- [ ] Implement; `npm run build:tests:fast && node --test .test-dist/tests/server/docs-publish/*.test.js`.
- [ ] Gate: `npm run typecheck:all && npm run test:all`.

---

### Task 5: Outline sink + HTTP client

**Files:**
- Create: `src/server/docs-publish/client.ts` (`OutlineClient` — JsonClient copy per Global Constraints; single method `request(path: string, body: unknown): Promise<unknown>` since every Outline API call is POST JSON; typed `OutlineHttpError extends Error { status, code? }`), `src/server/docs-publish/retry.ts` (`withRetry<T>(operation, {attempts: 3, delays: [1_000, 8_000]}, sleeper?)` — retry only on OutlineHttpError 429/5xx or network TypeError), `src/server/docs-publish/outline-sink.ts` (`OutlineSink implements DocsSink`)
- Test: `tests/server/docs-publish/client.test.ts`, `retry.test.ts`, `outline-sink.test.ts` (injected fetch pinning exact request paths/bodies/auth headers and response-envelope parsing)

**Outline API mapping (verify each against the pinned image's API before finalizing; all POST, `Authorization: Bearer <token>`, responses envelope `{ data: ... }`):**
- `ensureCollection`: `/api/collections.list` (paginate; match exact name `<repoName> docs`) else `/api/collections.create { name, permission: "read" }`; if found with a different permission, `/api/collections.update { id, permission: "read" }` (self-healing read-only).
- `listDocuments`: `/api/documents.list { collectionId, limit: 100 }` paginated via `offset`; fetch full text per doc via `/api/documents.info { id }` only when a title matches a source path (avoid N full-text fetches for archives).
- `createDocument`: `/api/documents.create { collectionId, title, text, publish: true }`.
- `updateDocument`: `/api/documents.update { id, title, text }`.
- `archiveDocument`: `/api/documents.archive { id }`.

**Steps:**
- [ ] Failing tests: client (timeout abort, bounded body, non-2xx → typed error with Outline's `{error}` code surfaced, redirect refused); retry (429 retries with the two delays then succeeds; 400 does NOT retry; exhaustion rethrows); sink (each method's exact wire shape; ensureCollection's three branches; pagination; the info-only-when-matched optimization).
- [ ] Implement; targeted suites green.
- [ ] Gate: `npm run typecheck:all && npm run test:all`.

---

### Task 6: Docker-tier Outline e2e

**Files:**
- Modify: `src/server/agents/task-container/infrastructure.ts` (export the existing private `ensureNetwork(binary, name, internal)` as-is), `src/server/agents/task-container/index.ts` (re-export)
- Create: `tests/container/outline-helpers.ts` (image pins + boot/seed/teardown), `tests/container/outline-publish.test.ts`

**Requirements:**
- Pin constants in `outline-helpers.ts`: `OUTLINE_IMAGE` (choose the current stable `outline/outline:<exact tag>` by checking the registry at implementation time and pin it — record the tag + date in a comment), `POSTGRES_IMAGE = "postgres:16-alpine"`, `REDIS_IMAGE = "redis:7-alpine"`.
- Boot: `requireDocker()`; `ensureNetwork(docker, "steward-outline-e2e", false)`; `docker run -d` postgres (env POSTGRES_PASSWORD/DB) and redis; run Outline with `SECRET_KEY`/`UTILS_SECRET` (fixed test hex), `DATABASE_URL`, `REDIS_URL`, `URL=http://outline:3000`, `PGSSLMODE=disable`, published on an ephemeral host port. Readiness: poll `GET /_health` up to **180 s at 500 ms** (first boot runs migrations; the tier's 10-15 s precedents do NOT apply — do not lower this).
- Seed the API token by `docker exec <pg> psql -U <user> -d <db> -c "..."`: inspect the pinned image's schema at implementation time (`\d teams`, `\d users`, `\d api_keys`) and insert one team, one admin user, one API key whose stored form matches the pinned version's hashing scheme; verify the seed by calling `/api/auth.info` with the token before the arc begins (hard-fail with a message naming the pinned tag if it 401s — that is the documented fragile point).
- The arc (one test, serial tier): `publishRepo` this repo (`path: repo root, ref: HEAD, exclude docs/superpowers/**`) via a real `OutlineSink` → report.created > 0, failures 0; publish again → created 0, updated 0 (idempotent; banner sha unchanged because ref unchanged); assert via the API: collection permission `"read"`, a known doc (`docs/workflow.md`) text starts with the exact banner line; third run with an `exclude` widened to drop one previously published path → that title archived (`documents.info` shows archivedAt), nothing deleted.
- Teardown best-effort (`docker rm -f`, network left in place like the tier's other fixtures); containers labeled (e.g. `--label steward.outline-e2e`) so a sweep helper can clean strays.

**Steps:**
- [ ] Write helpers + test (TDD is impractical against live boot — write the full arc, iterate); document the seeding SQL inline with the schema-inspection date.
- [ ] Sandbox cannot run Docker — state exactly what you verified (typecheck + unit-level helper logic if any); the controller runs `npm run test:container` outside.
- [ ] Gate: `npm run typecheck:all && npm run test:all` (container tier is controller-run).

---

### Task 7: Deferred-activation artifacts + runbook + roadmap

**Files:**
- Create: `.github/workflows/publish-docs.yml`, `deploy/outline/docker-compose.yml`, `docs/OUTLINE.md`
- Modify: `orchestrator-roadmap.md` (campaign 9 shipped marker — the controller may instead do this at close; skip if instructed), `README.md` (link `docs/OUTLINE.md` where DOCUMENT_BROADCAST was linked)

**Requirements:**
- `publish-docs.yml`: `on: push: branches: [main]`; one job `publish`, `if: ${{ vars.DOCS_PUBLISH_ENABLED == 'true' }}`; steps: checkout (fetch-depth 0), setup-node 24, `npm ci`, `npm run docs:publish`, env `STEWARD_OUTLINE_API_TOKEN: ${{ secrets.STEWARD_OUTLINE_API_TOKEN }}`. Nothing else. A comment header states it is inert until the repo variable is set.
- `deploy/outline/docker-compose.yml`: services outline (image = the SAME pinned tag as Task 6, env `${OUTLINE_SECRET_KEY:?set in Dokploy}`-style for SECRET_KEY/UTILS_SECRET/DATABASE_URL/REDIS_URL/URL + OIDC vars `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`/`OIDC_AUTH_URI`/`OIDC_TOKEN_URI`/`OIDC_USERINFO_URI` pointing at the Keycloak realm), postgres:16-alpine + named volume, redis:7-alpine; no published ports (Dokploy's front door routes by domain).
- `docs/OUTLINE.md` (follow the user's tech-doc style — orient first, concise, honest limits): what Outline is in this estate; deployment runbook (Dokploy project on the Hetzner stack, domain `docs.cicadasystem.com` — wildcard DNS already resolves, Keycloak OIDC client creation at sso.cicadasystem.com, secrets via Dokploy env); service-account + API-token creation; running the publisher by hand; **a bold "before deploying board schema v25: export production pen-documents"** section with the exact `scripts/export-documents.mjs` invocation against the `cicada-steward-3cmfas_steward-data` volume; CI activation (set `DOCS_PUBLISH_ENABLED` + secret); known limits (markdown only, relative images 404, archive-not-delete semantics, e2e seeding pinned to the image tag).

**Steps:**
- [ ] Write all three files + README link; `npm run typecheck:all && npm run test:all` (workflow/compose are not typechecked — a tooling test asserting `publish-docs.yml` contains the guard expression is cheap and pins inertness; add it to `tests/tooling/`).

---

## Self-review

- **Spec coverage:** export (T1), schema v25 + server removal (T2), contract/web/Playwright removal + "Documents page gone" (T3), publisher core + config (T4), Outline sink/client/retry (T5), real-Outline e2e proving banners + read-only + idempotence + archive (T6), inert CI + Dokploy compose + runbook incl. export-first precondition (T7). Deferred per spec: live deployment, CI activation, OIDC setup, production export execution, attachment sync.
- **Placeholder scan:** the two implementation-time lookups (Outline image tag; pinned-version seed SQL) are explicit verify-then-pin instructions with recorded provenance, not TBDs — the spec names this the documented fragile point.
- **Type consistency:** `DocsSink`/`DocSource`/`PublishReport`/`DocsPublishConfig` defined once in T4 and consumed verbatim in T5/T6; `SseStream` rename introduced in T2 is internal to service.ts; `TASK_MESSAGE_ACTOR_TYPES` re-rooting in T3 keeps the store.ts CHECK text byte-identical (drift test guards it).
