#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  expandedAgentProfiles,
  loadCatalog,
  mergeAutomationConfiguration,
  projectDescription,
  sameEditableAutomation,
} from './bootstrap-lib.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(directory, '../catalog/company-bootstrap.json');
const apply = process.argv.includes('--apply');
const validateOnly = process.argv.includes('--validate') || !apply;
const baseUrl = (process.env.STEWARD_BOARD_URL ?? 'https://steward.cicadasystem.com/board-api').replace(/\/$/u, '');
const operatorToken = process.env.STEWARD_OPERATOR_TOKEN;
const keychainService = process.env.STEWARD_AGENT_KEYCHAIN_SERVICE ?? 'cicada-steward-agent-token';

function log(message) {
  process.stdout.write(`${message}\n`);
}

function credential(account) {
  try {
    return execFileSync('security', ['find-generic-password', '-a', account, '-s', keychainService, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function createCredential(account) {
  if (process.platform !== 'darwin') {
    throw new Error('Agent creation currently requires macOS Keychain; no plaintext fallback is allowed');
  }
  const token = randomBytes(48).toString('base64url');
  execFileSync('security', ['add-generic-password', '-U', '-a', account, '-s', keychainService, '-w', token], {
    stdio: 'ignore',
  });
  return token;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${operatorToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error?.code ?? body?.code ?? `HTTP_${response.status}`;
    const error = new Error(`${options.method ?? 'GET'} ${path} failed: ${code}`);
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return body;
}

function exactAgentMatch(actual, expected, projectId) {
  return actual.projectId === projectId
    && actual.agentId === expected.agentId
    && actual.role === expected.role
    && actual.area === expected.area
    && actual.mission === expected.mission
    && actual.model === expected.model;
}

async function reconcileProjects(catalog) {
  const listed = await request('/v1/projects');
  const byKey = new Map();
  for (const project of catalog.projects) {
    const matches = listed.projects.filter((candidate) => candidate.name === project.name);
    if (matches.length > 1) throw new Error(`Project drift: ${project.name} has ${matches.length} records`);
    const description = projectDescription(project);
    let actual = matches[0];
    if (actual && actual.description !== description) {
      throw new Error(`Project drift: ${project.name} description differs and the API has no update route`);
    }
    if (!actual) {
      const created = await request('/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name: project.name, description }),
      });
      actual = created.project;
      log(`created project: ${project.name}`);
    } else {
      log(`reused project: ${project.name}`);
    }
    byKey.set(project.key, actual);
  }
  return byKey;
}

async function reconcileAgents(catalog, projectsByKey) {
  const allBoards = [];
  for (const project of projectsByKey.values()) {
    allBoards.push(await request(`/v1/projects/${encodeURIComponent(project.projectId)}/board`));
  }
  const agents = allBoards.flatMap((board) => board.agents);
  for (const expected of expandedAgentProfiles(catalog)) {
    const project = projectsByKey.get(expected.projectKey);
    let actual = agents.find((candidate) => candidate.agentId === expected.agentId);
    if (actual) {
      if (!exactAgentMatch(actual, expected, project.projectId)) throw new Error(`Agent drift: ${expected.agentId}`);
      if (!credential(expected.agentId)) throw new Error(`Agent ${expected.agentId} exists but its Keychain credential is missing`);
      log(`reused agent: ${expected.agentId}`);
      continue;
    }
    let token = credential(expected.agentId);
    if (!token) token = createCredential(expected.agentId);
    try {
      const created = await request(`/v1/projects/${encodeURIComponent(project.projectId)}/agents`, {
        method: 'POST',
        body: JSON.stringify({
          agentId: expected.agentId,
          role: expected.role,
          area: expected.area,
          mission: expected.mission,
          model: expected.model,
          token,
        }),
      });
      actual = created.agent;
    } catch (error) {
      if (error.status !== 409) throw error;
      const refreshed = await request(`/v1/projects/${encodeURIComponent(project.projectId)}/board`);
      actual = refreshed.agents.find((candidate) => candidate.agentId === expected.agentId);
    }
    if (!actual || !exactAgentMatch(actual, expected, project.projectId)) throw new Error(`Agent reconciliation failed: ${expected.agentId}`);
    agents.push(actual);
    log(`created agent: ${expected.agentId}`);
  }
}

async function reconcileAutomation(catalog) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await request('/v1/automation-configuration');
    const remote = response.configuration;
    const desired = mergeAutomationConfiguration(remote, catalog.agentTypes, catalog.stages);
    if (sameEditableAutomation(remote, desired)) {
      log(`reused automation configuration: version ${remote.version}`);
      return;
    }
    try {
      const updated = await request('/v1/automation-configuration', {
        method: 'PATCH',
        body: JSON.stringify({ version: remote.version, ...desired }),
      });
      log(`updated automation configuration: version ${updated.configuration.version}`);
      return;
    } catch (error) {
      if (error.code !== 'AUTOMATION_CONFIGURATION_VERSION_CONFLICT' || attempt === 3) throw error;
    }
  }
}

const catalog = await loadCatalog(catalogPath);
log(`catalog valid: ${catalog.projects.length} projects, ${expandedAgentProfiles(catalog).length} project agents, ${catalog.agentTypes.length} agent types`);
if (validateOnly && !apply) process.exit(0);
if (!operatorToken || operatorToken.length < 32) throw new Error('Set STEWARD_OPERATOR_TOKEN to apply the catalog');

const projectsByKey = await reconcileProjects(catalog);
await reconcileAgents(catalog, projectsByKey);
await reconcileAutomation(catalog);
log('company bootstrap reconciled');
