import { readFile } from 'node:fs/promises';
import {
  AGENT_ROLES,
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  EVALUATOR_PROFILES,
  IDENTIFIER_PATTERN,
  WORK_ITEM_STAGES,
} from '#shared/task-board-contract';

const identifierPattern = new RegExp(IDENTIFIER_PATTERN, 'u');
const skillIdentifierPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const roles = new Set(AGENT_ROLES);
const evaluatorProfiles = new Set(EVALUATOR_PROFILES);
const stageOrder = WORK_ITEM_STAGES;
const allowedStageRoles = {
  refinement: new Set(['manager']),
  project_resolution: new Set(['manager']),
  research: new Set(['engineer', 'verifier']),
  planning: new Set(['engineer']),
  implementation: new Set(['engineer']),
  testing: new Set(['engineer', 'verifier']),
  verification: new Set(['verifier']),
};

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid company bootstrap: ${message}`);
}

function exactKeys(value, expected, path) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${path} must contain exactly ${wanted.join(', ')}`);
}

function boundedText(value, maximum, path) {
  assert(typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum, `${path} must be 1-${maximum} trimmed characters`);
}

export function projectDescription(project) {
  return [`Summary: ${project.summary}`, ...project.resources.map((resource) => `${resource.label}: ${resource.value}`)].join('\n');
}

export function expandedAgentProfiles(catalog) {
  return catalog.projects.flatMap((project) => catalog.projectAgentProfiles.map((profile) => ({
    projectKey: project.key,
    agentId: `${project.key}/${profile.suffix}`,
    role: profile.role,
    area: `${project.name} — ${profile.area}`,
    mission: profile.mission,
    model: 'auto',
  })));
}

export function validateCatalog(catalog) {
  exactKeys(catalog, ['version', 'projects', 'projectAgentProfiles', 'agentTypes', 'stages'], 'catalog');
  assert(catalog.version === 1, 'version must be 1');
  assert(Array.isArray(catalog.projects) && catalog.projects.length > 0, 'projects must be a nonempty array');
  assert(Array.isArray(catalog.projectAgentProfiles) && catalog.projectAgentProfiles.length > 0, 'projectAgentProfiles must be a nonempty array');
  assert(Array.isArray(catalog.agentTypes) && catalog.agentTypes.length <= 32, 'agentTypes must contain at most 32 entries');
  assert(Array.isArray(catalog.stages) && catalog.stages.length === stageOrder.length, 'stages must contain every canonical stage');

  const projectKeys = new Set();
  const projectNames = new Set();
  for (const [index, project] of catalog.projects.entries()) {
    exactKeys(project, ['key', 'name', 'summary', 'resources'], `projects[${index}]`);
    boundedText(project.key, 80, `projects[${index}].key`);
    assert(/^[a-z0-9][a-z0-9-]*$/u.test(project.key), `projects[${index}].key must be lowercase kebab-case`);
    boundedText(project.name, 160, `projects[${index}].name`);
    boundedText(project.summary, 2_000, `projects[${index}].summary`);
    assert(!projectKeys.has(project.key), `duplicate project key ${project.key}`);
    assert(!projectNames.has(project.name), `duplicate project name ${project.name}`);
    projectKeys.add(project.key);
    projectNames.add(project.name);
    assert(Array.isArray(project.resources), `projects[${index}].resources must be an array`);
    for (const [resourceIndex, resource] of project.resources.entries()) {
      exactKeys(resource, ['label', 'value'], `projects[${index}].resources[${resourceIndex}]`);
      boundedText(resource.label, 80, `projects[${index}].resources[${resourceIndex}].label`);
      boundedText(resource.value, 2_000, `projects[${index}].resources[${resourceIndex}].value`);
      assert(!/[\r\n]/u.test(resource.label + resource.value), `projects[${index}].resources[${resourceIndex}] cannot contain line breaks`);
    }
    boundedText(projectDescription(project), 8_000, `projects[${index}] description`);
  }

  const profileSuffixes = new Set();
  for (const [index, profile] of catalog.projectAgentProfiles.entries()) {
    exactKeys(profile, ['suffix', 'role', 'area', 'mission'], `projectAgentProfiles[${index}]`);
    boundedText(profile.suffix, 80, `projectAgentProfiles[${index}].suffix`);
    assert(/^[a-z0-9][a-z0-9-]*$/u.test(profile.suffix), `projectAgentProfiles[${index}].suffix must be lowercase kebab-case`);
    assert(roles.has(profile.role), `projectAgentProfiles[${index}].role is invalid`);
    boundedText(profile.area, 200, `projectAgentProfiles[${index}].area`);
    boundedText(profile.mission, 4_000, `projectAgentProfiles[${index}].mission`);
    assert(!profileSuffixes.has(profile.suffix), `duplicate profile suffix ${profile.suffix}`);
    profileSuffixes.add(profile.suffix);
  }
  for (const profile of expandedAgentProfiles(catalog)) {
    assert(identifierPattern.test(profile.agentId), `expanded agent ID ${profile.agentId} is invalid`);
    boundedText(profile.area, 256, `expanded agent ${profile.agentId} area`);
  }

  const agentTypeById = new Map();
  for (const [index, agentType] of catalog.agentTypes.entries()) {
    exactKeys(agentType, ['agentTypeId', 'name', 'description', 'role', 'supplementalInstructions', 'skillIds', 'evaluatorProfile', 'enabled'], `agentTypes[${index}]`);
    assert(identifierPattern.test(agentType.agentTypeId), `agentTypes[${index}].agentTypeId is invalid`);
    boundedText(agentType.name, 160, `agentTypes[${index}].name`);
    boundedText(agentType.description, 4_000, `agentTypes[${index}].description`);
    assert(roles.has(agentType.role), `agentTypes[${index}].role is invalid`);
    assert(typeof agentType.supplementalInstructions === 'string' && agentType.supplementalInstructions.length <= 8_000, `agentTypes[${index}].supplementalInstructions is invalid`);
    assert(!agentType.enabled || agentType.supplementalInstructions.trim().length > 0, `enabled agentTypes[${index}] requires instructions`);
    assert(Array.isArray(agentType.skillIds) && agentType.skillIds.length <= 32, `agentTypes[${index}].skillIds is invalid`);
    assert(agentType.skillIds.every((skillId) => skillIdentifierPattern.test(skillId)), `agentTypes[${index}] has an invalid skill ID`);
    assert(new Set(agentType.skillIds).size === agentType.skillIds.length, `agentTypes[${index}] has duplicate skill IDs`);
    assert(evaluatorProfiles.has(agentType.evaluatorProfile), `agentTypes[${index}].evaluatorProfile is invalid`);
    assert(typeof agentType.enabled === 'boolean', `agentTypes[${index}].enabled must be boolean`);
    assert(!agentTypeById.has(agentType.agentTypeId), `duplicate agent type ${agentType.agentTypeId}`);
    agentTypeById.set(agentType.agentTypeId, agentType);
  }

  for (const [index, entry] of catalog.stages.entries()) {
    exactKeys(entry, ['stage', 'executor'], `stages[${index}]`);
    assert(entry.stage === stageOrder[index], `stages[${index}] must be ${stageOrder[index]}`);
    assert(entry.executor !== null && typeof entry.executor === 'object' && !Array.isArray(entry.executor), `stages[${index}].executor must be an object`);
    if (entry.stage === 'human_review') {
      exactKeys(entry.executor, ['kind'], `stages[${index}].executor`);
      assert(entry.executor.kind === 'human', 'human_review must remain human');
      continue;
    }
    if (entry.stage === 'deployment') {
      exactKeys(entry.executor, ['kind'], `stages[${index}].executor`);
      assert(entry.executor.kind === 'disabled', 'deployment must remain disabled');
      continue;
    }
    exactKeys(entry.executor, ['kind', 'agentTypeId'], `stages[${index}].executor`);
    assert(entry.executor.kind === 'agent_type', `stages[${index}] must use an agent type`);
    const agentType = agentTypeById.get(entry.executor.agentTypeId);
    assert(agentType?.enabled, `stages[${index}] references a missing or disabled agent type`);
    assert(allowedStageRoles[entry.stage].has(agentType.role), `stages[${index}] references an incompatible role`);
  }

  const aggregateBytes = Buffer.byteLength(JSON.stringify({ agentTypes: catalog.agentTypes, stages: catalog.stages }), 'utf8');
  assert(aggregateBytes <= AUTOMATION_CONFIGURATION_MAX_BYTES, 'automation configuration exceeds 48 KiB');
  return catalog;
}

export async function loadCatalog(path) {
  return validateCatalog(JSON.parse(await readFile(path, 'utf8')));
}

export function mergeAutomationConfiguration(remote, desiredAgentTypes, desiredStages) {
  const desiredById = new Map(desiredAgentTypes.map((agentType) => [agentType.agentTypeId, agentType]));
  for (const existing of remote.agentTypes) {
    const desired = desiredById.get(existing.agentTypeId);
    if (desired && desired.role !== existing.role) {
      throw new Error(`Automation drift: ${existing.agentTypeId} role is immutable (${existing.role}, wanted ${desired.role})`);
    }
  }
  const merged = remote.agentTypes.map((existing) => desiredById.get(existing.agentTypeId) ?? existing);
  const existingIds = new Set(remote.agentTypes.map((agentType) => agentType.agentTypeId));
  merged.push(...desiredAgentTypes.filter((agentType) => !existingIds.has(agentType.agentTypeId)));
  return { agentTypes: merged, stages: desiredStages };
}

export function sameEditableAutomation(remote, desired) {
  return JSON.stringify({ agentTypes: remote.agentTypes, stages: remote.stages }) === JSON.stringify(desired);
}
