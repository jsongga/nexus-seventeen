# Workflow — nexus-seventeen

How to build, test, and run this repo. The fenced `json` block below is the
machine-readable verify contract consumed by `npm run verify:*`
(`src/server/agents/verify/`); edit it and the prose together.

## Build

- `npm run build` — full build (runtime tsc → `build/`, web vite → `dist/`).
- `npm run build:runtime:fast` — incremental runtime build, no clean. Used by
  the verify tiers; CI-shaped commands use the clean `build:runtime`.

## Test tiers

Three tiers per orchestrator-design §5. Fast is diff-derived: changed files
map to tests by the conventions encoded in the contract's `rules` (source
`src/server/a/b.ts` mirrors to `tests/server/a/b.test.ts`; web specs are
co-located; docker-gated `tests/container` and build-affecting files
escalate). Unmapped changes fail closed to a bigger tier — exit code 2.

| Tier | Command | Scope | Target |
| --- | --- | --- | --- |
| fast | `npm run verify:fast` | tests matching the current diff | < 10 s |
| area | `npm run verify:area` | whole test dirs of changed areas | < 2 min |
| full | `npm run verify:full` | everything incl. docker-gated | background |

Full runs in the background: the command prints a run id; observe with
`node build/server/agents/verify/main.js status <id>` / `tail <id>`.

```json
{
  "version": 1,
  "compile": ["npm run build:runtime:fast", "npm run build:tests:fast"],
  "rules": [
    { "match": "tests/container/**", "action": { "kind": "escalate" } },
    { "match": "tests/**/*.test.ts", "action": { "kind": "self" } },
    { "match": "tests/**", "action": { "kind": "escalate" } },
    { "match": "src/server/task-board/persistence/**", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/task-board"] } },
    { "match": "src/server/**/*.ts", "action": { "kind": "mirror" } },
    { "match": "src/shared/**", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server", "tests/shared"] } },
    { "match": "src/web/**", "action": { "kind": "colocated", "vitestFallback": "src/web" } },
    { "match": "tooling/**", "action": { "kind": "fixed", "vitest": ["tooling"] } },
    { "match": "docker_image/**", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/task-container"] } },
    { "match": "Dockerfile", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/task-container"] } },
    { "match": "scripts/**", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/task-container"] } },
    { "match": "docs/workflow.md", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/verify"] } },
    { "match": "docs/**", "action": { "kind": "none" } },
    { "match": "config/prompts.md", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/agents/task-worker"] } },
    { "match": "config/skills.md", "action": { "kind": "fixed", "nodeTestDirs": ["tests/server/task-board"] } },
    { "match": "**/*.md", "action": { "kind": "none" } },
    { "match": "package.json", "action": { "kind": "escalate" } },
    { "match": "package-lock.json", "action": { "kind": "escalate" } },
    { "match": "tsconfig*.json", "action": { "kind": "escalate" } },
    { "match": ".gitignore", "action": { "kind": "none" } }
  ],
  "full": ["npm run typecheck:all", "npm run test:all", "npm run test:container"]
}
```

## Run

- Board: `npm run dev:task-board` · fleet: `npm run dev:task-fleet` (config
  via `STEWARD_TASK_FLEET_CONFIG`) · web dev server: `npm run dev`.
