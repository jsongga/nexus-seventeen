# The two web shells (campaign 14)

**Status** Draft · **Author** Claude (controller) · **Date** 2026-09-08 · **Scope** `BoardApp.tsx`
and `views/WorkItemDetail.tsx`, and what keeps them small afterwards.

## What this is about

Two React components hold almost all of the web app's state. `BoardApp` loads the board, drives
navigation, owns every dialog and mutation, and renders the page; `WorkItemDetail` does the same
for one work item. Campaigns 11–13 split every _other_ oversized file by moving prop-driven markup
out. These two were deferred because their bulk is **state**, and moving state decides where it
lives.

| File                       | Lines | Hook calls |
| -------------------------- | ----- | ---------- |
| `BoardApp.tsx`             | 1,402 | 75         |
| `views/WorkItemDetail.tsx` | 1,254 | 50         |

## Two findings that change what this campaign is

**Campaign 13 promised banners here and never delivered them.** Its task 1 said both shells would
get `/* —— Section —— */` banners marking the regions a hooks extraction would cut along —
explicitly "the same favour" campaign 11 did for 12. Checked across every commit that touched
`BoardApp.tsx`: **zero section banners, in every revision, including campaign 13's own**
(`1523d14`). The banner pass was in the task's body but **not in its exit criteria**, and the gate
only checks exit criteria. A deliverable that is not in the exit criteria does not ship.

**There is no file-size ratchet, and the limit has already been breached.** Campaign 13's exit was
"both files under 1,300". `BoardApp.tsx` is **1,402** — it grew past its own campaign's limit
within two days, through ordinary feature work (campaigns 16, 18, 9.7, 9.12 each added a little).
`tests/tooling/` ratchets module headers and layering, but nothing ratchets size.

So the honest reading is: **campaign 14 as scoped would erode exactly the way campaign 13's work
did.** Extraction without a ratchet buys a few quiet weeks.

## The change in one sentence

Give each cluster of related state its own hook, and add the ratchet that keeps the result from
growing back.

## Model

`BoardApp`'s state groups cleanly along lines that already exist:

| Hook                    | State it owns                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `useBoardSnapshot`      | `snapshot`, `loading`, `busy`, `connectivityError`, `signInExpired`                                            |
| `useBoardNotifications` | `notifications`, `notificationsLoading`, `notificationsError`, `markingNotificationId`, `notificationsAttempt` |
| `useBoardPause`         | `boardPause`, `pausePopoverOpen`, `pauseBusy`, `pauseControlError`, `pauseReason`                              |
| `useWorkItemDetailLoad` | `loadedWorkItemDetail`, `workItemDetailLoadingId`, `familyRefreshRevision`                                     |
| `useBoardDialogs`       | `dialog`, `dialogProjectId`, `drawerOpen`                                                                      |

Each group is already coherent: every member is read and written by the same handful of functions,
and no member is read by a function that touches another group's members except through the values
they return. That is the test for whether a hook is a real seam or a filing cabinet.

**The rule for where state lives:** state belongs at the level that owns its _lifecycle_, not the
level that renders it. 9.12 is the worked example — `pauseReason` lived in `WorkspaceSidebar`
because that is where the input rendered, so crossing a breakpoint unmounted the sidebar and
destroyed a draft the operator had typed. The reason belonged with the attempt, not with the
control.

## What this does not do

- **No behaviour change.** Every extraction is a move; Playwright is the proof, because only the
  browser shows a moved hook still runs in the same order.
- **No new abstraction layer.** Five hooks in `src/web/board/`, not a store, not a context, not a
  reducer framework. The app has one consumer for each of these.
- **No `WorkItemDetail` split into feature hooks beyond its own three clusters.** It is the smaller
  problem and its own campaign if it stays large.

## Recommendation

- **do-X — the five `BoardApp` hooks.** Largest file, clearest seams.
- **+Y — the size ratchet.** A tooling test with a per-file baseline that may shrink and never
  grow, exactly like the module-header allowlist. Without it, X is temporary.
- **+Z — `WorkItemDetail`'s three clusters.**

**Recommended: Y first, then X, then Z.** Y before X is deliberate and is the one real argument
here: a ratchet added _after_ an extraction records whatever number the extraction happened to
produce, while a ratchet added first makes the extraction's benefit visible as the baseline drops.
It also protects the other 40 files campaigns 11–13 shrank, which are currently unprotected and
may already have drifted.

**Exit:** `BoardApp.tsx` under 700 lines with five hooks in `src/web/board/`; a tooling test fails
if any tracked file grows; Playwright green on both projects.

## Alternatives considered

**A context or store.** Rejected: every one of these clusters has exactly one consumer, so a
context buys indirection and costs a re-render boundary. Introduce one when a second consumer
appears.

**Extract by line range rather than by state cluster.** Faster, and it produces hooks that share
mutable state across their boundary — which is how a "refactor" turns into a behaviour change.
The grouping above was chosen so no function reads two groups' internals.

**Do X without Y.** This is campaign 13's approach, and the measurement above is what it produced:
a limit breached within two days by ordinary work, with no gate to notice. Rejected on evidence.

**Do nothing.** Defensible — both files are navigable and every test passes. But 9.12 was a defect
caused directly by state sitting at the wrong level, so this is not purely cosmetic.

## Outcome (2026-09-09): two clusters were seams, three were navigation

`useBoardNotifications` and `useBoardPause` shipped. `BoardApp.tsx` went **1,402 → 1,256** and the
ratchet baseline fell with each.

The other three did not, and the spec's premise above is why. It claimed every group was coherent —
_"no member is read by a function that touches another group's members"_. Measured against the
file, that holds for the two extracted and fails for the rest:

| Cluster                 | What crosses it                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useBoardDialogs`       | `showDialog` / `closeDialog` reach into `dismissActionError` and `actionErrorContexts`, both form-dirty refs, `taskDialogAnchorRef`, `pendingDialogActionRef` and `navigateRoute`; and a routing effect writes `setWorkItemDetailLoadingId` — another cluster's setter |
| `useWorkItemDetailLoad` | written from three directions: a routing effect keyed on `page`, `refreshManually` in the snapshot cluster, and its own loaders                                                                                                                                        |
| `useBoardSnapshot`      | `refreshManually` writes `familyRefreshRevision`, which belongs to the detail cluster                                                                                                                                                                                  |

Extracting them as proposed would produce hooks that **share mutable state across their seam** —
the exact failure this plan names as how a refactor becomes a behaviour change. Passing eight
dependencies into a hook that still calls another cluster's setter is filing, not extraction.

**What actually binds them is navigation.** A page change decides what detail to load, which dialog
to close, and what to refresh. So the seam here is not `dialogs | detail | snapshot`; it is
navigation and everything it drives — a larger design question than this campaign scoped, and one
that should not be answered mid-extraction against a 1,256-line file.

The durable half of the campaign shipped regardless: the ratchet keeps the 146 removed lines from
coming back.
