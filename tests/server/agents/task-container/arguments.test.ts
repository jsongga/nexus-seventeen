import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContainerRunPlan,
  ContainerAgentLauncher,
} from "#server/agents/task-container";
import { AgentProcessError } from "#server/agents/task-worker/agent-envelope";
import { context } from "../task-worker/helpers.js";

const baseOptions = {
  provider: "codex" as const,
  model: "gpt-test",
  image: "steward-agent:test",
  networkName: "steward-agents",
  proxyUrl: "http://steward-egress-proxy:3128",
};

function assertPair(args: readonly string[], name: string, value: string): void {
  const index = args.findIndex((argument, candidate) => argument === name && args[candidate + 1] === value);
  assert.notEqual(index, -1, `${name} is present`);
  assert.equal(args[index + 1], value);
}

test("builds a hardened Codex docker run plan without credential values in argv", () => {
  const plan = buildContainerRunPlan({
    options: {
      ...baseOptions,
      agentCommand: "steward-stub",
      extraContainerEnv: { STEWARD_STUB_MODE: "fail" },
    },
    runId: "run-one",
    taskId: "task-one",
    fixedRole: "engineer",
    workspacePath: "/tmp/worktree-one",
    bareApiKey: false,
  });

  assert.equal(plan.containerName, "steward-task-run-one");
  assert.deepEqual(plan.args.slice(0, 6), [
    "run", "--rm", "-i", "--name", "steward-task-run-one", "--label",
  ]);
  assertPair(plan.args, "--label", "steward.task=task-one");
  assertPair(plan.args, "--network", "steward-agents");
  assertPair(plan.args, "--user", "node");
  assertPair(plan.args, "--cap-drop", "ALL");
  assertPair(plan.args, "--security-opt", "no-new-privileges");
  assertPair(plan.args, "--memory", "4g");
  assertPair(plan.args, "--pids-limit", "512");
  assertPair(plan.args, "-v", "/tmp/worktree-one:/workspace:rw");
  assertPair(plan.args, "-w", "/workspace");

  for (const proxy of [
    "HTTP_PROXY=http://steward-egress-proxy:3128",
    "HTTPS_PROXY=http://steward-egress-proxy:3128",
    "http_proxy=http://steward-egress-proxy:3128",
    "https_proxy=http://steward-egress-proxy:3128",
    "NO_PROXY=localhost,127.0.0.1",
  ]) {
    assert.ok(plan.args.includes(proxy), `${proxy} is present`);
  }
  for (const key of [
    "CODEX_HOME",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
  ]) {
    assertPair(plan.args, "-e", key);
    assert.ok(plan.args.includes(key), `${key} is passed by bare name`);
  }
  assert.ok(!plan.args.some((argument) => /OPENAI_API_KEY=/u.test(argument)));
  assert.ok(plan.args.includes("STEWARD_STUB_MODE=fail"));

  const imageIndex = plan.args.indexOf("steward-agent:test");
  assert.notEqual(imageIndex, -1);
  assert.equal(plan.args[imageIndex + 1], "steward-stub");
  assertPair(plan.args, "--cd", "/workspace");
  assertPair(plan.args, "--output-schema", "/opt/steward/agent-result.schema.json");
  assert.ok(plan.args.includes("sandbox_workspace_write.network_access=true"));
  const includedEnvironment = plan.args.find((argument) => argument.startsWith("shell_environment_policy.include_only="));
  assert.match(includedEnvironment ?? "", /HTTP_PROXY/u);
});

test("builds Claude plans with the default command and bare mode selected by input", () => {
  const input = {
    options: {
      ...baseOptions,
      provider: "claude" as const,
      model: "claude-test",
    },
    runId: "run-claude",
    taskId: "task-claude",
    fixedRole: "verifier" as const,
    workspacePath: "/tmp/worktree-claude",
  };
  const barePlan = buildContainerRunPlan({ ...input, bareApiKey: true });
  const oauthPlan = buildContainerRunPlan({ ...input, bareApiKey: false });

  const imageIndex = barePlan.args.indexOf("steward-agent:test");
  assert.notEqual(imageIndex, -1);
  assert.equal(barePlan.args[imageIndex + 1], "claude");
  assert.ok(barePlan.args.includes("--bare"));
  assert.ok(!oauthPlan.args.includes("--bare"));
  assert.ok(!barePlan.args.includes("--output-schema"));
  assert.ok(!barePlan.args.includes("/opt/steward/agent-result.schema.json"));
  assertPair(barePlan.args, "-e", "ANTHROPIC_API_KEY");
  assertPair(barePlan.args, "-e", "CLAUDE_CONFIG_DIR");
});

test("validates container launcher configuration", () => {
  assert.throws(() => new ContainerAgentLauncher({
    ...baseOptions,
    model: "x".repeat(257),
    dockerBinary: "/nonexistent",
  }), /model is invalid/u);
  assert.throws(() => new ContainerAgentLauncher({
    ...baseOptions,
    timeoutMs: 999,
    dockerBinary: "/nonexistent",
  }), /timeoutMs is invalid/u);
  assert.throws(() => new ContainerAgentLauncher({
    ...baseOptions,
    image: "--network=host",
    dockerBinary: "/nonexistent",
  }), /image is invalid/u);
  assert.throws(() => new ContainerAgentLauncher({
    ...baseOptions,
    agentCommand: "--evil",
    dockerBinary: "/nonexistent",
  }), /agentCommand is invalid/u);
  assert.doesNotThrow(() => new ContainerAgentLauncher({
    ...baseOptions,
    image: "steward-agent:abc123",
    dockerBinary: "/nonexistent",
  }));
  assert.doesNotThrow(() => new ContainerAgentLauncher({
    ...baseOptions,
    image: "node:24-alpine",
    dockerBinary: "/nonexistent",
  }));
});

test("rejects a launch without a per-launch workspace before spawning docker", async () => {
  const launcher = new ContainerAgentLauncher({
    ...baseOptions,
    dockerBinary: "/nonexistent",
  });

  await assert.rejects(
    launcher.launch({
      runId: "run-without-workspace",
      wakeReason: "human_assignment",
      context: context(),
    }),
    (error: unknown) => error instanceof AgentProcessError && error.message === "Container launches require a per-launch workspace",
  );
});
