# Steward role policy

This package is Steward's executable authority boundary for fixed agent roles. It denies unknown roles, operations, tools, and workflow transitions. Provider prompts describe roles but never grant permission.

The four roles are deliberately narrow:

- engineers follow research → plan → modify → test and repeat from research after a failed test;
- verifiers inspect and test without source changes;
- managers review without source changes, route tasks, and create the human handoff;
- the impact observer only turns supplied facts into a user-oriented summary.

No agent role can approve or deploy production. The workflow can reach `human_approved` and `deployed` only through an authenticated human actor.

## Host integration

The supervisor must enforce policy at a trusted boundary, before provider-requested work runs:

1. Bind every concrete provider tool to one `PolicyOperation` in host-owned configuration.
2. Call `evaluateToolCall` for every tool invocation. Treat anything except `allow` as non-executable.
3. Isolate read-only roles at the process or filesystem boundary too. Labeling a shell command `context.read` is not safe if that process can write.
4. Call `validateWorkflowTransition` before atomically recording every task-state change.
5. Derive authenticated human identity from the control plane, never from model output or tool arguments.
6. Keep production credentials and deployment adapters unavailable to all model-owning processes.
7. Give the observer only bounded, redacted facts; do not grant it repository or provider-tool access.

The exported prompts are compact context hints. Skipping either evaluator is an authorization bug.
