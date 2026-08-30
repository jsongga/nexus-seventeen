# Plan: codebase health (campaign 11)

Spec: `docs/superpowers/specs/2026-08-29-codebase-health-audit.md`. Base: `b4da0a1`.

Order is deliberate: real defects first, then the formatting commit everything else lands on, then the
user-visible comment work, then the plumbing/policy single-sourcing, then the cheap moves.

| #   | Task                   | Deliverable                                                                                                                                                                        | Why here                                                       |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Fix-now defects        | `derive.ts` uses the full redaction; `AutomationPage.tsx` NaN guard; `AGENT_SYSTEM.md:11` corrected                                                                                | Two are live defects, one is a false doc claim                 |
| 2   | Prettier adoption      | `prettier` + config + `format`/`format:check` scripts + one whitespace-only commit                                                                                                 | Everything after lands on formatted code; 117 lines >200 chars |
| 3   | Comment convention     | Convention in `docs/workflow.md`; headers + banners on the nine files; `tests/tooling/code-style.test.mjs` with a shrinking allowlist                                              | The user's stated pain                                         |
| 4   | `server/shared/git.ts` | One runner: timeout, env, hooks-off, buffer bounds, credential-safe errors; 4 factories + 12 fsmonitor sites + 2 ls-tree parsers collapse                                          | Drift risk across every git caller                             |
| 5   | Policy single-sourcing | One credential module (`containsCredential`/`redactCredential`/activity redaction); one exported stage→role table consumed by contract + web                                       | A security boundary and an authorization rule, each duplicated |
| 6   | Cheap structural moves | `web/task-board/*` → `web/*`; `project/` → `views/`; `model/project.ts` → `data/`; `scope-check.ts` → `server/shared/`; delete 2 dead barrels + 2 dead exports; one date formatter | Removes the redundant levels behind "too nested"               |

Not in this campaign: the persistence/collaborators cycle (12), web feature seams and the `WorkItemDetail`
split (13), renames (9.7), the test-mirror contract (9.7 or its own).

Per task: Codex implements → gates outside the sandbox → Claude reviewer + `codex review` (serialized, never
concurrent with a gate) → reconcile → commit. Fix rounds cap 5.
