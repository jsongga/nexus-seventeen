import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeAgentImageTag } from "#server/agents/task-container";

test("computes a stable content-addressed agent image tag", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-agent-image-tag-"));
  const agentDir = join(root, "deploy", "agent");
  const serverDir = join(root, "src", "server", "agents");
  const sharedDir = join(root, "src", "shared");
  await mkdir(agentDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });
  await writeFile(join(root, "package-lock.json"), "lock-v1\n");
  await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(root, "tsconfig.runtime.json"), "{}\n");
  await writeFile(join(agentDir, "a.sh"), "#!/bin/sh\n");
  await writeFile(join(serverDir, "worker.ts"), "export const worker = 1;\n");
  await writeFile(join(sharedDir, "result.ts"), "export const result = 1;\n");
  await writeFile(join(root, "README.md"), "fixture readme v1\n");

  const initial = await computeAgentImageTag(root);
  assert.match(initial, /^[0-9a-f]{12}$/u);
  assert.equal(await computeAgentImageTag(root), initial);
  assert.equal(await computeAgentImageTag(`${root}/`), initial);

  await writeFile(join(root, "package-lock.json"), "lock-v2\n");
  const afterLockfileChange = await computeAgentImageTag(root);
  assert.notEqual(afterLockfileChange, initial);

  await writeFile(join(agentDir, "a.sh"), "#!/bin/sh\necho changed\n");
  const afterAgentChange = await computeAgentImageTag(root);
  assert.notEqual(afterAgentChange, afterLockfileChange);

  await writeFile(join(root, "README.md"), "fixture readme v2\n");
  assert.equal(await computeAgentImageTag(root), afterAgentChange);

  await writeFile(join(serverDir, "worker.ts"), "export const worker = 2;\n");
  assert.notEqual(await computeAgentImageTag(root), afterAgentChange);
});
