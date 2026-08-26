# Steward task fleet

The task fleet runs multiple existing task-board agents from one local JSON file. Each lane uses the existing held claim, so an idle fleet has no model process and spends no model tokens. A timer is used only to back off after a transient board failure; it never creates work or wakes an agent.

`src/server/agents/task-fleet/fleet.example.json` shows a two-lane scaling pattern. For a single-lane setup, delete the second agent block; every lane needs a distinct `workerId`, `agentId`, token, and `statePath`.

Build it, copy the example outside the repository, add one entry per existing board agent, and start the entire fleet with one command:

```bash
npm run build:runtime
node build/server/agents/task-fleet/main.js /absolute/path/to/fleet.json
```

The same command accepts `STEWARD_TASK_FLEET_CONFIG` instead of a positional path. Agent tokens remain in the local config and never enter the frontend. Closing or updating the frontend has no effect on the fleet.

## Runtime and prompt paths

The default runtime profile path is `config/runtimes.json`, and the default prompt root is `prompts/`. Both are resolved from the process's current working directory, not from the fleet config file. Starting the fleet outside this repository therefore requires top-level `runtimesConfigPath` and `promptsRoot` values:

```json
{
  "runtimesConfigPath": "/absolute/path/to/nexus-seventeen/config/runtimes.json",
  "promptsRoot": "/absolute/path/to/nexus-seventeen/prompts"
}
```

The standalone task-worker entrypoint uses the same cwd-relative defaults. Override them there with `STEWARD_TASK_WORKER_RUNTIMES_CONFIG` and `STEWARD_TASK_WORKER_PROMPTS_ROOT`.

## Lane capabilities

Each agent entry may declare `role` (`manager`, `engineer`, or `verifier`). When present, worker construction validates that the selected runtime profile supports that role and sandbox; a mismatch fails closed before the lane can claim work. Omitting `role` keeps launch-time enforcement: every claimed role is checked immediately before model launch.

Claude lanes use bare mode when `ANTHROPIC_API_KEY` is present. Without an explicit key, the launcher keeps OAuth/keychain authentication available under safe mode; project customizations, session persistence, MCP servers, and slash commands remain disabled in either case.

The fleet retries transport failures, throttling, server errors, and journal I/O with capped exponential backoff. Authentication errors close the affected lane. Invalid-state and unexpected local errors quarantine a held claim as failed; a `RuntimeCapabilityError` is classified `POISONED`, quarantines the claim when one is held, and closes that lane permanently. `SIGINT` and `SIGTERM` abort held claims, directly interrupt any active model process through the existing worker, and close every worker journal.
