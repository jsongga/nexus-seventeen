# Project picker and instant documents design

Status: Approved (Stream 1 only). Amended 2026-08-15: Stream 2 (instant
documents / Milkdown) is withdrawn — `orchestrator-design.md` (repo root) is
now the source of truth, and human-facing documents move to a self-hosted
Outline instance per its §2; the board's pen-document editor gets no further
investment. Stream 1 (project picker) remains approved and becomes the
registration front door for §6 project onboarding.
Author: John Song + Claude (design)
Date: 2026-08-10
Scope: A real project picker for "Add project" (Stream 2 withdrawn, see
Status)

## Summary

Adding a project today means pasting an absolute path into a text field, and
creating a document means filling a three-field form and then clicking "Take
the pen" before typing. This design replaces both:

1. **Project picker** — the board server (which runs on the operator's machine
   and has filesystem access) discovers local project folders under the
   operator's `*Projects` roots and exposes a directory browser, both behind
   human-token-only endpoints. The Add-project dialog lists discovered
   projects one click away, with browse and paste as fallbacks.
2. **Instant documents** — "New document" creates an "Untitled document"
   immediately and opens it with the pen already held; the title is renamed
   inline. The raw-Markdown `<textarea>`/`<pre>` pair is replaced by Milkdown
   (WYSIWYG editing whose persisted format stays Markdown), with Mermaid
   diagram support and debounced auto-save.

The document store, pen model, snapshot versioning, SSE updates, and the
agents' view of documents (plain Markdown) are unchanged.

## Decisions made (with the operator)

1. **Roots are auto-detected**: directories in `$HOME` whose name ends in
   `Projects` (not hidden). `STEWARD_PROJECT_ROOTS` (colon-separated absolute
   paths) overrides the list entirely for non-standard setups and the Docker
   deploy.
2. **Custom paths use a folder browser + filter**, server-backed (browsers
   cannot reveal absolute paths natively). Pasting a path remains as a
   power-user shortcut, validated server-side before submit.
3. **"New document" creates instantly** ("Untitled document", empty content,
   pen auto-acquired) — a one-tap project menu appears first only when more
   than one project exists.
4. **Milkdown is the editor** (MIT, ProseMirror-based, Markdown as source of
   truth, official Mermaid diagram plugin), using the Crepe preset for the
   polished UI. Chosen over TipTap/BlockNote because their canonical formats
   are not Markdown, and agents round-trip these documents as Markdown.
5. **The pen model stays.** No CRDT/multi-cursor co-editing; auto-save makes
   single-writer editing feel live without redesigning concurrency.

## Stream 1 — Project picker

**Server: two endpoints, human token only.** Agent credentials receive 403 —
workers get no filesystem surface. Both live under a new `host` collaborator
(the first board API that reads the host filesystem).

- `GET /v1/host/project-roots` → `{ roots: [{ path, name, projects: [{ name,
  path, hasGit, modifiedAtMs }] }] }`. Scans `$HOME` for non-hidden
  directories named `*Projects`; each root lists its immediate non-hidden
  subdirectories. `hasGit` = a `.git` entry exists. The server returns roots
  and projects sorted by name (canonical order); the web list re-orders
  projects recently-modified-first using `modifiedAtMs`. Project lists are
  capped (500/root) with a `truncated` flag.
- `GET /v1/host/directories?path=<absolute>` → `{ path, parent, entries:
  [{ name, path, hasGit }], truncated }`, directories only, never file
  contents, same 500-entry cap.
  Containment: the request path must resolve (`realpath`, symlinks followed)
  to inside `$HOME` or inside a configured root; anything else is 403
  `HOST_PATH_OUTSIDE_ROOTS`. Missing/non-directory paths are 404/409 with
  distinct codes so the UI can say "not found" vs "that's a file".

Discovery failure (no roots, e.g. Docker) is a normal empty response, not an
error.

**Web: the Add-project dialog becomes a two-mode picker.**

- **Your projects** (default when discovery returns anything): one filterable
  list of all roots' projects, grouped by root, git badge, sorted
  recently-modified-first within a root. Projects already on the board (path
  matches an existing project's workspace metadata) show as "Added" and are
  disabled. Selecting a folder fills the form: name = folder name (editable),
  path shown read-only.
- **Browse** (always available; the default when discovery is empty):
  breadcrumb navigation starting at `$HOME`, a filter box over the current
  folder, "Use this folder". The absolute-path text field stays; on submit it
  is validated through `/v1/host/directories` and errors render inline.

Creation payload is unchanged (`name`, `description` = path), so project
metadata parsing, lane-config prefills, and everything downstream keep
working.

## Stream 2 — Instant documents and the Milkdown editor (withdrawn 2026-08-15)

> Withdrawn, kept for the record. Documents move to self-hosted Outline per
> `orchestrator-design.md` §2; nothing below will be built.

**Server: two small additions to the existing document API.**

- `POST /v1/projects/:id/documents` accepts optional `acquirePen: true`:
  create + pen acquisition in one transaction (no race with an agent grabbing
  the pen between create and open).
- The snapshot save accepts an optional `title` alongside `content` — same
  pen-epoch and content-version guards, same version bump. Title-only saves
  are valid (content unchanged). Existing title validation (non-empty, length
  cap) applies. This is the rename mechanism; no separate rename endpoint.

**Web: creation flow.** "New document" with one project creates instantly and
routes to the editor (pen held, focus in the title). With several projects, a
one-tap menu (project names) appears; choosing creates. The modal form is
deleted. Default title: "Untitled document".

**Web: the editor.** Milkdown Crepe replaces both halves of today's UI:

- Holding the pen → editable WYSIWYG (slash menu, tables, task lists, code
  blocks, Mermaid diagrams via the official diagram plugin).
- Not holding the pen → the same surface read-only: rendered Markdown instead
  of today's raw monospace `<pre>`.
- The title becomes an inline-editable heading (pen-gated like content).
- Loaded lazily as its own chunk (`import()` on first document open) so the
  Mermaid/editor weight stays out of the board bundle.

**Saving.** While the pen is held, changes auto-save as debounced snapshot
saves (2 s idle, skipped while a save is in flight or a remote-change
conflict is showing); the explicit Save button remains. Draft preservation
(`documentDraftStore`), the 48 KiB limit, version-conflict handling, and SSE
live updates keep their current semantics — the editor is a new view over the
same draft state.

**Round-trip honesty.** Milkdown normalizes some Markdown formatting on save
(list markers, spacing). Agents will occasionally see reformatted-but-
semantically-identical documents after a human edit. A round-trip test
(agent-written fixture → open → save → semantic diff) pins the acceptable
normalization; CR/LF is already normalized at the worker boundary.

## Out of scope

CRDT multi-cursor co-editing (conflicts with the pen model); browsing file
*contents* over the host API (directories only); non-Markdown document types;
project auto-registration (discovery lists candidates, the operator adds
them); reading `.git` beyond existence.

## Verification bar

Per task: `npm run typecheck:all` plus the relevant suite green before
commit. New unit coverage: root scanning, path containment (symlink escape
attempts), title-save validation, auto-save debounce logic. New e2e: pick
from discovered list, browse to a folder, paste-path validation error,
instant create → inline rename → auto-save → reload shows title. Round-trip
fixture test as above. Full `npm test` + e2e at stream boundaries; dual
review (Claude + `codex review`) per task.

## Alternatives considered

- **Native browser folder picker** — rejected: `webkitdirectory` and the File
  System Access API deliberately never expose absolute paths, which the fleet
  needs for workdirs. A server-backed browser is the only way to get real
  paths.
- **Hard-coding the three named roots** — rejected: misses the other five
  JetBrains roots in active use; `*Projects` auto-detection plus env override
  covers all setups including Docker.
- **TipTap / BlockNote as the editor** — rejected: both are excellent but
  their canonical formats (rich JSON / block JSON) make Markdown an export,
  with lossy round-trips; agents read and write these documents as Markdown,
  so Markdown must stay the source of truth. BlockNote's licensing (MPL +
  AGPL/paid XL packages) also complicates adoption.
- **Full CRDT collaboration (Y.js)** — rejected for this round: requires a
  sync server and a concurrency redesign, and the pen model's single-writer
  guarantee is load-bearing for agent/human coexistence. Auto-save delivers
  most of the perceived liveness.
- **Separate rename endpoint** — rejected: folding `title` into snapshot save
  reuses the pen/version guards and keeps the API surface at one mutation
  path for document content.
