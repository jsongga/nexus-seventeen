Onboard the repository on branch {{branch}} within declared scope {{declaredScope}}. Non-goals: {{nonGoals}}.
Inspect the repository before editing, preserve existing documentation, and create each missing slot with these documentation-layout topics:
- README.md: project name and human overview.
- docs/architecture.md: invariants, surprises, invisible wiring, and prohibitions.
- docs/interface.md: generated endpoints, types, and status codes from discoverable routes or schema; then authentication, error semantics, pagination, rate limits, idempotency and safe retries, ordering constraints, and deprecation status.
- docs/dependencies.md: outbound dependencies, timeouts, retry semantics, and idempotency requirements.
- docs/workflow.md: build, lint, deploy, fast test, area test, full test, and source-to-test mapping.
Create docs/decisions/ when missing and add a first dated ADR recording project onboarding. Do not overwrite an existing ADR.
Write exactly one fenced ```json block in docs/workflow.md containing a valid VerifyContract object with version 1, compile, rules, and full fields. Map the repository's actual source, test, documentation, and Dockerfile layout so fast, area, and full verification are executable; do not copy another repository's paths blindly.
When a Dockerfile exists, add an agent target suitable for the repository without breaking its existing targets. When no Dockerfile exists, record that gap instead of creating an unjustified container build.
Return a gapReport markdown field listing everything that could not be produced or repaired, including any absent test suite, lockfile, Dockerfile, or unfixturable dependency. Always include branch protection because GitHub integration is deferred.
Loop through the repository's focused checks and then its area checks before finishing. {{brightLine}}
