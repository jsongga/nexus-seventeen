# Design Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the whole task board app onto the "Agentic Workspace Overview" design — a light, system-font, mauve-and-sage language — and rebuild `ProjectPage` to that design's layout.

**Architecture:** The app is Tailwind v4 over semantic CSS variables in `styles.css`, so the palette inverts once in the token layer and every view and `ui.tsx` primitive inherits it. That alone is not sufficient: 19 hardcoded `white`/`black` utilities and 7 alpha-over-dark fills live outside the token layer and must be fixed by hand. Tasks are ordered so the app is never left half-inverted: tokens first, primitives second, then ProjectPage, then the remaining views.

**Tech Stack:** Tailwind v4 (`@tailwindcss/vite`), React 19, TypeScript 5.7, Vitest 4, Playwright.

**The design itself** is kept verbatim at
`docs/superpowers/specs/agentic-workspace-design.html`. It is the fidelity
reference for every measurement, colour and label in this plan — read it before
Task 4, and check the built UI against it. It is never imported or served.

## Global Constraints

- **This is a dark → light INVERSION, not a palette tweak.** `styles.css:113` currently sets `:root { color-scheme: dark }` over a near-black canvas. Every contrast pair in the app flips.
- **Do not edit anything under `src/server/`.** `git diff --stat src/server` must be empty in every task.
- **Do not change `src/web/task-board/routing.ts`, `useHashRoute.ts`, or `types.ts`.** Projects A and B are complete and out of scope.
- **Keep the parked logic, do not render it.** `tsconfig.app.json` sets `noUnusedLocals: true`, so unrendered logic left inside a component FAILS THE BUILD. It must move to exported modules the new view does not import.
- Exact palette — canvas `#FFFFFF`, ink `#2A2A28`, secondary text `#7A7A78`, tertiary `#A0A0A0`, border `#EAEAEA`, subtle surface `#F3F3F5`, header `#D6D8CC`, primary/accent `#5F4B51`.
- Status colours — queued `#D1D1D1` on `#4A4A4A`; working `#A2BBE0` on `#2B4570`; review `#F28D50` on `#5A2A0D`; changes `#C45A34` on `#FFFFFF`; merged `#8B9883` on `#1E3314`.
- Type — system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`), base 13px, line-height 1.4. Radii 4px / 6px / 99px pill.
- **The e2e suite queries by role and accessible name.** Pure restyling must not break it. Where a *label* changes ("Merged", "Agent Working"), update `tests/e2e/task-board.spec.ts` in the same task.
- **Never weaken or delete an existing test to make a change pass.** The e2e spec diff should stay additive apart from deliberate label updates.
- Comment dense logic, or wrap it in a well-named util.
- **Commit style:** Conventional Commits, every commit ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/web/styles.css` | *Modify.* The token layer — the single place the palette, type and radii are defined. |
| `index.html` | *Modify.* `theme-color` meta. |
| `src/web/components/ui.tsx` | *Modify.* `Pill` tones and `Button` variants remapped; hardcoded white removed. |
| `src/web/task-board/project-workflow.ts` | *Create.* Parked: workflow fetch/subscribe and `confirmPlan`. |
| `src/web/task-board/project-artifacts.ts` | *Create.* Parked: artifact upload and media-type validation. |
| `src/web/task-board/project-metrics.ts` | *Create.* Parked: completion percent and status grouping. |
| `src/web/task-board/WorkspaceHeader.tsx` | *Create.* Sage header band: eyebrow, title, icon actions. |
| `src/web/task-board/ContextSidebar.tsx` | *Create.* 260px "Context & Materials" column. |
| `src/web/task-board/ThreadPipelineTable.tsx` | *Create.* "Active Thread Pipeline" table. |
| `src/web/task-board/ActivityFeed.tsx` | *Create.* Scrolling "Recent Activity & Visuals" feed with visual previews. |
| `src/web/task-board/WorkspacePages.tsx` | *Modify.* `ProjectPage` rebuilt from the four components above. |

---

### Task 1: Invert the token layer

Palette, type and radii only. No component or JSX changes — this task proves how much the token layer carries on its own, and its review is the honest measure of what is left.

**Files:**
- Modify: `src/web/styles.css` (`:root` at 113-170, the dead `.dark` at 172)
- Modify: `index.html:6`

**Interfaces:**
- Consumes: nothing.
- Produces: the light token set every later task builds on. Token NAMES are unchanged — only their values — so nothing downstream needs renaming.

- [ ] **Step 1: Flip the color-scheme and core surfaces**

In `src/web/styles.css`, in the `:root` block beginning at line 113:

```css
  color-scheme: light;

  --canvas: #FFFFFF;
  --card: #FFFFFF;
  --popover: #FFFFFF;
  --secondary: #F3F3F5;
  --ink-panel: #F3F3F5;
  --foreground: #2A2A28;
  --muted-foreground: #7A7A78;
  --border: #EAEAEA;
  --border-soft: #F1F1F1;
  --border-strong: #D8D8D8;
  --input: #EAEAEA;
  --muted-surface: #F3F3F5;
```

- [ ] **Step 2: Re-derive the scrim**

`--scrim` is currently `#050604`, a near-black modal overlay chosen for a dark canvas. On white it must become a translucent dark veil, or modals will look correct only by accident:

```css
  --scrim: rgba(42, 42, 40, 0.45);
```

- [ ] **Step 3: Re-derive every alpha-over-dark fill**

These seven are `rgba(...)` at 0.14–0.2 alpha, tuned to sit on `#0e0f0a`. On white they read as almost nothing. Raise the alpha and re-hue each to its new status colour:

```css
  --success-soft: rgba(139, 152, 131, 0.22);   /* merged  #8B9883 */
  --teal-soft:    rgba(139, 152, 131, 0.22);
  --accent:       rgba(139, 152, 131, 0.22);
  --caution-soft: rgba(242, 141, 80, 0.22);    /* review  #F28D50 */
  --urgent-soft:  rgba(196, 90, 52, 0.20);     /* changes #C45A34 */
  --info-soft:    rgba(162, 187, 224, 0.30);   /* working #A2BBE0 */
  --alt-soft:     rgba(209, 209, 209, 0.40);   /* queued  #D1D1D1 */
```

- [ ] **Step 4: Remap the accent, status text and border tokens**

```css
  --active: #5F4B51;
  --active-hover: #4C3C41;
  --ring: #5F4B51;

  --success-text: #1E3314;   --success-fill: #8B9883;
  --caution-text: #5A2A0D;   --caution-fill: #F28D50;   --caution-border: #F28D50;
  --urgent-text:  #C45A34;   --urgent-fill:  #C45A34;   --urgent-border: #C45A34;
  --info-text:    #2B4570;   --info-border:  #A2BBE0;
  --alt-text:     #4A4A4A;   --alt-border:   #D1D1D1;

  --teal-300: #8B9883;  --teal-500: #5F4B51;
  --teal-600: #4C3C41;  --teal-700: #2A2A28;
  --teal-border: #EAEAEA;
```

Add the new header token alongside them:

```css
  --header: #D6D8CC;
```

and expose it in the `@theme` alias block near the other `--color-*` entries:

```css
  --color-header: var(--header);
```

- [ ] **Step 5: Swap the type scale and radii**

In the same `@theme` block that defines `--font-sans` (around line 12):

```css
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;

  --radius: 6px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 6px;
  --radius-xl: 6px;
  --radius-2xl: 6px;
  --radius-3xl: 99px;
```

Set the base size on `body` (the design specifies 13px / 1.4):

```css
body {
  font-size: 13px;
  line-height: 1.4;
}
```

Leave the `@fontsource` imports in `src/web/main.tsx` alone for now — Task 5 removes them once nothing references Manrope or DM Mono. Removing them here would leave the intermediate commits unstyled.

- [ ] **Step 6: Delete the dead `.dark` block**

`styles.css:172` defines `.dark { color-scheme: dark }`. Nothing in `src/web` or `index.html` ever applies that class — verify with `grep -rn "className=\"dark\|'dark'" src/web/ index.html`, then delete the block.

- [ ] **Step 7: Correct the stale theme-color**

`index.html:6` declares `#eae9e4`, a light colour that was already inconsistent with the dark theme:

```html
<meta name="theme-color" content="#D6D8CC" />
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run test:web`
Expected: PASS, unchanged counts. CSS changes cannot affect these; if anything fails, something non-CSS was touched.

Run: `npm run build:web`
Expected: PASS.

Run: `npm run test:e2e`
Expected: PASS. The suite queries by role and accessible name, so a pure token change must not affect it. **A failure here means a token was renamed rather than revalued — fix it rather than editing the test.**

- [ ] **Step 9: Look at it**

Run: `npm run dev -- --host 0.0.0.0`

Open `http://100.72.64.97:4173/` and confirm the app is light and legible. Expect stragglers — hardcoded white text and fills that Task 2 fixes. Note which screens look wrong; that list is Task 2's input. Do not fix them here.

- [ ] **Step 10: Commit**

```bash
git add src/web/styles.css index.html
git commit -m "feat: invert the token layer to the light workspace palette

Flips color-scheme to light and revalues canvas, ink, borders and
surfaces. Re-derives the seven alpha fills that were tuned to sit on a
near-black canvas and would otherwise be invisible, and replaces the
near-black modal scrim with a translucent dark veil.

Token names are unchanged, so every view and ui.tsx primitive inherits
the new palette. Also deletes the .dark block, which was never applied,
and corrects a theme-color that was already inconsistent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Restyle the primitives and fix every hardcoded colour

The token layer cannot reach two things: literal `white`/`black` Tailwind utilities, and the tone maps in `ui.tsx`. There are **19** hardcoded usages across 5 files, and they are exactly where a dark→light inversion breaks.

**Files:**
- Modify: `src/web/components/ui.tsx` (`pillTones`, `buttonVariants`, and 5 hardcoded usages)
- Modify: `src/web/task-board/WorkspaceSidebar.tsx` (4), `DocumentsPage.tsx` (3), `WorkspacePages.tsx` (2), `BoardApp.tsx` (2)
- Modify: `tests/e2e/task-board.spec.ts` only if a visible label changes

**Interfaces:**
- Consumes: Task 1's tokens, including the new `--color-header`.
- Produces: `pillTones` keys unchanged (`neutral | green | amber | red | blue | purple | dark`) so no call site changes; `buttonVariants` keys unchanged (`primary | secondary | quiet | danger | mint`).

- [ ] **Step 1: Find every hardcoded colour**

Run:

```bash
grep -rnoE "(bg|text|border|ring|from|to|via)-(white|black)(/[0-9]+)?" src/web/
```

Expected: 19 matches across `ui.tsx` (5), `WorkspaceSidebar.tsx` (4), `DocumentsPage.tsx` (3), `WorkspacePages.tsx` (2), `BoardApp.tsx` (2), plus the `pillTones.dark` entries. Record the list; every one must be resolved in this task.

- [ ] **Step 2: Fix the tone that is guaranteed broken**

`pillTones.dark` is currently `'border-white/15 bg-white/10 text-white/85'` — white alpha over a dark surface. On a white canvas it is invisible. Replace the whole map, mapping each existing tone onto the new status palette so no call site changes:

```ts
const pillTones = {
  neutral: 'border-line bg-surface text-muted',
  green: 'border-success-fill/60 bg-success-soft text-success',   // merged
  amber: 'border-caution-border bg-caution-soft text-caution',    // awaiting review
  red: 'border-urgent-border bg-urgent text-white',               // changes requested
  blue: 'border-info-border bg-info-soft text-info',              // agent working
  purple: 'border-alt-border bg-alt-soft text-alt',               // queued
  dark: 'border-line-strong bg-ink-panel text-ink',
};
```

Note `red` deliberately uses solid `bg-urgent` with white text: the design's "Changes Requested" is the one status rendered as a solid fill (`#C45A34` on `#FFFFFF`), not a soft tint.

- [ ] **Step 3: Repoint the button variants**

`primary` currently renders `text-white` on `bg-taupe`. With `--active` now `#5F4B51`, white text stays correct — keep it. Confirm each variant reads correctly on white and adjust only what does not:

```ts
const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'border-taupe bg-taupe text-white enabled:hover:border-taupe-hover enabled:hover:bg-taupe-hover',
  secondary:
    'border-line bg-surface text-ink enabled:hover:border-line-strong enabled:hover:bg-muted-surface',
  quiet: 'border-transparent bg-transparent text-ink enabled:hover:bg-surface',
  danger: 'border-urgent-border bg-canvas text-urgent enabled:hover:bg-urgent-soft',
  mint: 'border-success-fill/60 bg-success-soft text-success enabled:hover:bg-surface',
};
```

The design's buttons are pill-shaped (`--radius-pill: 99px`). Update `buttonSizes` so the radius is `rounded-[99px]`, matching `.btn` in the design.

- [ ] **Step 4: Resolve the remaining hardcoded usages one by one**

For each of the remaining matches from Step 1, decide deliberately — do not blanket-replace:

- `text-white` sitting on a **solid accent or status fill** (buttons, solid pills) is CORRECT on light and stays.
- `bg-white` that was a deliberate light surface on a dark canvas is now indistinguishable from the page. Replace with `bg-canvas` where it should be the page colour, or `bg-surface` where it should read as a raised panel.
- `bg-white/95` is an overlay backdrop — replace with `bg-canvas/95`.
- Any `white`/`black` alpha used for elevation or separators becomes a `--border`/`--muted-surface` token.

Record in the commit message which ones you kept and why.

- [ ] **Step 5: Verify nothing hardcoded remains unaccounted for**

Run the Step 1 grep again. Every remaining match must be a `text-white` on a solid fill. If any other kind survives, it was missed.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run test:web`
Expected: PASS, unchanged counts.

Run: `npm run test:e2e`
Expected: PASS. If a spec fails on an accessible name you deliberately changed, update that spec in this task. If it fails for any other reason, the change is wrong.

Run: `npm run build:web`
Expected: PASS.

- [ ] **Step 7: Look at it**

Run: `npm run dev -- --host 0.0.0.0` and open `http://100.72.64.97:4173/`.

Walk all four views — task list, a project, an agent, documents, automation — and confirm every control is legible with no invisible text or vanished surfaces. Open a modal and confirm the scrim reads correctly. This is the task where the inversion is either finished or not.

- [ ] **Step 8: Commit**

```bash
git add src/web/components/ui.tsx src/web/task-board/ tests/e2e/task-board.spec.ts
git commit -m "feat: restyle primitives for the light palette

Remaps Pill tones onto the new status colours and makes the changes-
requested tone a solid fill, matching the design. Buttons become pill-
shaped. Resolves the hardcoded white utilities that sat outside the token
layer -- notably the dark pill tone, which was white alpha over a dark
surface and would have been invisible on white.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Extract the parked ProjectPage logic

Per the agreed direction the logic is KEPT but no longer rendered. `noUnusedLocals: true` means it cannot simply be left in the component — it must move out. Doing this before the rebuild also leaves Task 4 a much smaller component to work in.

**Files:**
- Create: `src/web/task-board/project-workflow.ts`, `project-artifacts.ts`, `project-metrics.ts`
- Create: `src/web/task-board/project-metrics.test.ts`
- Modify: `src/web/task-board/WorkspacePages.tsx`

**Interfaces:**
- Consumes: `TaskBoardClient` from `./client`; `BoardSnapshot`, `BoardProject`, `ProjectWorkflow`, `ProjectArtifact` from `./types`.
- Produces:
  - `project-workflow.ts` — `fetchProjectWorkflow(client, projectId, signal): Promise<ProjectWorkflow | null>`, `confirmPlan(client, planRevisionId): Promise<ProjectWorkflow>`, `proposedPlans(workflow: ProjectWorkflow | null): PlanRevision[]`
  - `project-artifacts.ts` — `artifactMediaType(fileName: string, fileType: string): string | null`, `uploadArtifact(client, projectId, file): Promise<ProjectArtifact>`
  - `project-metrics.ts` — `projectTaskGroups(snapshot, projectId): Array<{ label: string; tasks: BoardTask[] }>`, `completionPercent(tasks: BoardTask[]): number`

- [ ] **Step 1: Write the failing test**

Create `src/web/task-board/project-metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { completionPercent } from './project-metrics';

describe('completionPercent', () => {
  it('is zero when there are no tasks, rather than dividing by zero', () => {
    expect(completionPercent([])).toBe(0);
  });

  it('rounds to the nearest whole percent', () => {
    const tasks = [
      { status: 'completed' }, { status: 'completed' }, { status: 'running' },
    ] as Parameters<typeof completionPercent>[0];
    expect(completionPercent(tasks)).toBe(67);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/task-board/project-metrics.test.ts`
Expected: FAIL — cannot resolve `./project-metrics`.

- [ ] **Step 3: Move the logic out verbatim**

Move the bodies out of `ProjectPage` in `WorkspacePages.tsx` into the three modules, matching the signatures in **Interfaces** above. This is a MOVE — do not change behaviour, only the wrapping.

Head each file with a comment saying why it exists, for example in `project-workflow.ts`:

```ts
/**
 * Project workflow reads and plan confirmation.
 *
 * Deliberately not rendered by the current ProjectPage design, which shows the
 * documents, pipeline and activity regions only. Kept exported and tested so the
 * behaviour survives and can be re-surfaced without being rebuilt.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/task-board/project-metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the app is unchanged**

Run: `npm run typecheck && npm run test:web && npm run test:e2e`
Expected: ALL PASS. This task is a pure refactor — `ProjectPage` still renders exactly what it did, just importing the logic instead of inlining it. Any e2e failure means behaviour moved.

- [ ] **Step 6: Commit**

```bash
git add src/web/task-board/project-workflow.ts src/web/task-board/project-artifacts.ts src/web/task-board/project-metrics.ts src/web/task-board/project-metrics.test.ts src/web/task-board/WorkspacePages.tsx
git commit -m "refactor: extract project workflow, artifact and metric logic

Moves plan confirmation, artifact upload and delivery metrics out of
ProjectPage into exported, tested modules ahead of the redesign, which
does not render them. noUnusedLocals means unrendered logic left in the
component would fail the build, so extraction is what keeps it.

Pure move; no behaviour change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rebuild ProjectPage to the workspace layout

**Files:**
- Create: `src/web/task-board/WorkspaceHeader.tsx`, `ContextSidebar.tsx`, `ThreadPipelineTable.tsx`, `ActivityFeed.tsx`
- Modify: `src/web/task-board/WorkspacePages.tsx` (`ProjectPage`)
- Modify: `tests/e2e/task-board.spec.ts`

**Interfaces:**
- Consumes: Task 1 tokens, Task 2 primitives, Task 3's modules (imported by NONE of the new components — that is the point).
- Produces: four components, each taking plain data props and no client:
  - `WorkspaceHeader({ eyebrow, title, actions })`
  - `ContextSidebar({ intro, documents, onSelectDocument })`
  - `ThreadPipelineTable({ tasks, agentById, onTask })`
  - `ActivityFeed({ updates, artifactUrls, onOpenArtifact })`

- [ ] **Step 1: Build the layout shell**

Three regions per the design: a `--color-header` band with a 11px eyebrow above a 28px, weight-400, `-0.5px` title and pill icon-buttons on the right; below it a flex row of a 260px sidebar with a 1px right border, and a flex-1 core column.

The core column and the feed inside it must own their scrolling — `min-height: 0` on the flex child, `overflow-y: auto` on the feed — so the page itself never scrolls horizontally.

- [ ] **Step 2: Build the pipeline table**

Columns and widths exactly as the design: Task Objective 40%, Assigned Agent 20%, Stage 25%, Updated 15%. Header cells 11px weight-500 in secondary text with a 1px bottom border; body cells 13px with a 1px bottom border, none on the last row. The objective cell renders as the design's inset control — `bg-subtle`, 6px radius, 6px/10px padding.

Stage renders a `Pill`. Map the board's task status onto the design's five labels, and put the map in a named util rather than inline ternaries:

| Board status | Label | `Pill` tone |
|---|---|---|
| `queued`, `backlog`, `proposed` | Queued | `purple` |
| `running` | Agent Working | `blue` |
| `waiting_for_human` | Awaiting Review | `amber` |
| `blocked`, `failed` | Changes Requested | `red` |
| `completed` | Merged | `green` |

These labels are new accessible names, so update any e2e spec that asserts the old ones in this task.

- [ ] **Step 3: Build the sidebar and feed**

Sidebar: an underlined "Context & Materials" heading (2px bottom border, inline-block), a 12px secondary-text intro paragraph, then an "Important Documents" list where each row is a 14px square icon placeholder beside a title and an 11px tertiary meta line.

Feed: an 80px/1fr grid per item — 11px secondary timestamp, then the update text with the agent name in weight-600 `--color-taupe`. Where an update has an artifact, render a `VisualPreview` — a `bg-subtle` bordered box, focusable, with `aria-label`. Artifacts already resolve to object URLs in `ProjectPage`; reuse that, do not refetch.

- [ ] **Step 4: Wire the two actions**

The design's footer has "Pause Agents" and "Compile Report", bottom-right,
`.btn-secondary` and `.btn-primary`.

- **Pause Agents** → the existing `interruptRun` on `TaskBoardClient`. Call it
  for the project's active runs. Disable it when there are none, and when
  disconnected.
- **Compile Report** → **there is no backing API.** Render it `disabled` with a
  `title` explaining it is not implemented yet, and leave a one-line comment
  saying the endpoint does not exist. **Do not invent an endpoint, and do not
  wire it to something adjacent that happens to return data.** A button that
  looks like it works and does something else is worse than one that is visibly
  disabled.

- [ ] **Step 5: Wire ProjectPage to the new components**

`ProjectPage` keeps its data loading and passes plain props down. It must NOT import `project-workflow.ts`, `project-artifacts.ts`, or `project-metrics.ts` — those are parked.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run test:web`
Expected: PASS.

Run: `npm run test:e2e`
Expected: PASS. Specs asserting the old ProjectPage's "Delivery overview" or "Execution map" now describe removed UI — update those specs to the new structure in this task, and say in the commit which you changed and why. Do not delete a spec to make it pass; rewrite it against the new layout so the coverage survives.

Run: `npm run build:web`
Expected: PASS.

- [ ] **Step 7: Compare against the design**

Run `npm run dev -- --host 0.0.0.0`, open `http://100.72.64.97:4173/` on a project, and check against the design: sage header, 260px bordered sidebar, four-column table with inset objective cells and status pills, scrolling feed with preview boxes, and the two actions bottom-right.

Confirm at a narrow viewport that the page does not scroll horizontally.

- [ ] **Step 8: Commit**

```bash
git add src/web/task-board/ tests/e2e/task-board.spec.ts
git commit -m "feat: rebuild ProjectPage as the agentic workspace view

Splits the view into WorkspaceHeader, ContextSidebar,
ThreadPipelineTable and ActivityFeed, matching the design's header band,
260px context column, four-column pipeline and scrolling activity feed.

Delivery metrics, the execution map, plan confirmation and artifact
upload are no longer rendered; their logic remains in the modules
extracted earlier.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Sweep the remaining views and drop the old fonts

**Files:**
- Modify: `src/web/task-board/BoardApp.tsx`, `WorkspaceSidebar.tsx`, `DocumentsPage.tsx`, `AutomationPage.tsx`
- Modify: `src/web/main.tsx`, `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing new.

- [ ] **Step 1: Walk every view and list what still looks wrong**

Run `npm run dev -- --host 0.0.0.0` and go through the task list, documents and automation views at both a desktop and a narrow viewport. Write the list down before changing anything — the token layer and Task 2 should have carried most of it, and the remainder should be small and specific.

- [ ] **Step 2: Fix them**

Prefer a token over a one-off value. If the same fix is needed in two views, it belongs in `ui.tsx` or the token layer instead.

- [ ] **Step 3: Confirm the old fonts are unreferenced, then drop them**

Run: `grep -rn "Manrope\|DM Mono\|fontsource" src/ index.html`
Expected: only the three `@fontsource` imports at the top of `src/web/main.tsx`.

Delete those three import lines, then remove `@fontsource-variable/manrope` and `@fontsource/dm-mono` from `package.json` dependencies and run `npm install` to update the lockfile.

If the grep finds any other reference, fix it first — dropping the packages while something still names them would break the build.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run test:web && npm run test:e2e && npm run build:web`
Expected: ALL PASS.

Confirm in the build output that the Manrope and DM Mono woff/woff2 assets are no longer emitted — that is the proof the fonts are genuinely gone rather than merely unreferenced in source.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: finish the light adoption across the remaining views

Sweeps the task list, documents and automation views, and drops the
Manrope and DM Mono packages now that the system font stack is used
throughout.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done When

- All four views render in the light workspace language, with no invisible text, vanished surfaces, or mis-toned status pills.
- `ProjectPage` matches the design's three regions and four-column pipeline.
- The parked logic still exists, still has tests, and is imported by nothing in the rendered tree.
- No `white`/`black` Tailwind utility remains except `text-white` on a solid fill.
- `npm run typecheck`, `test:web`, `test:e2e`, `build:web` all pass, and the Manrope/DM Mono assets are gone from the build.
- `git diff --stat src/server` is empty, and `routing.ts`, `useHashRoute.ts` and `types.ts` are unchanged.

## Deliberately out of scope

- Mobile Back not exiting a full-screen task detail or drawer (recorded in the spec as a Project B gap).
- Giving the task detail its own URL.
- Any dark theme or theme toggle — the design is specified light-only.
