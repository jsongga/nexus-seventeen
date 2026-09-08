# Plan: credential redaction at the agent boundary (roadmap 9.11)

Spec: `docs/superpowers/specs/2026-09-07-credential-redaction.md`. Base: TBD at dispatch.

Two tasks. The split is deliberate: the mechanism is worthless without the telling, but the
telling is only reviewable once the mechanism exists.

| #   | Task              | Deliverable                                                          | Why here                                     |
| --- | ----------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| 1   | Redact, and mark  | `redactCredentials` replaces `assertCredentialSafe` at all six sites | The behaviour change, in one reviewable step |
| 2   | Tell both parties | Per-run activity entry with site, count and pattern name             | What makes a redaction loud instead of odd   |

## Task 1 — redact, and mark

Replace `assertCredentialSafe(value, label)` with a function that returns the redacted string and
what it changed, at all six call sites (`agent-envelope.ts:731`,
`contained-cli-launcher.ts:111,248`, `container-launcher.ts:235,387`). The marker is
`[redacted: credential]`.

**Do not change `CREDENTIAL_PATTERNS` or `CREDENTIAL_REJECTION_PATTERNS`.** The spec's +Y is
explicitly deferred: changing the action and the matching together leaves no clean attribution
when something slips. Reuse the existing vocabulary exactly.

The two pattern sets exist because the global one over-matches for stored-log redaction while the
rejection set is narrowed for prose. **Decide and state which set the boundary uses now that a
false positive is cheap** — that is a real decision, not a detail, and the answer belongs in the
report.

**Exit:** a context carrying a real token launches a run whose prompt contains the marker; a
sentence about "Bearer authentication" is untouched; no test asserts `AgentProcessError` for a
credential.

## Task 2 — tell both parties

A run activity entry per redacting site: which site, how many spans, and the **pattern name**.
Never the matched text — recording it would defeat the filter, and this is the one line in the
campaign where a mistake reintroduces the leak the filter exists to stop.

Surface it wherever provider activity already appears, so a human reading a run sees it without
looking for it.

**Exit:** a redacted run shows one activity entry naming the pattern and the count; a test asserts
the matched text appears in no event, log or stored field.

## Per task

Codex implements both. Gates outside the sandbox: `typecheck:all`, `test:all`, `test:container`,
and Playwright only if `src/web` is touched. Claude reviewer and `codex review` serialized, never
concurrent with a gate. Fix rounds cap 5.

**Watch for:** the existing tests assert rejection. Task 1 will delete or invert a number of them;
a reviewer should check that each deleted assertion was replaced by one that proves the _span_
was redacted, not merely that no error was thrown. "It didn't throw" is not evidence the filter
still fires.
