import assert from "node:assert/strict";
import test from "node:test";
import { agentImage, docker, requireDocker } from "./helpers.js";

test("agent image records both bundled CLI versions", async () => {
  await requireDocker();
  const image = await agentImage();

  for (const label of ["steward.cli.codex", "steward.cli.claude"]) {
    const value = await docker(["image", "inspect", "-f", `{{index .Config.Labels "${label}"}}`, image]);
    assert.ok(value.trim().length > 0, `${label} is non-empty`);
  }
});

test("agent image includes git", async () => {
  await requireDocker();
  const image = await agentImage();

  assert.match(await docker(["run", "--rm", image, "git", "--version"]), /^git version /u);
});

test("agent image includes the result schema, dependencies, and deterministic stub", async () => {
  await requireDocker();
  const image = await agentImage();

  await docker([
    "run",
    "--rm",
    image,
    "ls",
    "/opt/steward/agent-result.schema.json",
    "/opt/steward/node_modules",
    "/usr/local/bin/steward-stub",
  ]);
});

test("agent image can run as the node user", async () => {
  await requireDocker();
  const image = await agentImage();

  assert.equal((await docker(["run", "--rm", "--user", "node", image, "id", "-u"])).trim(), "1000");
});
