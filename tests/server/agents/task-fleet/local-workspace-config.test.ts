import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskFleetConfig } from "#server/agents/task-fleet/config";

function config(workspaceRoot?: string): Record<string, unknown> {
  return {
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [
      {
        workerId: "worker-pipeline",
        agentId: "engineer-pipeline",
        token: "pipeline-agent-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "codex",
        model: "codex-model",
        workingDirectory: "/work/repository",
        statePath: "/state/pipeline.json",
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      },
    ],
  };
}

test("local-process lanes optionally accept an absolute workspace root without changing legacy config shape", () => {
  const legacy = parseTaskFleetConfig(config()).agents[0] as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(legacy, "workspaceRoot"), false);

  const workspaceLane = parseTaskFleetConfig(config("/work/task-workspaces")).agents[0] as unknown as Record<
    string,
    unknown
  >;
  assert.equal(workspaceLane.workspaceRoot, "/work/task-workspaces");

  assert.throws(() => parseTaskFleetConfig(config("relative-workspaces")), /workspaceRoot must be absolute/u);
});

test("the local-process workspace field remains invalid on container lanes", () => {
  const value = config("/work/local-workspaces");
  const lane = (value.agents as Array<Record<string, unknown>>)[0]!;
  lane.runtime = "container";
  lane.container = { workspaceRoot: "/work/container-workspaces" };

  assert.throws(() => parseTaskFleetConfig(value), /workspaceRoot is only valid for local-process lanes/u);
});
