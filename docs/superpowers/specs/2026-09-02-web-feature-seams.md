# Web feature seams (campaign 13)

**Status** Draft · **Author** Claude (controller) · **Date** 2026-09-02 · **Scope**
`src/web` file size and module ownership.

Supersedes the campaign 13 sketch in
`docs/superpowers/specs/2026-08-29-codebase-health-audit.md`, whose first item —
flattening `src/web/task-board/*` — shipped in campaign 11.

## Summary

`src/web` is 14,662 lines of non-test source. Eight files are over 600 lines, and two of them
are over 1,500:

| File                         | Lines | Shape                                                             |
| ---------------------------- | ----: | ----------------------------------------------------------------- |
| `views/WorkItemDetail.tsx`   | 2,544 | 27 prop-driven helper components, then a **1,169-line** component |
| `BoardApp.tsx`               | 1,551 | 7 helpers and types, then a **1,184-line** component              |
| `data/client.ts`             | 1,034 | the board's HTTP surface                                          |
| `views/AutomationPage.tsx`   |   924 | one page                                                          |
| `views/WorkspacePages.tsx`   |   880 | several pages in one file                                         |
| `views/CreateDialogs.tsx`    |   851 | several dialogs in one file                                       |
| `data/parse.ts`              |   717 | wire → view parsing                                               |
| `views/WorkspaceSidebar.tsx` |   639 | the sidebar, and the `BoardPage` type                             |

Two different problems are tangled here, and the campaign is worth splitting along them:

- **Files that are several things in one file.** Mechanical to separate; the groupings are
  already visible in the declarations.
- **Two components that are each one enormous thing.** `WorkItemDetail` holds 40 hook calls
  and 46 local declarations before ~676 lines of JSX; `BoardApp` is the same shape. Splitting
  those means deciding where state lives and extracting custom hooks. That is design work, and
  it is the reason this campaign should not promise the audit's exit criterion in one pass.

## The roadmap's premise for this campaign is wrong

The roadmap says to split `WorkItemDetail.tsx` "along the seam its five test files already
use." Measured, those five files do not partition it — they overlap heavily:

| Symbol                                       | Imported by                                                    |
| -------------------------------------------- | -------------------------------------------------------------- |
| `FinalApprovalActions`, `FinalRejectionForm` | `WorkItemDetail.test.ts`, `WorkItemFinalApproval.test.ts`      |
| `AuditSection`, `StatusTimeline`             | `WorkItemSummaryGate.test.ts`, `WorkItemObservability.test.ts` |
| `PipelineSummaryDetails`                     | `WorkItemFinalApproval.test.ts`, `WorkItemSummaryGate.test.ts` |
| `ChildrenSection`                            | `WorkItemDetail.test.ts`, `WorkItemSummaryGate.test.ts`        |

A test file names a _scenario_, not a module. Four of the five would import from three or four
new modules, which is normal and fine — but it means the seam has to be derived from what the
components do, not from which test touches them. Unlike campaign 12, where fifteen banners had
already drawn the cuts, **nothing in these two files marks a seam**: neither carries a single
`/* —— Section —— */` banner, because campaign 11 only reached nine files and these were not
among them.

## The seam, derived from the components

`WorkItemDetail.tsx`'s 27 helpers group cleanly by concern. Sizes are measured from the
declaration boundaries:

| Module                        | Components                                                                                                                                                           | Lines |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| `work-item/plan.tsx`          | `PlanRecordDetails`, `PlanApprovalActions`, `PlanRejectionForm`, `WorkflowNodeCard`, `PlanListSection`, `planValueLabel`                                             |  ~254 |
| `work-item/evidence.tsx`      | `PipelineSummaryDetails`, `DesignRecordDetails`, `DesignTable`, `ReviewFindingsPanel`, `GapReportSection`                                                            |  ~383 |
| `work-item/family.tsx`        | `ChildrenSection`, `ParentWorkItemLink`, `InitialWorkItemFamily`, `initialFamilyState`, `familyNotParentAfterSnapshot`, `phaseDisplayLabel`, `childAttestationLabel` |  ~225 |
| `work-item/approval.tsx`      | `FinalApprovalActions`, `FinalRejectionForm`, `WorkItemFooterActions`                                                                                                |  ~167 |
| `work-item/observability.tsx` | `StatusTimeline`, `AuditSection`, `AuditTimestamp`, `AuditArtifactReferences`                                                                                        |  ~149 |
| `work-item/deployment.tsx`    | `ContractAttestationGate`, `AttestDeploymentForm`                                                                                                                    |  ~128 |

Every one of these is prop-driven — the whole region above the shell contains a single hook
call — so extraction is mechanical and cannot change behaviour. `BoardApp.tsx` has the same
structure: `NotificationsBlock`, `BoardPauseBanner`, `pausePopoverShouldClose`,
`routedWorkItemSelection`, `snapshotLostSelectedWorkItem`, `workItemDetailReloadPending` and
three dialog-trigger types, ~300 lines, all above a shell that starts at line 367.

**No façade.** Campaign 12 kept `validate.ts` as a re-export door because 25 files imported it
and the caller migration was a separate decision. Here the only importers are five colocated
test files, and each should say which feature module it is testing. A façade over a component
file would hide exactly the structure this campaign exists to expose.

## `BoardPage` belongs to routing

`BoardPage` is declared in `views/WorkspaceSidebar.tsx` and imported by `routing/useHashRoute.ts`
and `routing/routing.test.ts`. The route shape is owned by a view, which is backwards: routing
defines where you can be, and the sidebar renders it. Moving the type to `routing/routing.ts`
costs three import lines and makes the dependency point the right way.

## What splitting the helpers does and does not achieve

Honest arithmetic. Extracting every helper leaves the shells behind:

- `WorkItemDetail.tsx` 2,544 → **~1,250** (the 1,169-line component, its props, its imports)
- `BoardApp.tsx` 1,551 → **~1,250**

So the audit's exit criterion — no file in `src/web` over ~600 lines — is **not met by
mechanical extraction**, and no amount of care with the helpers will meet it. Saying otherwise
would be the campaign lying about its own scope.

## Recommendation

A ladder, so the cost is opt-in:

- **do-X — the mechanical seams.** `BoardPage` to routing; the six `work-item/` modules; the
  `BoardApp` helpers; a banner pass over both shells so the next campaign has the cuts drawn
  the way campaign 12 inherited them from campaign 11. Result: the two giants become two
  ~1,250-line shells with their features in named modules.
- **+Y — the six mid-tier files** (`client.ts`, `AutomationPage`, `WorkspacePages`,
  `CreateDialogs`, `parse.ts`, `WorkspaceSidebar`). Each is several things in one file; the
  groupings are visible in their declarations. Mechanical, and it clears six of the eight.
- **+Z — the two shells.** Extract custom hooks (`useWorkItemFamily`, `useDetailDialogs`, …)
  and reduce each component to composition. Design work: it decides where state lives.

**Recommended: X + Y**, with Z as its own campaign and its own brainstorming — and with the
exit criterion restated honestly for this one:

> Every file in `src/web` is under 600 lines **except** `WorkItemDetail.tsx` and `BoardApp.tsx`,
> which are named, banner-marked, and carried to campaign 14 as a hooks-extraction problem.

Adopting the audit's original criterion unchanged would leave this campaign permanently
half-finished on paper while the work it actually did went unrecorded.

## Anticipated objection

_Why not just do Z now, since it is the only thing that meets the criterion?_ Because Z is the
only part where a mistake is invisible. Moving a prop-driven component cannot change what
renders; moving a `useState` between components can change when it resets, and a
`useEffect`'s dependency array can silently start firing on a different schedule. X and Y are
verifiable by construction — declaration text is unchanged and Playwright proves the app still
mounts. Z needs its own review budget and its own arcs, and bundling it here would spend that
budget on the same commit as 30 mechanical moves.

## The banner pass is not possible, and campaign 14 gets a table instead

Task 1 tried to leave `/* —— Section —— */` banners inside the two shells, marking where a
hooks extraction would cut. **Prettier and the comment ratchet are jointly incompatible with
that**, and neither can be blamed: a banner inside a function body gets indented by Prettier to
match its surroundings, and `tests/tooling/code-style.test.mjs` requires the banner form at
column zero. Any marker carrying the `——` pair in a comment is checked, so a `//` variant fails
too. Banners are therefore a top-level-only convention in this repository — worth knowing before
some future campaign rediscovers it.

The cut points go here instead, named by the symbols that bound them rather than by line —
campaign 11 established that convention precisely because these two files are about to be
edited:

| Shell                | Region                     | Runs from             | Contains                                                    |
| -------------------- | -------------------------- | --------------------- | ----------------------------------------------------------- |
| `WorkItemDetail.tsx` | state                      | `seededFamily`        | 28 `useState`, 9 `useRef`                                   |
|                      | derived                    | `detailHeadingId`     | ids, `actionContexts`, `affordances`, the family predicates |
|                      | loads and effects          | the first `useEffect` | 10 `useEffect`                                              |
|                      | actions                    | `save`                | the `submit*` handlers                                      |
|                      | render                     | `return (`            | JSX                                                         |
| `BoardApp.tsx`       | state                      | `client`              | 21 `useState`, 19 `useRef`, 8 `useMemo`                     |
|                      | loads, effects and actions | the first `useEffect` | 11 `useEffect` and every handler                            |
|                      | render                     | `return (`            | JSX                                                         |

`BoardApp`'s middle region is 984 lines and mixes effects with handlers — it is not one seam
but several, and finding them is campaign 14's first job rather than something this spec can
assert from the outside.

## Alternatives considered

**Split `WorkItemDetail.tsx` by test file, as the roadmap says.** Rejected on measurement: the
five test files overlap on four symbol groups, so the "seam" they describe does not exist. The
tests keep their names — they describe scenarios — and import from whichever modules they need.

**Keep a `WorkItemDetail.tsx` façade re-exporting the six modules,** so the five test files do
not change. Rejected: unlike `validate.ts`'s 25 callers, five colocated tests are cheap to
update, and a façade would preserve the illusion that this is one component.

**Add banners first as a separate campaign, then split mechanically like campaign 12.**
Rejected as a wasted round-trip: the banner pass is one commit inside X, and the groupings are
already legible from the declaration list. Campaign 11 drew banners on nine files as a
comment-convention exercise; here they would be drawn _for_ the split.

**Adopt the audit's exit criterion unchanged and finish Z in this campaign.** Rejected — see
Recommendation and Anticipated objection. The criterion is not wrong, it is just bigger than
one campaign, and it stays on the roadmap as campaign 14's exit.
