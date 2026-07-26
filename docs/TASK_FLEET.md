# Steward task fleet

The task fleet runs multiple existing task-board agents from one local JSON file. Each lane uses the existing held claim, so an idle fleet has no model process and spends no model tokens. A timer is used only to back off after a transient board failure; it never creates work or wakes an agent.

Build it, copy `fleet.example.json` outside the repository, add one entry per existing board agent, and start the entire fleet with one command:

```bash
npm run build:runtime
node build/server/agents/task-fleet/main.js /absolute/path/to/fleet.json
```

The same command accepts `STEWARD_TASK_FLEET_CONFIG` instead of a positional path. Agent tokens remain in the local config and never enter the frontend. Closing or updating the frontend has no effect on the fleet.

Claude lanes use bare mode when `ANTHROPIC_API_KEY` is present. Without an explicit key, the launcher keeps OAuth/keychain authentication available under safe mode; project customizations, session persistence, MCP servers, and slash commands remain disabled in either case.

The fleet retries only transport failures, throttling, and server errors. Authentication and invalid-state errors stop the affected lane while other agents continue. `SIGINT` and `SIGTERM` abort held claims, directly interrupt any active model process through the existing worker, and close every worker journal.
