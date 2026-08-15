# Project Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the paste-a-path Add-project field with a picker that lists projects discovered under the operator's `~/*Projects` roots and offers a server-backed folder browser, per Stream 1 of `docs/superpowers/specs/2026-08-10-project-picker-and-documents-design.md`.

**Architecture:** A new filesystem-reading module `src/server/task-board/host.ts` (no DB; sibling of `skills.ts`) backs two human-token-only GET routes in `service.ts`. The web client gains two read methods; the Add-project dialog becomes a two-mode picker (discovered list / folder browser) with paste retained and server-validated. Creation payload is unchanged (`{ name, description: path }`).

**Tech Stack:** Node 22/24 (`node:fs/promises`), existing board HTTP stack, React 19, vitest for web units, `node --test` for runtime, Playwright for e2e (route-mocked, no real FS).

## Global Constraints

- Host endpoints are **human-token-only**: `requireHuman` guards both routes. Deliberate deviation from the spec's "agents get 403": `requireHuman` throws **401 UNAUTHORIZED**, matching every existing human-only route. Consistency governs.
- Directory names only — never file contents, never files in listings.
- Hidden entries (name starts with `.`) are always excluded.
- Listing cap is **500** entries (`HOST_LIST_CAP`), with a `truncated: boolean` flag; applies to both per-root project lists and browse listings.
- Auto-detected roots: non-hidden directories directly in `$HOME` whose name **ends with `Projects`**, sorted by name.
- `STEWARD_PROJECT_ROOTS` (colon-separated absolute paths) **replaces** auto-detection entirely when set. Missing/unreadable roots are silently skipped, never errors.
- Containment: the browse path must `realpath`-resolve to inside `$HOME` or a configured override root. Violation → **403 `HOST_PATH_OUTSIDE_ROOTS`**; nonexistent → **404 `HOST_PATH_NOT_FOUND`**; a file → **409 `HOST_PATH_NOT_DIRECTORY`**. Codes live in `TASK_BOARD_ERROR_CODES`.
- Browse `path` query param: optional (default `$HOME`); when present exactly one value, 1–512 chars, must start with `/`, no `\r` or `\n`.
- Web create payload stays `{ name, description }` where description is the bare absolute path — existing metadata parsing (`parseProjectMetadata`) recognizes bare-path lines as workspace entries.
- Every task: `npm run typecheck:all` and the task's suite green before commit. Codex sandbox cannot bind listeners — HTTP-level tests are verified by the controller outside the sandbox.

---

### Task 1: Host filesystem module + error codes

**Files:**
- Modify: `src/shared/task-board-contract/index.ts` (TASK_BOARD_ERROR_CODES, ~line 3)
- Create: `src/server/task-board/host.ts`
- Test: `tests/server/task-board/host.test.ts`

**Interfaces:**
- Consumes: `TaskBoardError` from `./errors.js`, `TASK_BOARD_ERROR_CODES` from `#shared/task-board-contract`.
- Produces (Task 2 depends on these exact names):
  `HOST_LIST_CAP = 500`;
  `interface HostContext { homeDir: string; rootsOverride: readonly string[] | null }`;
  `listProjectRoots(context: HostContext): Promise<HostProjectRoot[]>`;
  `listDirectories(context: HostContext, requestedPath: string): Promise<HostDirectoryListing>`;
  `HostProjectRoot { name, path, projects: HostProjectEntry[], truncated }`;
  `HostProjectEntry { name, path, hasGit, modifiedAtMs }`;
  `HostDirectoryListing { path, parent: string | null, entries: HostDirectoryEntry[], truncated }`;
  `HostDirectoryEntry { name, path, hasGit }`.

- [ ] **Step 1: Add the three error codes**

In `TASK_BOARD_ERROR_CODES` (alphabetical, after `AGENT_VERSION_CONFLICT`):

```ts
  HOST_PATH_NOT_DIRECTORY: "HOST_PATH_NOT_DIRECTORY",
  HOST_PATH_NOT_FOUND: "HOST_PATH_NOT_FOUND",
  HOST_PATH_OUTSIDE_ROOTS: "HOST_PATH_OUTSIDE_ROOTS",
```

- [ ] **Step 2: Write the failing tests**

`tests/server/task-board/host.test.ts`, `node:test` style (mirror imports/assert style of an existing file in that directory). Fixture helper builds a temp home with `mkdtemp`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_LIST_CAP, listDirectories, listProjectRoots } from "#server/task-board/host";

async function makeHome(): Promise<string> {
  // realpath: on macOS tmpdir is a /var -> /private/var symlink; containment compares realpaths.
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-test-")));
  await mkdir(join(home, "WebstormProjects", "alpha", ".git"), { recursive: true });
  await mkdir(join(home, "WebstormProjects", "beta"), { recursive: true });
  await mkdir(join(home, "WebstormProjects", ".hidden"), { recursive: true });
  await mkdir(join(home, "PycharmProjects", "gamma"), { recursive: true });
  await mkdir(join(home, "NotAroot"), { recursive: true });
  await mkdir(join(home, ".dotProjects"), { recursive: true });
  await writeFile(join(home, "WebstormProjects", "afile.txt"), "x");
  return home;
}

test("listProjectRoots finds *Projects roots, skips hidden and files, flags git", async () => {
  const home = await makeHome();
  try {
    const roots = await listProjectRoots({ homeDir: home, rootsOverride: null });
    assert.deepEqual(roots.map((root) => root.name), ["PycharmProjects", "WebstormProjects"]);
    const web = roots[1];
    assert.deepEqual(web.projects.map((p) => p.name), ["alpha", "beta"]);
    assert.equal(web.projects[0].hasGit, true);
    assert.equal(web.projects[1].hasGit, false);
    assert.ok(web.projects.every((p) => p.modifiedAtMs > 0));
    assert.equal(web.truncated, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listProjectRoots override replaces detection and skips missing roots", async () => {
  const home = await makeHome();
  try {
    const roots = await listProjectRoots({
      homeDir: home,
      rootsOverride: [join(home, "NotAroot"), join(home, "missing")],
    });
    assert.deepEqual(roots.map((root) => root.name), ["NotAroot"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listDirectories lists subdirectories with parent, rejects escape/missing/file", async () => {
  const home = await makeHome();
  try {
    const context = { homeDir: home, rootsOverride: null };
    const listing = await listDirectories(context, join(home, "WebstormProjects"));
    assert.deepEqual(listing.entries.map((e) => e.name), ["alpha", "beta"]);
    assert.equal(listing.parent, home);
    const top = await listDirectories(context, home);
    assert.equal(top.parent, null);
    await assert.rejects(() => listDirectories(context, "/etc"), (error: { code: string }) => error.code === "HOST_PATH_OUTSIDE_ROOTS");
    await assert.rejects(() => listDirectories(context, join(home, "nope")), (error: { code: string }) => error.code === "HOST_PATH_NOT_FOUND");
    await assert.rejects(() => listDirectories(context, join(home, "WebstormProjects", "afile.txt")), (error: { code: string }) => error.code === "HOST_PATH_NOT_DIRECTORY");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listDirectories refuses a symlink that escapes the browsable area", async () => {
  const home = await makeHome();
  try {
    await symlink("/etc", join(home, "escape"));
    await assert.rejects(
      () => listDirectories({ homeDir: home, rootsOverride: null }, join(home, "escape")),
      (error: { code: string }) => error.code === "HOST_PATH_OUTSIDE_ROOTS",
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listings cap at HOST_LIST_CAP and set truncated", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-cap-")));
  try {
    const root = join(home, "BigProjects");
    await Promise.all(Array.from({ length: HOST_LIST_CAP + 1 }, (_, i) =>
      mkdir(join(root, `p${String(i).padStart(4, "0")}`), { recursive: true })));
    const roots = await listProjectRoots({ homeDir: home, rootsOverride: null });
    assert.equal(roots[0].projects.length, HOST_LIST_CAP);
    assert.equal(roots[0].truncated, true);
    const listing = await listDirectories({ homeDir: home, rootsOverride: null }, root);
    assert.equal(listing.entries.length, HOST_LIST_CAP);
    assert.equal(listing.truncated, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
```

- [ ] **Step 3: Run to verify failure** — `npm run test:runtime` fails: cannot find module `#server/task-board/host`.

- [ ] **Step 4: Implement `src/server/task-board/host.ts`**

```ts
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { TASK_BOARD_ERROR_CODES } from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";

/** Maximum entries returned by any host listing; more sets `truncated`. */
export const HOST_LIST_CAP = 500;

export interface HostContext {
  readonly homeDir: string;
  /** When non-null, replaces $HOME auto-detection entirely. */
  readonly rootsOverride: readonly string[] | null;
}
export interface HostProjectEntry {
  readonly name: string;
  readonly path: string;
  readonly hasGit: boolean;
  readonly modifiedAtMs: number;
}
export interface HostProjectRoot {
  readonly name: string;
  readonly path: string;
  readonly projects: readonly HostProjectEntry[];
  readonly truncated: boolean;
}
export interface HostDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly hasGit: boolean;
}
export interface HostDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly HostDirectoryEntry[];
  readonly truncated: boolean;
}

async function directoryNames(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if ((await stat(join(path, entry.name))).isDirectory()) names.push(entry.name);
      } catch {
        // Broken symlink: skip.
      }
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

async function candidateRoots(context: HostContext): Promise<string[]> {
  if (context.rootsOverride !== null) return [...context.rootsOverride];
  let names: string[];
  try {
    names = await readdir(context.homeDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith(".") && name.endsWith("Projects"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(context.homeDir, name));
}

export async function listProjectRoots(context: HostContext): Promise<HostProjectRoot[]> {
  const roots: HostProjectRoot[] = [];
  for (const rootPath of await candidateRoots(context)) {
    let names: string[];
    try {
      names = await directoryNames(rootPath);
    } catch {
      continue;
    }
    const projects: HostProjectEntry[] = [];
    for (const name of names.slice(0, HOST_LIST_CAP)) {
      const path = join(rootPath, name);
      let modifiedAtMs: number;
      try {
        modifiedAtMs = Math.round((await stat(path)).mtimeMs);
      } catch {
        continue;
      }
      projects.push({ name, path, hasGit: existsSync(join(path, ".git")), modifiedAtMs });
    }
    roots.push({ name: basename(rootPath), path: rootPath, projects, truncated: names.length > HOST_LIST_CAP });
  }
  return roots;
}

async function allowedBases(context: HostContext): Promise<string[]> {
  const bases: string[] = [];
  for (const candidate of [context.homeDir, ...(context.rootsOverride ?? [])]) {
    try {
      bases.push(await realpath(candidate));
    } catch {
      // A missing base cannot admit any path.
    }
  }
  return bases;
}

function withinBases(path: string, bases: readonly string[]): boolean {
  return bases.some((base) => path === base || path.startsWith(base + sep));
}

export async function listDirectories(context: HostContext, requestedPath: string): Promise<HostDirectoryListing> {
  const bases = await allowedBases(context);
  let resolved: string;
  try {
    resolved = await realpath(requestedPath);
  } catch {
    throw new TaskBoardError(404, TASK_BOARD_ERROR_CODES.HOST_PATH_NOT_FOUND, "The folder does not exist");
  }
  if (!withinBases(resolved, bases)) {
    throw new TaskBoardError(403, TASK_BOARD_ERROR_CODES.HOST_PATH_OUTSIDE_ROOTS, "The folder is outside the browsable area");
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.HOST_PATH_NOT_DIRECTORY, "The path is a file, not a folder");
  }
  const names = await directoryNames(resolved);
  const parentPath = dirname(resolved);
  return {
    path: resolved,
    parent: parentPath !== resolved && withinBases(parentPath, bases) ? parentPath : null,
    entries: names.slice(0, HOST_LIST_CAP).map((name) => ({
      name,
      path: join(resolved, name),
      hasGit: existsSync(join(resolved, name, ".git")),
    })),
    truncated: names.length > HOST_LIST_CAP,
  };
}
```

- [ ] **Step 5: Run to verify pass** — `npm run test:runtime` (all green) and `npm run typecheck:all`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: host filesystem module for project discovery"`

---

### Task 2: Config plumbing + host routes

**Files:**
- Modify: `src/server/task-board/config.ts` (options + normalize)
- Modify: `src/server/task-board/main.ts` (env parsing)
- Modify: `src/server/task-board/service.ts` (two GET routes + query parser)
- Test: `tests/server/task-board/host-routes.test.ts`

**Interfaces:**
- Consumes from Task 1: `HostContext`, `listProjectRoots`, `listDirectories` from `./host.js`.
- Produces: `TaskBoardOptions.host?: { homeDir?: string; projectRoots?: readonly string[] }`; resolved `TaskBoardConfig.host: HostContext` (homeDir default `os.homedir()`, `rootsOverride` = `projectRoots ?? null`, each entry must start with `/` else the existing config-validation error pattern); routes `GET /v1/host/project-roots` → `{ roots: HostProjectRoot[] }` and `GET /v1/host/directories[?path=…]` → `{ listing: HostDirectoryListing }` (Task 3 parses these envelopes).

- [ ] **Step 1: Config.** Add the `host` option and resolve it in `normalizeTaskBoardConfig` following the file's existing validation style (throw its existing config error type for a non-absolute override entry). Default: `{ homeDir: homedir(), rootsOverride: null }` (`import { homedir } from "node:os"`).

- [ ] **Step 2: Env.** In `main.ts`, next to the other env reads:

```ts
const projectRootsRaw = process.env.STEWARD_PROJECT_ROOTS;
// …into createTaskBoardService options:
host: projectRootsRaw === undefined ? undefined : {
  projectRoots: projectRootsRaw.split(":").map((value) => value.trim()).filter((value) => value.length > 0),
},
```

- [ ] **Step 3: Routes.** In `service.ts`, beside the other `/v1` GET routes (after the `/v1/projects` block is a fine home):

```ts
if (url.pathname === "/v1/host/project-roots" && request.method === "GET") {
  noQuery(url);
  requireHuman(request, this.config);
  sendJson(response, 200, { roots: await listProjectRoots(this.config.host) });
  return;
}
if (url.pathname === "/v1/host/directories" && request.method === "GET") {
  const path = hostDirectoriesQuery(url);
  requireHuman(request, this.config);
  sendJson(response, 200, { listing: await listDirectories(this.config.host, path ?? this.config.host.homeDir) });
  return;
}
```

Query parser beside `workItemListQuery`:

```ts
function hostDirectoriesQuery(url: URL): string | undefined {
  const values = url.searchParams.getAll("path");
  if ([...url.searchParams.keys()].some((key) => key !== "path") || values.length > 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Query parameters are invalid");
  }
  const path = values[0];
  if (path === undefined) return undefined;
  if (path.length < 1 || path.length > 512 || !path.startsWith("/") || /[\r\n]/u.test(path)) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "path must be an absolute path of at most 512 characters");
  }
  return path;
}
```

- [ ] **Step 4: HTTP tests.** New `tests/server/task-board/host-routes.test.ts`, bootstrapped exactly like the existing `tests/server/task-board/http.test.ts` (temp db, `createTaskBoardService`, `service.start()`, fetch with/without `Authorization: Bearer <humanToken>`), with `host: { homeDir: <temp home fixture from Task 1's makeHome pattern>, projectRoots: undefined }` — plus one service configured with `projectRoots: [fixture root]`. Cases:
  - no token → 401; agent bearer (any non-human token) → 401
  - human → 200, body `{ roots: [...] }` with the fixture's roots/projects
  - `GET /v1/host/directories` (no query) → 200, `listing.path` = temp home
  - `?path=/etc` → 403 `HOST_PATH_OUTSIDE_ROOTS`; `?path=<home>/nope` → 404; `?path=<home>&path=/x` → 400; `?other=1` → 400; 513-char path → 400
  - override service: roots response contains exactly the override root

- [ ] **Step 5: Verify** — `npm run test:runtime` + `npm run typecheck:all` green. (Controller re-runs outside the sandbox — listener binds fail inside Codex.)

- [ ] **Step 6: Commit** — `git commit -m "feat: human-only host routes for project discovery and browsing"`

---

### Task 3: Web client methods + types

**Files:**
- Modify: `src/web/task-board/types.ts` (host types near `CreateProjectInput`)
- Modify: `src/web/task-board/data/client.ts` (two methods + parsers)
- Test: `src/web/task-board/data/client.test.ts` (extend, matching its existing fetch-mock style)

**Interfaces:**
- Produces (Tasks 4–5 depend on):
  in `types.ts`: `HostProjectEntry { name: string; path: string; hasGit: boolean; modifiedAtMs: number }`, `HostProjectRoot { name: string; path: string; projects: HostProjectEntry[]; truncated: boolean }`, `HostDirectoryEntry { name: string; path: string; hasGit: boolean }`, `HostDirectoryListing { path: string; parent: string | null; entries: HostDirectoryEntry[]; truncated: boolean }`;
  on `TaskBoardClient`: `getHostProjectRoots(signal?: AbortSignal): Promise<HostProjectRoot[]>` and `getHostDirectories(path?: string, signal?: AbortSignal): Promise<HostDirectoryListing>`.

- [ ] **Step 1: Failing tests** in `client.test.ts` (follow the file's existing mock-fetch helper): roots call hits `/v1/host/project-roots`, parses a valid envelope, rejects a malformed one (`projects` not an array); directories call with path hits `/v1/host/directories?path=%2Fhome%2Fx`, without path hits bare URL; server error envelope surfaces as the client's existing error type with `code` preserved (mirror how other tests assert error codes).

- [ ] **Step 2: Implement.** In `client.ts`, local parsers using the file's `record`/`string`/`boolean`/`array` helpers plus an inline finite-number check:

```ts
function parseHostProjectEntry(value: unknown, path: string): HostProjectEntry {
  const item = record(value, path);
  const modifiedAtMs = item.modifiedAtMs;
  if (typeof modifiedAtMs !== 'number' || !Number.isFinite(modifiedAtMs)) throw new Error(`${path}.modifiedAtMs must be a finite number`);
  return { name: string(item.name, `${path}.name`), path: string(item.path, `${path}.path`), hasGit: boolean(item.hasGit, `${path}.hasGit`), modifiedAtMs };
}
function parseHostProjectRoot(value: unknown, path: string): HostProjectRoot {
  const item = record(value, path);
  return {
    name: string(item.name, `${path}.name`),
    path: string(item.path, `${path}.path`),
    projects: array(item.projects, `${path}.projects`, parseHostProjectEntry),
    truncated: boolean(item.truncated, `${path}.truncated`),
  };
}
function parseHostDirectoryListing(value: unknown, path: string): HostDirectoryListing {
  const item = record(value, path);
  const parent = item.parent;
  if (parent !== null && typeof parent !== 'string') throw new Error(`${path}.parent must be a string or null`);
  return {
    path: string(item.path, `${path}.path`),
    parent,
    entries: array(item.entries, `${path}.entries`, (entry, entryPath) => {
      const node = record(entry, entryPath);
      return { name: string(node.name, `${entryPath}.name`), path: string(node.path, `${entryPath}.path`), hasGit: boolean(node.hasGit, `${entryPath}.hasGit`) };
    }),
    truncated: boolean(item.truncated, `${path}.truncated`),
  };
}
```

Methods on the returned client object (and the `TaskBoardClient` type):

```ts
async getHostProjectRoots(signal) {
  const envelope = record(await json('/v1/host/project-roots', { signal }), 'host roots response');
  return array(envelope.roots, 'host roots response.roots', parseHostProjectRoot);
},
async getHostDirectories(path, signal) {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
  const envelope = record(await json(`/v1/host/directories${query}`, { signal }), 'host directories response');
  return parseHostDirectoryListing(envelope.listing, 'host directories response.listing');
},
```

- [ ] **Step 3: Verify** — `npm run test:web` + `npm run typecheck:all` green.
- [ ] **Step 4: Commit** — `git commit -m "feat: web client reads host project roots and directories"`

---

### Task 4: Picker model (pure logic)

**Files:**
- Create: `src/web/task-board/model/project-picker.ts`
- Test: `src/web/task-board/model/project-picker.test.ts` (vitest)

**Interfaces:**
- Consumes: `parseProjectMetadata` from `./project-metadata`; `BoardProject`, `HostProjectRoot` from `../types`.
- Produces (Task 5 depends on): `PickerEntry { name; path; hasGit; modifiedAtMs; rootName; added }`, `addedWorkspacePaths(projects: readonly BoardProject[]): Set<string>`, `pickerEntries(roots: readonly HostProjectRoot[], added: ReadonlySet<string>): PickerEntry[]`, `filterPickerEntries(entries: readonly PickerEntry[], query: string): PickerEntry[]`, `breadcrumbSegments(path: string): { label: string; path: string }[]`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { addedWorkspacePaths, breadcrumbSegments, filterPickerEntries, pickerEntries } from './project-picker';
import type { BoardProject, HostProjectRoot } from '../types';

const project = (description: string | null): BoardProject => ({
  id: 'p1', name: 'One', description,
  createdAt: '2026-08-15T00:00:00.000Z', createdAtMs: 0, updatedAt: '2026-08-15T00:00:00.000Z', updatedAtMs: 0,
});
const roots: HostProjectRoot[] = [{
  name: 'WebstormProjects', path: '/home/u/WebstormProjects', truncated: false,
  projects: [
    { name: 'older', path: '/home/u/WebstormProjects/older', hasGit: true, modifiedAtMs: 100 },
    { name: 'newer', path: '/home/u/WebstormProjects/newer', hasGit: false, modifiedAtMs: 200 },
  ],
}];

describe('project picker model', () => {
  it('collects workspace paths from bare-path and keyed descriptions, trailing slash trimmed', () => {
    const added = addedWorkspacePaths([project('/home/u/WebstormProjects/older/'), project('Workspace: /home/u/x'), project(null)]);
    expect(added).toEqual(new Set(['/home/u/WebstormProjects/older', '/home/u/x']));
  });
  it('orders entries most-recently-modified first and marks added', () => {
    const entries = pickerEntries(roots, new Set(['/home/u/WebstormProjects/older']));
    expect(entries.map((entry) => [entry.name, entry.added, entry.rootName])).toEqual([
      ['newer', false, 'WebstormProjects'],
      ['older', true, 'WebstormProjects'],
    ]);
  });
  it('filters case-insensitively on name and returns all for blank', () => {
    const entries = pickerEntries(roots, new Set());
    expect(filterPickerEntries(entries, ' NEW ').map((entry) => entry.name)).toEqual(['newer']);
    expect(filterPickerEntries(entries, '')).toHaveLength(2);
  });
  it('builds cumulative breadcrumbs', () => {
    expect(breadcrumbSegments('/home/u/WebstormProjects')).toEqual([
      { label: 'home', path: '/home' },
      { label: 'u', path: '/home/u' },
      { label: 'WebstormProjects', path: '/home/u/WebstormProjects' },
    ]);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { parseProjectMetadata } from './project-metadata';
import type { BoardProject, HostProjectRoot } from '../types';

export interface PickerEntry {
  name: string;
  path: string;
  hasGit: boolean;
  modifiedAtMs: number;
  rootName: string;
  added: boolean;
}

export function addedWorkspacePaths(projects: readonly BoardProject[]): Set<string> {
  const paths = new Set<string>();
  for (const project of projects) {
    for (const entry of parseProjectMetadata(project.description).entries) {
      if (entry.kind === 'workspace') paths.add(entry.value.replace(/[\\/]+$/u, ''));
    }
  }
  return paths;
}

export function pickerEntries(roots: readonly HostProjectRoot[], added: ReadonlySet<string>): PickerEntry[] {
  return roots.flatMap((root) =>
    [...root.projects]
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name))
      .map((project) => ({ ...project, rootName: root.name, added: added.has(project.path) })),
  );
}

export function filterPickerEntries(entries: readonly PickerEntry[], query: string): PickerEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

export function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts.map((label, index) => ({ label, path: `/${parts.slice(0, index + 1).join('/')}` }));
}
```

- [ ] **Step 3: Verify** — `npm run test:web` green; `npm run typecheck:all`.
- [ ] **Step 4: Commit** — `git commit -m "feat: project picker model"`

---

### Task 5: Picker UI in the Add-project dialog

**Files:**
- Modify: `src/web/task-board/views/CreateDialogs.tsx` (replace `ProjectForm`; add `client` prop to `CreateDialogs`)
- Modify: `src/web/task-board/BoardApp.tsx` (pass `client={client}` at the `<CreateDialogs` call, ~line 467)

**Interfaces:**
- Consumes: Task 3 client methods, Task 4 model functions, existing `Button`/`FieldLabel`/`InlineActionErrors`/`Modal`/`inputClass`, `fieldsAreDirty`, `taskWorkspaceRefs` (keep it — still validates pasted paths client-side before the server check).
- Produces: unchanged `onSubmit({ name, description: path })` contract; dialog copy updates to "Pick a project folder, browse for one, or paste a path."

Behavior contract (the implementer owns the exact JSX; match the file's existing styling/classes):

- On dialog open, `ProjectForm` calls `client.getHostProjectRoots()` (AbortController on unmount). Three outcomes: entries (default **list mode**), empty (open **browse mode** directly), error (browse mode + dismissible inline note "Project discovery is unavailable"; paste still works).
- **List mode:** filter input (labelled "Filter projects"); entries via `pickerEntries(roots, addedWorkspacePaths(snapshot.projects))` + `filterPickerEntries`; grouped visually by `rootName`; each row a button: name, git badge (`hasGit`), disabled with an "Added" tag when `entry.added`. Clicking selects: fills the editable **Name** input (`entry.name`) and a read-only path display; Add submits `{ name: nameField.trim(), description: entry.path }`.
- **Browse mode:** starts at `client.getHostDirectories()` (server defaults to `$HOME`); breadcrumbs from `breadcrumbSegments(listing.path)` (each crumb navigates via `getHostDirectories(crumb.path)`; a 403 shows the inline error and stays put); entry rows navigate deeper; a filter input narrows the current listing by name; "Use this folder" selects `listing.path` (name defaults to last segment, editable); Add submits as above.
- **Paste fallback (both modes):** the existing absolute-path input remains at the bottom. On submit it first calls `client.getHostDirectories(paste)`; success → submit `{ name: last segment, description: paste }` (name editable beforehand via the same Name field); failure maps codes to inline text: `HOST_PATH_NOT_FOUND` → "That folder does not exist", `HOST_PATH_NOT_DIRECTORY` → "That path is a file, not a folder", `HOST_PATH_OUTSIDE_ROOTS` → "That folder is outside the browsable area — you can still add it if the path is correct" with a second "Add anyway" button (outside-roots is a browse restriction, not a validity verdict; the fleet may legitimately use it).
- Dirty tracking: any filter text, selection, name edit, or paste text ⇒ `onDirtyChange(true)`; selection cleared and fields empty ⇒ false. Busy/disabled and `InlineActionErrors` wiring unchanged from the current form.
- Loading and error states must not unmount the paste input — it is the universal fallback.

- [ ] **Step 1: Implement the form + wire `client` prop through `CreateDialogs` and `BoardApp`.**
- [ ] **Step 2: Verify** — `npm run test:web`, `npm run typecheck:all`, `npm run build` all green (no new unit tests here; logic lives in Task 4, flows in Task 6).
- [ ] **Step 3: Commit** — `git commit -m "feat: project picker dialog with discovery, browse, and validated paste"`

---

### Task 6: E2e coverage

**Files:**
- Create: `tests/e2e/project-picker.spec.ts`

**Interfaces:** Consumes the shipped UI only. Mock all board APIs with `page.route('**/board-api/v1/**')` exactly like `tests/e2e/task-board.spec.ts` (no real server FS): minimal `GET /v1/projects` (one existing project whose `description` is `/home/u/WebstormProjects/older` — drives the Added state), empty `/v1/work-items`, board envelope for the project, `GET /v1/host/project-roots` → the Task 4 fixture roots, `GET /v1/host/directories` responses keyed on the `path` query (default → `/home/u` with `WebstormProjects` entry; `/home/u/WebstormProjects` → `older`/`newer`; `/home/u/nope` → 404 envelope `{ error: { code: 'HOST_PATH_NOT_FOUND', message: 'The folder does not exist' } }`), and `POST /v1/projects` capturing the JSON body then returning a created envelope shaped like the existing spec's project responses.

Scenarios (desktop and mobile projects both run; write viewport-agnostic locators):

- [ ] **Step 1: Discovered list.** Open Add project → rows `newer` then `older` under a `WebstormProjects` group; `older` disabled with "Added"; filter `new` hides it; click `newer` → Name input shows `newer`; submit → captured POST body equals `{ name: 'newer', description: '/home/u/WebstormProjects/newer' }`.
- [ ] **Step 2: Browse.** Switch to browse → breadcrumbs end with the mocked home; enter `WebstormProjects`; "Use this folder" → Name defaults to `WebstormProjects`; edit Name to `Everything`; submit → body `{ name: 'Everything', description: '/home/u/WebstormProjects' }`.
- [ ] **Step 3: Paste validation.** Paste `/home/u/nope` → submit → inline "That folder does not exist"; assert no `POST /v1/projects` was captured.
- [ ] **Step 4: Verify** — `npm run test:e2e` green (plus `npm run typecheck:all`, which now typechecks the new spec via the e2e tsconfig).
- [ ] **Step 5: Commit** — `git commit -m "test: e2e coverage for the project picker"`
