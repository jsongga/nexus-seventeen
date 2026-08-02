# Hash Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every view in the task board a real URL, so refresh, deep links, and the browser back button work.

**Architecture:** `BoardPage` (`WorkspaceSidebar.tsx:13`) is already an exhaustive discriminated union with working dispatch — only the URL binding is missing, so no router library is added. A new pure module `routing.ts` converts `BoardPage` ⇄ hash string. `BoardApp` then gets one effect writing `page → location.hash` and one `popstate` listener reading it back. Because the write is driven by the `page` state itself, every existing `setPage` call site syncs automatically without being touched.

**Tech Stack:** React 19, TypeScript 5.7, Vitest 4 (unit), Playwright (e2e).

## Global Constraints

- **Do not add a routing library.** `BoardPage` dispatch is correct and stays; this plan only binds it to the URL.
- **Do not edit anything under `src/server/`.** `git diff --stat src/server` must be empty.
- **Do not change `src/web/task-board/types.ts`.**
- **Do not change the shape of `BoardPage`.** Adding, removing, or renaming a member is out of scope.
- Hash format is exactly: `#/tasks`, `#/automation`, `#/documents`, `#/documents/<id>`, `#/project/<id>`, `#/agent/<id>`.
- **IDs must be percent-encoded.** `identifierPattern` in `parse.ts` is `/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u` — it permits `/`, `:` and `@`, so an id like `acme/web` would break naive path splitting. Use `encodeURIComponent` when writing and `decodeURIComponent` when reading.
- **Unrecognized, malformed, or absent hashes fall back to `{ kind: 'tasks' }`.** Never throw from routing code — a bad URL must not white-screen the app.
- Comment dense logic, or wrap it in a well-named util where a name removes the need for prose.
- **Commit style:** Conventional Commits, every commit ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/web/task-board/routing.ts` | *Create.* Pure `BoardPage` ⇄ hash conversion. No React, no DOM. |
| `src/web/task-board/routing.test.ts` | *Create.* Round-trip and malformed-input coverage. |
| `src/web/task-board/BoardApp.tsx` | *Modify.* Two effects binding `page` state to `location.hash`. |
| `tests/e2e/task-board.spec.ts` | *Modify.* Deep-link and back-button cases. |

`routing.ts` is deliberately DOM-free so it is testable without a browser environment (`vitest.config.ts` sets `environment: 'node'`).

**Deviation from the spec.** The spec listed a third export, `useHashRoute()`. It
is dropped: the hook would need `page` and `setPage` passed in from `BoardApp`
and would wrap two short effects, so it adds indirection without removing
anything. The testable logic lives in the pure functions, which is where the
value was.

---

### Task 1: Pure hash ⇄ page conversion

**Files:**
- Create: `src/web/task-board/routing.ts`
- Test: `src/web/task-board/routing.test.ts`

**Interfaces:**
- Consumes: `BoardPage` from `./WorkspaceSidebar`.
- Produces: `pageToHash(page: BoardPage): string` and `hashToPage(hash: string): BoardPage`.

- [ ] **Step 1: Write the failing test**

Create `src/web/task-board/routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BoardPage } from './WorkspaceSidebar';
import { hashToPage, pageToHash } from './routing';

const pages: BoardPage[] = [
  { kind: 'tasks' },
  { kind: 'automation' },
  { kind: 'documents' },
  { kind: 'documents', documentId: 'doc-1' },
  { kind: 'project', projectId: 'project-1' },
  { kind: 'agent', agentId: 'agent-1' },
];

describe('pageToHash', () => {
  it('writes the documented form for every page kind', () => {
    expect(pageToHash({ kind: 'tasks' })).toBe('#/tasks');
    expect(pageToHash({ kind: 'automation' })).toBe('#/automation');
    expect(pageToHash({ kind: 'documents' })).toBe('#/documents');
    expect(pageToHash({ kind: 'documents', documentId: 'doc-1' })).toBe('#/documents/doc-1');
    expect(pageToHash({ kind: 'project', projectId: 'project-1' })).toBe('#/project/project-1');
    expect(pageToHash({ kind: 'agent', agentId: 'agent-1' })).toBe('#/agent/agent-1');
  });

  it('encodes ids that contain characters the identifier pattern allows', () => {
    // identifierPattern permits '/', ':' and '@', which would otherwise be read
    // as path structure.
    expect(pageToHash({ kind: 'project', projectId: 'acme/web' })).toBe('#/project/acme%2Fweb');
    expect(pageToHash({ kind: 'agent', agentId: 'bot@host' })).toBe('#/agent/bot%40host');
  });
});

describe('hashToPage', () => {
  it('round-trips every page kind', () => {
    for (const page of pages) {
      expect(hashToPage(pageToHash(page))).toEqual(page);
    }
  });

  it('round-trips ids containing reserved characters', () => {
    const page: BoardPage = { kind: 'project', projectId: 'acme/web' };
    expect(hashToPage(pageToHash(page))).toEqual(page);
  });

  it('falls back to tasks for anything it does not recognise', () => {
    expect(hashToPage('')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/nonsense')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/project')).toEqual({ kind: 'tasks' });   // id required
    expect(hashToPage('#/agent')).toEqual({ kind: 'tasks' });     // id required
    expect(hashToPage('#/project/')).toEqual({ kind: 'tasks' });  // empty id
    expect(hashToPage('not-a-hash')).toEqual({ kind: 'tasks' });
  });

  it('never throws on malformed percent-encoding', () => {
    // decodeURIComponent('%') throws URIError; routing must absorb it.
    expect(() => hashToPage('#/project/%')).not.toThrow();
    expect(hashToPage('#/project/%')).toEqual({ kind: 'tasks' });
  });

  it('accepts a hash with no leading marker', () => {
    expect(hashToPage('/tasks')).toEqual({ kind: 'tasks' });
    expect(hashToPage('/agent/agent-1')).toEqual({ kind: 'agent', agentId: 'agent-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/task-board/routing.test.ts`
Expected: FAIL — cannot resolve `./routing`.

- [ ] **Step 3: Write the implementation**

Create `src/web/task-board/routing.ts`:

```ts
import type { BoardPage } from './WorkspaceSidebar';

/**
 * BoardPage <-> URL hash conversion.
 *
 * Kept free of React and DOM access so it can be unit tested under the node
 * test environment, and so the rules live in one readable place.
 *
 * Ids are percent-encoded because the board's identifier pattern permits '/',
 * ':' and '@' — an id like "acme/web" would otherwise be indistinguishable
 * from extra path segments.
 */

const tasksPage: BoardPage = { kind: 'tasks' };

/** Strips the leading '#' and/or '/' so both '#/agent/x' and '/agent/x' parse. */
function hashSegments(hash: string): string[] {
  const withoutMarker = hash.startsWith('#') ? hash.slice(1) : hash;
  const withoutLeadingSlash = withoutMarker.startsWith('/') ? withoutMarker.slice(1) : withoutMarker;
  return withoutLeadingSlash.split('/');
}

/** decodeURIComponent throws on malformed input such as a bare '%'. */
function decodeId(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function pageToHash(page: BoardPage): string {
  switch (page.kind) {
    case 'tasks':
      return '#/tasks';
    case 'automation':
      return '#/automation';
    case 'documents':
      return page.documentId ? `#/documents/${encodeURIComponent(page.documentId)}` : '#/documents';
    case 'project':
      return `#/project/${encodeURIComponent(page.projectId)}`;
    case 'agent':
      return `#/agent/${encodeURIComponent(page.agentId)}`;
  }
}

export function hashToPage(hash: string): BoardPage {
  const [kind, rawId] = hashSegments(hash);
  const id = decodeId(rawId);
  switch (kind) {
    case 'tasks':
      return tasksPage;
    case 'automation':
      return { kind: 'automation' };
    case 'documents':
      return id ? { kind: 'documents', documentId: id } : { kind: 'documents' };
    case 'project':
      // A project or agent page without an id cannot render, so fall back
      // rather than producing a page that would immediately blank out.
      return id ? { kind: 'project', projectId: id } : tasksPage;
    case 'agent':
      return id ? { kind: 'agent', agentId: id } : tasksPage;
    default:
      return tasksPage;
  }
}
```

Note `pageToHash`'s `switch` has no `default`: `BoardPage` is exhaustive, so a new
member becomes a compile error here rather than silently producing no hash.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/task-board/routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full web suite and typecheck**

Run: `npm run typecheck && npm run test:web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/task-board/routing.ts src/web/task-board/routing.test.ts
git commit -m "feat: add pure BoardPage hash conversion

Converts the existing BoardPage union to and from a URL hash, with
percent-encoded ids because the identifier pattern permits '/', ':' and
'@'. Unrecognised or malformed hashes fall back to the tasks page rather
than throwing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Bind the page state to the URL

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx` (page state ~line 640, the reset at ~line 693)
- Modify: `tests/e2e/task-board.spec.ts`

**Interfaces:**
- Consumes: `pageToHash(page: BoardPage): string`, `hashToPage(hash: string): BoardPage` from `./routing`.
- Produces: nothing consumed by later tasks.

**The two traps in this task.** Read before writing code:

1. **The effect whose dependency array is `[refresh]` (around line 709) calls
   `setPage({ kind: 'tasks' })` at ~line 693, and it runs ON MOUNT.** Its purpose
   is to clear state when the connection changes. If you only initialise `page`
   from the hash in `useState`, this effect immediately overwrites a deep link
   with the tasks page. The fix is to make that reset read the URL instead of
   hardcoding the page — correct for both mount and reconnect, since the URL is
   the source of truth.
2. **`setPage` is called from several places, including a functional update at
   ~line 672** that bounces you back to `tasks` when the project/agent/document
   in the URL is missing from a fresh snapshot. Do NOT edit those call sites. The
   hash is written by an effect that watches the `page` VALUE, so every call site
   — including that fallback — syncs for free.

- [ ] **Step 1: Write the failing e2e tests**

Add to `tests/e2e/task-board.spec.ts`:

```ts
test('a project deep link survives a reload and the back button returns to it', async ({ page }) => {
  await page.goto('/');
  const companyRail = page.getByRole('navigation', { name: 'Projects and agents' });
  await companyRail.getByRole('button').first().click();

  // Navigating updates the URL.
  await expect(page).toHaveURL(/#\/(project|agent)\//u);
  const deepLink = page.url();

  // The URL alone restores the same view.
  await page.reload();
  await expect(page).toHaveURL(deepLink);

  // Going elsewhere and back returns to it.
  await page.getByRole('button', { name: 'Task List' }).click();
  await expect(page).toHaveURL(/#\/tasks$/u);
  await page.goBack();
  await expect(page).toHaveURL(deepLink);
});

test('an unknown hash falls back to the task list instead of blanking the page', async ({ page }) => {
  await page.goto('/#/nonsense/value');
  await expect(page.getByRole('button', { name: 'Task List' })).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e tests to verify they fail**

Run: `npx playwright test tests/e2e/task-board.spec.ts -g "deep link"`
Expected: FAIL — the URL stays at `/` because nothing writes the hash yet.

- [ ] **Step 3: Initialise page state from the URL**

In `src/web/task-board/BoardApp.tsx`, add the import:

```ts
import { hashToPage, pageToHash } from './routing';
```

Change the page state initialiser (around line 640) from:

```ts
const [page, setPage] = useState<BoardPage>({ kind: 'tasks' });
```

to:

```ts
// Lazy initialiser: the URL is the source of truth on first render.
const [page, setPage] = useState<BoardPage>(() => hashToPage(window.location.hash));
```

- [ ] **Step 4: Stop the connection effect from discarding the URL**

Still in `BoardApp.tsx`, in the effect whose dependency array is `[refresh]`,
change the reset (around line 693) from:

```ts
setPage({ kind: 'tasks' });
```

to:

```ts
// Reconnecting clears transient state, but the URL still says which page the
// human asked for — including on the initial mount, where this effect would
// otherwise discard a deep link.
setPage(hashToPage(window.location.hash));
```

Leave every other `setPage` call unchanged.

- [ ] **Step 5: Add the two sync effects**

In `BoardApp.tsx`, after the page state declaration, add:

```ts
// page -> URL. Watching the value means every setPage call site syncs without
// being touched, including the snapshot reconciliation that falls back to the
// tasks page when a project or agent disappears.
const urlInitialised = useRef(false);
useEffect(() => {
  const next = pageToHash(page);
  const isFirstRun = !urlInitialised.current;
  // Mark before the early return below. On a deep link the hash already matches,
  // so an early return that skipped this would leave the flag false and make the
  // NEXT navigation replace the deep-link entry instead of pushing past it.
  urlInitialised.current = true;
  if (window.location.hash === next) return;
  // The first write only normalises the address bar (e.g. "/" -> "#/tasks"), so
  // it must REPLACE. Pushing would leave a history entry whose back press
  // re-renders the same view, which reads as a broken back button.
  if (isFirstRun) window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
}, [page]);

// URL -> page, for the browser back and forward buttons.
useEffect(() => {
  const onPopState = () => setPage(hashToPage(window.location.hash));
  window.addEventListener('popstate', onPopState);
  return () => window.removeEventListener('popstate', onPopState);
}, []);
```

The `!==` guard is what stops the two effects from driving each other: when
`popstate` sets the page, the write effect computes the hash already in the bar
and does nothing.

- [ ] **Step 6: Run the e2e tests to verify they pass**

Run: `npx playwright test tests/e2e/task-board.spec.ts -g "deep link"`
Expected: PASS.

Run: `npx playwright test tests/e2e/task-board.spec.ts -g "unknown hash"`
Expected: PASS.

- [ ] **Step 7: Run every suite**

Run: `npm run typecheck && npm run test:web`
Expected: PASS.

Run: `npm run test:e2e`
Expected: PASS — all pre-existing specs plus the two new ones. Every existing
spec calls `page.goto('/')` and navigates by clicking, so they must be
unaffected. If any pre-existing spec now fails, the sync effects are fighting
each other or the mount reset is still discarding state — fix before committing.

Run: `npm run build:web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/task-board/BoardApp.tsx tests/e2e/task-board.spec.ts
git commit -m "feat: bind board navigation to the URL hash

Initialises page state from the URL, writes the hash whenever the page
value changes, and listens for popstate so back and forward work. Because
the write effect watches the page value, existing setPage call sites --
including the snapshot fallback -- sync without modification.

The connection effect now resets to the URL's page rather than hardcoding
the task list, which previously discarded deep links on mount.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done When

- Every `BoardPage` kind has a URL, and reload restores it.
- Browser back and forward move between visited views.
- An unknown, malformed, or absent hash lands on the task list without throwing.
- `npm run typecheck`, `npm run test:web`, `npm run test:e2e`, `npm run build:web` all pass.
- `git diff --stat src/server` is empty and `BoardPage`'s shape is unchanged.
