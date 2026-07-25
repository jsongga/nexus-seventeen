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
