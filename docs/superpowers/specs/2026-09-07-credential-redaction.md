# Move the agent credential boundary from rejection to redaction (roadmap 9.11)

**Status** Draft · **Author** Claude (controller) · **Date** 2026-09-07 · **Scope** the
credential filter at the agent process boundary, and what the agent and the human are told when
it fires.

## What this is about

A **worker** launches a model process (an **agent run**) with a **context** — the task, its
history, and repository facts. The model returns a structured **outcome**, and writes
**diagnostics** along the way. All three cross a process boundary, and all three are scanned for
anything that looks like a credential, so a leaked token never reaches a model vendor or a log.

Today that scan **rejects**: a match throws `AgentProcessError` and the whole string is refused.

```
context  ──scan──▶ match ──▶ AgentProcessError ──▶ the run never starts
outcome  ──scan──▶ match ──▶ AgentProcessError ──▶ completed work is discarded
```

## The problem

A fail-closed filter must decide, from prose, whether a span is a secret. Three attempts have now
shipped, and **every one had a false-positive class found by review rather than by testing**:

| Attempt         | Rule                          | Rejected                                              |
| --------------- | ----------------------------- | ----------------------------------------------------- |
| 9.10 first pass | a length floor after `Bearer` | `"Bearer authentication"`                             |
| 9.10 fix        | "contains a non-letter"       | `"Bearer authentication."` — `.` is a token character |
| 9.10 safety net | a 24-character ceiling        | `"Bearer AuthenticationMiddleware"`                   |

The pattern is not that the rules were sloppy. It is that **any rule that guesses must sometimes
guess wrong**, and under rejection a wrong guess is fatal: the run dies, or finished work is
thrown away, for a sentence about authentication.

Redaction cannot be fatal. A false positive costs the agent one word, replaced by a marker it can
see and reason about.

## The change in one sentence

The filter replaces the matched span instead of refusing the string, and both the agent and the
human are told it happened.

## Where it fires, and why the sites are not equivalent

`assertCredentialSafe` has six call sites in three kinds. The consequence of a false positive
differs at each, which is why one policy for all of them is the wrong answer:

| Kind                             | Sites                                                        | Today's cost of a false positive | Under redaction                             |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------- | ------------------------------------------- |
| **Context** (input to the model) | `contained-cli-launcher.ts:111`, `container-launcher.ts:235` | the run never starts             | one span becomes a marker; the run proceeds |
| **Outcome** (the model's result) | `agent-envelope.ts:731`                                      | completed work is discarded      | the result lands with a marker in it        |
| **Diagnostics**                  | `contained-cli-launcher.ts:248`, `container-launcher.ts:387` | debugging text is lost           | the line survives, redacted                 |

**Outcome is the one that deserves argument.** Redacting a model's own output means storing a
result the model did not write. That is acceptable precisely because the alternative is worse:
discarding it loses the work _and_ the evidence of what happened, and the agent cannot retry
usefully because it is never told which span offended.

## What makes it honest

The switch itself is small. The work is what stops a redacted prompt from becoming a confusing
failure instead of a loud one:

- **The agent must know.** The replacement is a visible marker — `[redacted: credential]` — not a
  silent deletion. An agent that sees its own context altered can say so; one that receives a
  quietly shortened sentence cannot.
- **The human must know.** Each redaction records an activity entry on the run: which site fired,
  how many spans, and the matched **pattern name** — never the matched text, which would defeat
  the filter. Without this, a redaction is invisible until someone wonders why a plan reads oddly.
- **Counted, not just marked.** The activity entry carries a count so a storm of redactions —
  the signature of a genuine leak, or of a pattern that has gone wrong — is visible as one number
  rather than inferred from reading prose.

## What does not change

- **The vocabulary.** `CREDENTIAL_PATTERNS` and `CREDENTIAL_REJECTION_PATTERNS` in
  `server/shared/redact.ts` stay the one definition of what a credential looks like. This item
  changes the _action_, not the _matching_.
- **Redaction already exists** for provider activity and stored logs; this extends the same
  mechanism to the boundary rather than inventing a second one.
- **Fail-closed remains the posture.** A credential still never reaches the vendor. Redaction is
  strictly safer than rejection on that axis, because a rejected string today is often retried by
  a human who then pastes it somewhere else.

## Recommendation

- **do-X — redact at all six sites**, with the marker and the per-run activity entry.
- **+Y — narrow the patterns** now that a false positive is cheap. Under rejection, every
  loosening was a risk nobody wanted to take; under redaction the calculus inverts and the
  over-matching `REJECTED_*` floors can be revisited on evidence.
- **+Z — a redaction ledger**, so repeated redactions across runs are queryable rather than
  per-run.

**Recommended: X.** Y is tempting to bundle and should not be: changing the action and the
matching in one campaign means a behaviour change with no clean attribution when something slips.
Z has no demand yet.

**Exit:** a context containing a real token launches a run whose prompt carries
`[redacted: credential]`, the run's activity shows one redaction naming the pattern, and no test
asserts `AgentProcessError` for a credential any more. A prose sentence about "Bearer
authentication" passes through untouched.

## Alternatives considered

**Keep rejecting, and keep refining the patterns.** This is the status quo and it is a treadmill:
three attempts, three false-positive classes, each found in review. The next rule will also be
wrong somewhere, and the cost of being wrong stays fatal.

**Reject only on the input side, redact on the output side.** Tempting, because refusing to _send_
a secret feels stricter than rewriting it. Rejected: it keeps the worst failure mode — a run that
cannot start because its task mentions authentication — while adding a second policy to reason
about.

**Redact silently, with no marker or activity entry.** Cheapest to build and the most dangerous:
an agent reasoning about text that was altered without its knowledge produces confident wrong
answers, and a human debugging it has no thread to pull. The marker and the activity entry are
the point, not decoration.

**Ask the human to approve each redaction.** Turns every false positive into an interruption, on
a path that runs unattended by design. Rejected.
