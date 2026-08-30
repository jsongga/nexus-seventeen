import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  expandedAgentProfiles,
  mergeAutomationConfiguration,
  projectCatalogPatch,
  projectDescription,
  sameEditableAutomation,
  validateCatalog,
} from "../../scripts/bootstrap-lib.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(await readFile(resolve(directory, "../../config/company-bootstrap.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(directory, "../../package.json"), "utf8"));

test("the checked-in company catalog satisfies board constraints", () => {
  assert.equal(validateCatalog(structuredClone(catalog)).version, 1);
  assert.equal(expandedAgentProfiles(catalog).length, catalog.projects.length * 3);
  assert.match(projectDescription(catalog.projects[0]), /^Summary:/u);
  assert.ok(catalog.projects.every((project) => typeof project.repoPath === "string"));
});

test("catalog projects require an explicit repository path", () => {
  const missing = structuredClone(catalog);
  delete missing.projects[0].repoPath;
  assert.throws(
    () => validateCatalog(missing),
    /projects\[0\] must contain exactly key, name, repoPath, resources, summary/u
  );
});

test("catalog reconciliation repairs description and repository-path drift", () => {
  const desired = catalog.projects[0];
  assert.deepEqual(
    projectCatalogPatch(
      {
        name: desired.name,
        description: "Backfilled legacy description",
        repoPath: "/legacy/host/path",
      },
      desired
    ),
    {
      description: projectDescription(desired),
      repoPath: desired.repoPath,
    }
  );
  assert.equal(
    projectCatalogPatch(
      {
        name: desired.name,
        description: projectDescription(desired),
        repoPath: desired.repoPath,
      },
      desired
    ),
    null
  );
});

test("automation merge retains unknown immutable types and adds desired types", () => {
  const legacy = {
    agentTypeId: "legacy-reader",
    name: "Legacy reader",
    description: "Existing type",
    role: "verifier",
    supplementalInstructions: "",
    skillIds: [],
    evaluatorProfile: "manual",
    enabled: false,
  };
  const remote = { agentTypes: [legacy], stages: [] };
  const merged = mergeAutomationConfiguration(remote, catalog.agentTypes, catalog.stages);
  assert.equal(merged.agentTypes[0], legacy);
  assert.equal(merged.agentTypes.length, catalog.agentTypes.length + 1);
  assert.equal(sameEditableAutomation(remote, merged), false);
});

test("automation merge rejects immutable role drift", () => {
  const desired = catalog.agentTypes[0];
  assert.throws(
    () =>
      mergeAutomationConfiguration(
        {
          agentTypes: [{ ...desired, role: desired.role === "manager" ? "engineer" : "manager" }],
          stages: [],
        },
        catalog.agentTypes,
        catalog.stages
      ),
    /role is immutable/u
  );
});

test("bootstrap commands compile the runtime without cleaning its build", async () => {
  assert.match(packageJson.scripts["bootstrap:validate"], /^npm run build:runtime:fast && /u);
  assert.match(packageJson.scripts["bootstrap:apply"], /^npm run build:runtime:fast && /u);
  assert.doesNotMatch(packageJson.scripts["bootstrap:validate"], /clean:runtime/u);
  assert.doesNotMatch(packageJson.scripts["bootstrap:apply"], /clean:runtime/u);

  const source = await readFile(resolve(directory, "../../scripts/bootstrap-lib.mjs"), "utf8");
  assert.match(source, /AUTOMATION_CONFIGURATION_MAX_BYTES/u);
  assert.doesNotMatch(source, /aggregateBytes <= 48 \* 1_024/u);
});
