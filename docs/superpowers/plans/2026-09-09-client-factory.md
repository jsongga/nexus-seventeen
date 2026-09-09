# Plan: the task-board client factory (campaign 15)

Spec: `docs/superpowers/specs/2026-09-09-client-factory.md`. Base: `7146a63`.

One task. It is not divisible: the context object and the first group that uses it must land
together, or there is nothing to pass.

## Task 1 — the context object and the resource groups

Introduce `TaskBoardClientContext` holding `request` and the five caches. `createTaskBoardClient`
builds exactly one and passes the same reference to group modules under `src/web/data/client/`,
divided by resource the way the interface already reads.

**The cross-group cache test is the deliverable, not the split.** Write it first: populate a cache
through one group's method, read it through another's, assert the second saw the first. If two
contexts exist, that test fails and nothing else does — not the compiler, not the type, not
review.

**No module may construct a context.** One construction site, in the factory.

**Exit:** `client.ts` under 600 lines; the cross-group cache test passes and fails if a second
context is introduced; the 48-method interface is byte-identical; `test:all` and Playwright green.

## Per task

Codex implements; the controller runs Playwright and the falsification. Gates outside the sandbox:
`typecheck:all`, `test:all`, Playwright both projects. Claude reviewer and `codex review`
serialized. Fix rounds cap 5.

**Watch for:** the spec's +Z — narrowing each group's context to the maps it uses — is the
plausible-sounding change that makes the failure _more_ likely, because a narrow type is easier to
satisfy with a locally built object. Keep one wide context.

**Abandon criterion, stated up front:** if the cross-group cache test cannot be written so that it
genuinely fails on a second context, stop and leave `client.ts` at 877 lines. The ratchet prevents
growth, and an unverified split of caching code is worse than no split.
