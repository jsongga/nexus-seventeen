import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { nodeCommandRunner, ProviderCommandError } from "#server/agents/cli-provider-adapter/process";

test("node command runner bounds provider output", async () => {
  const controller = new AbortController();
  await assert.rejects(
    nodeCommandRunner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      cwd: tmpdir(),
      env: {},
      stdin: "prompt",
      signal: controller.signal,
      maxStdoutBytes: 1_024,
    }),
    (error: unknown) => error instanceof ProviderCommandError && /byte bound/u.test(error.message),
  );
});

test("node command runner aborts the provider CLI promptly", async () => {
  const controller = new AbortController();
  const running = nodeCommandRunner.run({
    command: process.execPath,
    args: ["-e", "setInterval(() => undefined, 1000)"],
    cwd: tmpdir(),
    env: {},
    stdin: "prompt",
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(running, (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});

test("node command runner never invokes a shell", async () => {
  const result = await nodeCommandRunner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", "$(touch should-not-run)"],
    cwd: tmpdir(),
    env: {},
    stdin: "prompt",
    signal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "$(touch should-not-run)");
});
