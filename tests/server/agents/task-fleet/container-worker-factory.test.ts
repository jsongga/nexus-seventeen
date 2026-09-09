import assert from "node:assert/strict";
import test from "node:test";
import { captureContainerRuntimeVersion } from "#server/agents/task-fleet/worker-factory";

test("captures the runtime CLI label and immutable container image identity", async () => {
  const calls: Array<{ command: string; arguments_: readonly string[] }> = [];
  const captured = await captureContainerRuntimeVersion("codex", "steward-agent:test", async (command, arguments_) => {
    calls.push({ command, arguments_ });
    return "1.2.3|sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n";
  });

  assert.deepEqual(captured, {
    runtimeVersion: "1.2.3+abcdef012345",
    imageId: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  });
  assert.deepEqual(calls, [
    {
      command: "docker",
      arguments_: [
        "image",
        "inspect",
        "-f",
        '{{index .Config.Labels "steward.cli.codex"}}|{{.Id}}',
        "steward-agent:test",
      ],
    },
  ]);
});

test("treats Docker inspection failures and unsafe identity output as unavailable", async () => {
  assert.equal(
    await captureContainerRuntimeVersion("claude", "steward-agent:test", async () => {
      throw new Error("missing");
    }),
    null
  );
  assert.equal(
    await captureContainerRuntimeVersion(
      "claude",
      "steward-agent:test",
      async () => "1.2.3\u0000|sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n"
    ),
    null
  );
});
