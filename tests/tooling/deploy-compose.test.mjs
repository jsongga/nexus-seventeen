/** Guards the deployment compose against silently building the wrong Dockerfile stage. */

/* —— Imports —— */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

/* —— Paths —— */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* —— Deployment build target —— */

/**
 * Compose builds the Dockerfile's LAST stage when no target is named. Appending a stage therefore
 * changes what every untargeted compose file builds, without touching that file — which is how
 * this deployment came to build the `agent` image, whose entrypoint exits immediately, between the
 * agent stage landing and the next deploy.
 */
test("the deployment compose names the Dockerfile stage it builds", async () => {
  const compose = await readFile(join(repositoryRoot, "docker-compose.dokploy.yml"), "utf8");
  const target = /^\s*target:\s*(\S+)\s*$/mu.exec(compose);
  assert.ok(target, "docker-compose.dokploy.yml must name a build target, not rely on the last stage");
  assert.equal(target[1], "runtime", "the deployment must build the board, not the agent image");
});

test("the Dockerfile still defines the stage the deployment names", async () => {
  const dockerfile = await readFile(join(repositoryRoot, "Dockerfile"), "utf8");
  const stages = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gmu)].map((match) => match[1]);
  assert.ok(stages.includes("runtime"), `Dockerfile has no 'runtime' stage; found ${stages.join(", ")}`);
  // Stated rather than asserted loosely: this is only a hazard while `runtime` is not last.
  assert.notEqual(stages.at(-1), "runtime", "if runtime became last, this guard's premise changed — revisit it");
});
