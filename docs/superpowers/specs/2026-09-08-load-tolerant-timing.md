# Load-tolerant pipeline timing (roadmap 9.8)

**Status** Draft · **Author** Claude (controller) · **Date** 2026-09-08 · **Scope** the wall-clock
windows in `machine-verify-integration`, `pipeline-e2e`, and one Playwright arc.

## What this is about

Several integration arcs drive a background **sweep** — the board's periodic reconciler — and wait
for a work item to reach a state. They wait by **wall clock**: poll every 25 ms until a fixed
budget expires, then fail.

```ts
const deadline = Date.now() + 8_000;
while (Date.now() < deadline) {
  await fixture.board.sweepVerifyAttempts();
  if (reached(expectedState)) return;
  await delay(25);
}
assert.fail(`verify sweep did not reach ${expectedState}; current=…`);
```

There are ten such windows: 5 s, 8 s, 10 s and 15 s budgets across the two suites.

## The problem

**A wall-clock budget measures the machine, not the code.** On a loaded host the sweep gets less
CPU, the budget expires, and the suite reports a regression that does not exist. Campaign 10
needed repeated isolated reruns for exactly this reason, and the Playwright arc
`a pending pause keeps its reason and error when the rail breakpoint changes` fails roughly one
run in three on a busy machine while passing consistently on an idle one.

The cost is not the lost minutes. It is that **a flaky red makes every red cheap** — the correct
response to a failure becomes "run it again", which is precisely how a real regression ships.

## The change in one sentence

Wait for progress to stop, not for a clock to run out.

## Model

A **progress-gated wait**: keep polling while the system is still changing, and fail only once it
has been **quiescent** for a bounded number of consecutive polls.

|                               | Wall-clock budget   | Progress gate                             |
| ----------------------------- | ------------------- | ----------------------------------------- |
| Loaded machine, healthy code  | fails at the budget | keeps waiting; progress continues; passes |
| Idle machine, real regression | fails at the budget | fails as soon as progress stops           |
| Deadlocked system             | fails at the budget | fails after the quiescence window         |

Progress is anything the arc already reads to decide success: the work-item state, the terminal
attempt count, the node's block reason. A poll that changes **any** observed value resets the
quiescence counter.

A wall-clock **ceiling** stays, but far above the budget it replaces — its job changes from
"decide the verdict" to "stop a hung suite", so it can be generous without weakening anything.

## What this does not do

- **No retries.** A test that passes on the second run is a test that reports nothing. Progress
  gating removes the reason to retry rather than automating it.
- **No sleeps tuned by hand.** Any number chosen by watching one machine is wrong on another.
- **No change to what the arcs assert.** Every state assertion stays exactly as it is; only the
  waiting changes.

## Recommendation

- **do-X — one shared progress-gated helper**, used by all ten windows in the two node suites.
- **+Y — the Playwright arc.** `a pending pause keeps its reason…` is a different mechanism (a
  held response plus a viewport change), so it needs its own look rather than the same helper.
- **+Z — fail with the progress trace.** When a gate does fail, print the sequence of observed
  values, so a real regression names the state it got stuck in instead of just the last one.

**Recommended: X + Y + Z.** Z is small and is what makes a progress gate debuggable; without it a
failure says less than the current message does.

**Exit:** the two node suites pass with a deliberately loaded machine (a parallel build running),
and the Playwright arc passes 5 consecutive runs under the same load.

## Alternatives considered

**Scale the budgets by a measured machine speed factor.** Calibrate once, multiply every budget.
Rejected as the primary mechanism: it keeps a wall clock in the verdict, so it only moves the
threshold at which a loaded machine lies. It is also a number that rots — the calibration is
itself measured under whatever load exists at that moment.

**Raise every budget.** Cheapest, and it trades a false red for a slow suite that still fails
under enough load, while making every genuine deadlock take the new budget to report.

**Mark the arcs flaky and retry them.** Available in both runners. Rejected: it converts a signal
into noise, and this program has already had two real defects (a wrong-tree dispatch, a viewport
regression) that first appeared as a single failing arc.
