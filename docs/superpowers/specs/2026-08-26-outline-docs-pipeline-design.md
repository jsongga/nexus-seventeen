# Campaign 9: Outline + docs pipeline

**Status:** Approved for implementation
**Author:** Claude (brainstormed under standing drive-to-completion authorization)
**Date:** 2026-08-26
**Scope:** orchestrator-design.md §2 (documentation layout / Outline publishing), roadmap campaign 9. Local-first: no GitHub pushes, no live infra deployment — CI activation and the Dokploy Outline deployment ship as inert artifacts + a runbook the user executes.

## Summary

§2 splits documentation three ways: execution inputs live in the orchestrator repo, branch-correct docs live in each product repo, and *humans read* repo docs in Outline — published read-only on merge by a mechanical CI job, in a view-only collection, each page carrying a banner naming its source path, with comments as the feedback channel. The board's built-in pen-documents feature (a collaborative markdown editor with pen/epoch fencing) was the stopgap; it froze on 2026-08-15 and retires once the replacement exists.

Campaign 9 ships three slices:

1. **Docs publisher** — a standalone mechanical CLI (`npm run docs:publish`) that reads a repo's `README.md` + `docs/**/*.md` from a git ref, prepends a source banner, and syncs them into one view-only Outline collection per repo via Outline's HTTP API. Proven end-to-end against a **real containerized Outline** in the docker test tier.
2. **Pen-documents retirement** — a from-scratch export script (content + full event history, no data loss), then schema v25 drops both tables and the editor, routes, SSE stream, contract surface, and the Documents page are removed.
3. **Deferred activation artifacts** — an inert GitHub Actions publish job (guarded by a repo variable), a Dokploy compose file for Outline, and an operational runbook (`docs/OUTLINE.md`) covering deployment, Keycloak OIDC, and the **export-production-first** precondition.

**Exit criteria** (roadmap): repo docs readable in Outline with source banners — proven by the docker-tier e2e publishing this repo's docs into a real Outline and reading them back; Documents page gone — proven by web tests and the updated Playwright suite.

Seam facts below are from `.superpowers/sdd/campaign9-exploration.md` (as-built exploration, 2026-08-26; ops facts from platform-docs/DEPLOYMENT.md).

---

## Part A — The docs publisher

### Shape

A plain Node CLI, **outside the agent sandbox** (§2: "mechanical CI job, no LLM in the path" — this also sidesteps the egress proxy's CONNECT-443-exact-host allowlist). New package `src/server/docs-publish/`:

- `enumerate.ts` — `enumerateDocs(repoPath, ref, options): readonly DocSource[]` where `DocSource = { path, title, markdown }`. Reads via `git show <ref>:<path>` (branch-correct, the `onboarding-check.ts` precedent) using an injectable `GitRunner`; the file set is `README.md` + every `docs/**/*.md` reachable from `git ls-tree -r`, minus configured excludes (default `docs/superpowers/**`). Title = repo-relative path (stable identity).
- `banner.ts` — `withSourceBanner(source: DocSource, repoName: string, shortSha: string): string`:

  ```markdown
  > **Read-only mirror.** Source: `<repoName>/<path>` @ <shortSha>. Edit in the repository — this page is republished on merge. Comments are welcome here.
  ```

  prepended, followed by a blank line, then the original markdown untouched.
- `sink.ts` — the seam:

  ```ts
  export interface DocsSink {
    ensureCollection(repoName: string): Promise<SinkCollection>;   // creates or finds; enforces read-only permission
    listDocuments(collection: SinkCollection): Promise<readonly SinkDocument[]>;  // { id, title }
    upsert(collection: SinkCollection, title: string, markdown: string): Promise<void>;
    archive(collection: SinkCollection, documentId: string): Promise<void>;       // for titles no longer in the source set
  }
  ```
- `outline-sink.ts` — `OutlineSink implements DocsSink` over Outline's REST API (`/api/collections.list|create|update`, `/api/documents.list|create|update|archive`), auth `Bearer` token. One collection per repo named `<repoName> docs`, `permission: "read"` (team members read + comment; only the token's service account writes). Upsert = match by exact title within the collection, update when the (banner-included) text differs, create otherwise; source-absent titles are archived (not deleted) — the mirror never destroys history.
- `client.ts` — a copy of the `JsonClient` shape (`http-board-client.ts:239-292`): injectable fetch, per-call `AbortController` + unref'd timeout, bounded response reader, `redirect:"error"` / `credentials:"omit"`, typed `OutlineHttpError(status, code)`. One retry layer above it: 3 attempts, 1s→8s backoff, on 429/5xx/network only. No retry inside the client.
- `publish.ts` — `publishRepo(config-entry, sink, git): Promise<PublishReport>` orchestrating enumerate → banner → diff → upsert/archive; `PublishReport = { repo, created, updated, archived, unchanged, failures[] }`. Non-zero exit when any failure.
- `main.ts` — CLI entry (`npm run docs:publish [-- --config <path>] [--repo <name>] [--dry-run]`). `--dry-run` prints the report without calling the sink.

### Config and secrets

`config/docs-publish.json`, loaded with the established discipline (`profiles.ts` pattern: hand-rolled validators, `O_NOFOLLOW`, ≤1 MiB, `Object.freeze`):

```json
{
  "version": 1,
  "outline": { "baseUrl": "https://docs.cicadasystem.com" },
  "repos": [
    { "name": "nexus-seventeen", "path": ".", "ref": "HEAD",
      "exclude": ["docs/superpowers/**"] }
  ]
}
```

The API token comes only from `STEWARD_OUTLINE_API_TOKEN` (the `required()` env pattern; never in the JSON; gitleaks guards the slip). `baseUrl` must be https except when the config sets `allowInsecureBaseUrl: true` (the containerized e2e needs http://localhost).

### Testing

- Unit: enumeration against fixture git repos (ref-correctness: worktree edits invisible), banner formatting, diff/idempotence logic against an in-memory `DocsSink` fake, config parsing (reject unknown keys, oversize, symlink), client retry/backoff with injected fetch, error surfaces.
- **Docker-tier e2e** (`tests/container/outline-publish.test.ts`): boots a **pinned** `outline/outline` version + `postgres:16-alpine` + `redis:7-alpine` on a dedicated docker network using the tier's established primitives (`docker run -d` + readiness polling; `ensureNetwork` gets exported from `task-container/infrastructure.ts` or ~40 lines reimplemented in the test helper). API token provisioned by **direct postgres seeding** of team/user/apiKey rows — deliberately pinned to the image version so the seeding SQL stays stable; the pin and the fragility are documented in the test header. Readiness deadlines sized for Outline's first-boot migrations (up to 180 s, 500 ms poll). The arc: publish this repo's own docs twice → first run creates, second run reports all-unchanged (idempotence); assert via Outline's API that the collection is `permission:"read"`, each document's text starts with the source banner, and a doc removed from the source set gets archived on a third run.

## Part B — Pen-documents retirement

Ordering per roadmap: **export first, then remove.** Zero cross-references point into the document tables (verified), so the drop is mechanically safe; the couplings are contract/type-level.

- **Export** — `scripts/export-documents.mjs <sqlite-path> <out-dir>`: direct SQLite read (`node:sqlite`), writes `<project-slug>/<document-slug>.md` (metadata header: title, project, content version, updated at) plus `<document-slug>.events.jsonl` (every `document_events` row — full history, no data loss). Refuses a missing/invalid DB; idempotent into a fresh dir. Tested against a fixture DB built by the current schema.
- **Schema v25** — `migrateVersion24To25`: `DROP TABLE document_events; DROP TABLE documents;` (that order — both FK `ON DELETE RESTRICT` toward projects). `DOCUMENT_SCHEMA` leaves the base `SCHEMA` but **stays inside `MIGRATE_VERSION_3_TO_4`** so the legacy v1–v3 ladder still works (create-then-later-drop). Golden `v24-schema.sql` fixture; `contract-drift.test.ts` loses the document CHECK assertions (239-240); `board.test.ts:7865` (synthesizes v3 by dropping the tables) reworked for the new end state.
- **Contract** — remove the five document interfaces, three request types, five validators, three board parse helpers, `DOCUMENT_CONTENT_MAX_BYTES`, `DocumentContentType`; **`BoardSnapshot.documents` leaves the exact-key parser list** (validate.ts:2145/2161). `TASK_MESSAGE_ACTOR_TYPES` becomes the primary constant (currently an alias of `DOCUMENT_ACTOR_TYPES`, which feeds the live `task_messages.actor_type` CHECK) — re-rooted, value unchanged, store.ts/table CHECK untouched.
- **Server** — delete `collaborators/documents.ts`, the `documentEvents` emitter (runtime.ts:61/74/731), board.ts field/methods/`snapshot()` line 569, the five routes + `#documentStreams` + `#documentActor` + `#openDocumentStream` (service.ts), the three schema.ts adapters, the persistence row mappers. The `DocumentStream` interface name is shared with the workflow SSE stream — **renamed** (e.g. `SseStream`), not deleted.
- **Web** — delete DocumentsPage (+test), document-drafts (+test), storage-lease, the client document methods/stream machinery, parse/wire/types document shapes, the Documents nav button + `BoardPage` arm, the `#/documents` routes + fallback branch, BoardApp branches + `onSelectDocument` threading, `projectDocuments`/`boardDocumentMeta` in WorkspacePages (ContextSidebar itself survives — only its `documentId` branch goes). **`model/project.ts:358`'s snapshot-revision sum loses the documents term — the refresh/staleness arithmetic must be adjusted deliberately, with its tests, not left to drift.** All `documents: []` fixtures drop (10+ vitest files, 2 Playwright fixtures).
- **Tests** — Playwright: fixture harness (spec 85-300) and the four document tests (3005/3087/3181/3263) deleted; the two tests carrying nav/sidebar assertions (922-926, 2731-2781) edited — including a positive assertion that the rail has **no** Documents button. Runtime: board.test.ts 7334/7369 and http.test.ts:1481 deleted.
- `docs/DOCUMENT_BROADCAST.md` deleted; README link removed.

## Part C — Deferred activation (authored now, executed by the user)

- **CI publish job** — `.github/workflows/publish-docs.yml`: `on: push: branches: [main]`, single job gated `if: vars.DOCS_PUBLISH_ENABLED == 'true'`, runs `npm ci && npm run docs:publish` with `STEWARD_OUTLINE_API_TOKEN: ${{ secrets.STEWARD_OUTLINE_API_TOKEN }}`. Inert until the user sets the variable + secret; costs nothing when pushed; nothing pushes from this campaign.
- **Dokploy Outline deployment** — `deploy/outline/docker-compose.yml` (outline + postgres + redis, named volumes, `${OUTLINE_SECRET_KEY:?...}`-style env requirements) and `docs/OUTLINE.md`, the runbook: create the Dokploy project, set env (secrets, `URL=https://docs.cicadasystem.com` — wildcard DNS already resolves), OIDC against the existing Keycloak (sso.cicadasystem.com), create the service account + API token, then run the publisher once by hand.
- **Retirement precondition, stated in bold in the runbook and the migration commit message**: before deploying a board version containing schema v25, run `scripts/export-documents.mjs` against the production volume (`cicada-steward-3cmfas_steward-data`) — the migration drops the tables on first boot.

## Testing summary

Runtime units (publisher, export, migration, contract), web vitest (removal + revision arithmetic), docker-tier Outline e2e (both idempotence and read-only/banner assertions), full Playwright (Documents gone). Gates per task: `npm run typecheck:all && npm run test:all`; docker tier + Playwright at campaign close.

## Limits and deferrals

- **Live Outline on Dokploy, CI activation, Keycloak OIDC setup, production export** are operational steps the user executes with the runbook — the campaign proves everything locally, including against a real Outline in Docker.
- **The publisher covers markdown only** (§2's slots are all markdown); images/attachments referenced by docs are not uploaded — a page's relative image links will 404 in Outline until a future campaign adds attachment sync. Stated in the runbook.
- **Outline API-token seeding in the e2e is version-pinned and deliberately fragile** — bumping the Outline image requires revisiting the seed SQL; the pin lives in one constant.
- **This repo fails its own five-slot convention** (no architecture/interface/dependencies/decisions docs). Campaign 9 publishes what exists; authoring the missing slots is content work, not pipeline work — likely paired with the first live Cicada onboarding.
- The board's own deployed instance keeps serving until the user chooses to deploy; nothing in this campaign auto-deploys (no pushes).

## Alternatives considered

- **Publish from inside the agent sandbox / as a pipeline stage** — rejected: §2 mandates a mechanical job with no LLM; the egress proxy (CONNECT-only, 443, exact hosts) would need widening for zero benefit.
- **Outline import API / file uploads instead of documents.create** — rejected: per-document create/update gives precise idempotence and banner control; import endpoints are batch-oriented and less stable.
- **Delete source-absent Outline docs** — rejected in favor of archive: the mirror must never destroy comment history.
- **Local state file mapping paths→Outline ids** — rejected: title-within-collection lookup keeps the CI job stateless (§2's "mechanical, no state"); titles are repo-relative paths, collisions impossible within a repo.
- **docker compose for the e2e** — rejected: the tier has zero compose precedent; three `docker run -d` calls on one network with the existing primitives keep the harness uniform.
- **Feature-flag the Documents page before removal** — rejected: the feature is frozen socially, has no flag today, and the roadmap's staged path (export → remove) doesn't need one; a flag would be new code built only to be deleted.
- **Export via ArtifactStore** — rejected: project-scoped, 192 KiB-capped, no bulk read; a filesystem dump is the actual "no data loss" artifact and works against the production volume.
- **Wiki alternatives (BookStack, keep pen-documents)** — out of scope: §2 names Outline; the estate decision was made in the design doc.
