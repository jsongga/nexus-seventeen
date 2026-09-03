# Plan: web feature seams (campaign 13)

Spec: `docs/superpowers/specs/2026-09-02-web-feature-seams.md`. Base: `2341bc1`.

Three tasks. Task 1 is the campaign's structural point; tasks 2 and 3 clear the mid-tier files.
Every task is a move — no behaviour may change — so each is verified the same way: declaration
text unchanged, and Playwright green because only the browser proves a moved React tree still
mounts.

| #   | Task                      | Deliverable                                                                                                      | Why here                                                        |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Work-item feature modules | `BoardPage` → routing; six `views/work-item/*.tsx` modules; `BoardApp` helpers extracted; banners on both shells | The two 1,500+ line files, and the seam the next campaign needs |
| 2   | Views split               | `AutomationPage`, `WorkspacePages`, `CreateDialogs`, `WorkspaceSidebar` each under 600                           | Four of the six mid-tier files; all are several things in one   |
| 3   | Data split                | `data/client.ts` and `data/parse.ts` each under 600                                                              | The other two, and the only non-view ones                       |

Not in this campaign: the two component shells (`WorkItemDetail` ~1,169 lines, `BoardApp`
~1,184). They need custom-hook extraction, which decides where state lives — campaign 14, with
its own brainstorming.

## Task 1 — work-item feature modules

**`BoardPage` to routing.** Move the type from `views/WorkspaceSidebar.tsx` to
`routing/routing.ts`; update `routing/useHashRoute.ts`, `routing/routing.test.ts` and the
sidebar itself. Routing defines where you can be; a view should not own that.

**Six modules under `src/web/views/work-item/`**, taking the helpers listed in the spec's seam
table: `plan.tsx`, `evidence.tsx`, `family.tsx`, `approval.tsx`, `observability.tsx`,
`deployment.tsx`. Every one of them is prop-driven — the region above the shell contains a
single hook call — so this cannot change what renders.

**No façade.** The five colocated test files import from the new modules directly. Each keeps
its own name: a test file names a scenario, not a module, and four of the five will import from
several modules. That is correct, not a smell.

**`BoardApp` helpers** move to `src/web/board/`: `NotificationsBlock` and `BoardPauseBanner`
with `pausePopoverShouldClose`, and the routing/selection predicates
(`routedWorkItemSelection`, `snapshotLostSelectedWorkItem`, `workItemDetailReloadPending`,
`WorkItemDetailLoadResult`, the three dialog-trigger types and `resolveDialogTriggerAction`).
Group them by concern, not by "everything above line 367".

**Banner pass on both shells.** `WorkItemDetail.tsx` and `BoardApp.tsx` get
`/* —— Section —— */` banners marking the regions a hooks extraction will cut along — state,
derived values, handlers, effects, render. Campaign 12's split was cheap _because_ campaign 11
had drawn the banners; this is the same favour to campaign 14.

**Exit:** both files under 1,300; six work-item modules each under 400; `Intl`-style
declaration text unchanged for every moved component; Playwright green.

## Task 2 — views split

`AutomationPage.tsx` (924), `WorkspacePages.tsx` (880), `CreateDialogs.tsx` (851),
`WorkspaceSidebar.tsx` (639). Read each before deciding its cuts — `WorkspacePages` and
`CreateDialogs` are plural in their own names and are the obvious first candidates for one file
per page and one per dialog. Colocated tests follow their subjects.

**Exit:** all four under 600, declaration text unchanged, Playwright green.

## Task 3 — data split

`data/client.ts` (1,034) and `data/parse.ts` (717). `client.ts` is the board's HTTP surface and
should divide by resource; `parse.ts` divides by the entity it parses. Watch for the same trap
campaign 12 hit: a shared private core (there, `shape`/`entity`) that would need promoting to
exports in several directions. If either file's core turns out to be that tangled, say so and
split only the other.

**Exit:** both under 600 — or one of them under 600 with the other's tangle documented and
deferred — declaration text unchanged, Playwright green.

## Per task

Gates run outside the sandbox: `typecheck:all`, `test:all`, and **Playwright both projects** —
mandatory here, unlike campaigns 11 and 12, because every task moves React components and only
the browser proves the app still mounts and renders. Claude reviewer and `codex review`
serialized, never concurrent with a gate. Fix rounds cap 5.

Move hazards carried from campaign 11 task 6 and campaign 12: the module-header allowlist and
baseline must move together as a provable pure path rewrite — or better, a moved module earns a
header and the allowlist shrinks; `docs/` carries links into `src/`; and a module leaving a
directory published in `package.json`'s `imports` map can silently downgrade a bare specifier.

**Verification note.** The declaration-identity check that made campaign 12's 5,000-line split
reviewable is in `.superpowers/sdd/2026-08-31-layering/verify-split.mjs`. It compares each
top-level declaration's text between an original and its new homes. Reuse it here rather than
re-deriving the idea — it is what turns "30 components moved" into a one-line claim a reviewer
can check.
