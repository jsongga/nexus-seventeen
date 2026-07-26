# Steward model routing

This package chooses the least-expensive configured model tier justified by an agent's fixed role, work phase, task risk, complexity, context size, and observed test failures.

It contains no provider SDK, model identifiers, or prices. The host supplies a six-entry Codex/Claude catalog with current context limits and optional rate cards. `createModelRouter` snapshots that catalog so a decision is stable and auditable for the life of the router.

The result is one of three explicit dispositions:

- `model` selects a configured profile and records the baseline, escalation evidence, token estimate, context fit, and estimated cost;
- `blocked` requires context compaction or a larger task token budget; or
- `human_required` prevents any model from approving or deploying to production.

Cost is an estimate from caller-supplied rates and reserved output, never a quality claim. Passing tests and human production oversight remain outside the router and cannot be replaced by a model tier.

