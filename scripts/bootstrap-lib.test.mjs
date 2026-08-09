import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  expandedAgentProfiles,
  mergeAutomationConfiguration,
  projectDescription,
  sameEditableAutomation,
  validateCatalog,
} from './bootstrap-lib.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(await readFile(resolve(directory, '../catalog/company-bootstrap.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(resolve(directory, '../package.json'), 'utf8'));

test('the checked-in company catalog satisfies board constraints', () => {
  assert.equal(validateCatalog(structuredClone(catalog)).version, 1);
  assert.equal(expandedAgentProfiles(catalog).length, catalog.projects.length * 3);
  assert.match(projectDescription(catalog.projects[0]), /^Summary:/u);
});

test('automation merge retains unknown immutable types and adds desired types', () => {
  const legacy = {
    agentTypeId: 'legacy-reader',
    name: 'Legacy reader',
    description: 'Existing type',
    role: 'verifier',
    supplementalInstructions: '',
    skillIds: [],
    evaluatorProfile: 'manual',
    enabled: false,
  };
  const remote = { agentTypes: [legacy], stages: [] };
  const merged = mergeAutomationConfiguration(remote, catalog.agentTypes, catalog.stages);
  assert.equal(merged.agentTypes[0], legacy);
  assert.equal(merged.agentTypes.length, catalog.agentTypes.length + 1);
  assert.equal(sameEditableAutomation(remote, merged), false);
});

test('automation merge rejects immutable role drift', () => {
  const desired = catalog.agentTypes[0];
  assert.throws(() => mergeAutomationConfiguration({
    agentTypes: [{ ...desired, role: desired.role === 'manager' ? 'engineer' : 'manager' }],
    stages: [],
  }, catalog.agentTypes, catalog.stages), /role is immutable/u);
});

test('read-only bootstrap commands compile the contract without cleaning the runtime build', async () => {
  assert.match(packageJson.scripts['bootstrap:validate'], /^npm run build:bootstrap-contract && /u);
  assert.match(packageJson.scripts['test:bootstrap'], /^npm run build:bootstrap-contract && /u);
  assert.doesNotMatch(packageJson.scripts['build:bootstrap-contract'], /clean|rmSync/u);
  assert.doesNotMatch(packageJson.scripts['bootstrap:validate'], /build:runtime|clean:runtime/u);
  assert.doesNotMatch(packageJson.scripts['test:bootstrap'], /build:runtime|clean:runtime/u);

  const source = await readFile(resolve(directory, './bootstrap-lib.mjs'), 'utf8');
  assert.match(source, /AUTOMATION_CONFIGURATION_MAX_BYTES/u);
  assert.doesNotMatch(source, /aggregateBytes <= 48 \* 1_024/u);
});
