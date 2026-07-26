import type { AgentRole, Capability, RoleKey, RoleTemplate } from './types';

export const AGENT_ROLE_KEYS = Object.freeze([
  'manager',
  'engineer',
  'verifier',
] as const satisfies readonly AgentRole[]);

export const FORBIDDEN_AGENT_PRODUCTION_CAPABILITIES = Object.freeze([
  'production.approve',
  'production.consume_approval',
  'production.deploy',
] as const satisfies readonly Capability[]);

export const BROAD_DEVELOPMENT_CAPABILITIES = Object.freeze([
  'project.read',
  'task.comment',
  'repository.read',
  'repository.write',
  'command.execute',
  'dependency.install',
  'network.development',
  'preview.launch',
  'test.run',
  'artifact.create',
] as const satisfies readonly Capability[]);

function fixedRole(
  template: Omit<RoleTemplate, 'fixed' | 'capabilities'> & {
    readonly capabilities: readonly Capability[];
  },
): RoleTemplate {
  return Object.freeze({
    ...template,
    fixed: true as const,
    capabilities: Object.freeze([...template.capabilities]),
  });
}

export const ROLE_TEMPLATES = Object.freeze({
  manager: fixedRole({
    key: 'manager',
    title: 'Manager',
    summary:
      'Plans work, reviews completed engineering loops, and posts accepted releases for human checking.',
    principalKind: 'agent',
    capabilities: [
      'project.read',
      'task.plan',
      'task.assign',
      'task.comment',
      'repository.read',
      'command.execute',
      'test.run',
      'artifact.create',
      'artifact.review',
      'release.assemble',
      'production.request_approval',
    ],
  }),
  engineer: fixedRole({
    key: 'engineer',
    title: 'Engineer',
    summary:
      'Works freely in development while recording each Research, Plan, Execute, and Test transition.',
    principalKind: 'agent',
    capabilities: BROAD_DEVELOPMENT_CAPABILITIES,
  }),
  verifier: fixedRole({
    key: 'verifier',
    title: 'Verifier',
    summary: 'Runs deterministic checks and records evidence against acceptance criteria.',
    principalKind: 'agent',
    capabilities: [
      'project.read',
      'task.comment',
      'repository.read',
      'command.execute',
      'network.development',
      'preview.launch',
      'test.run',
      'artifact.create',
      'artifact.review',
    ],
  }),
  human_approver: fixedRole({
    key: 'human_approver',
    title: 'Human Approver',
    summary: 'Owns production decisions; approval is never delegated to an agent.',
    principalKind: 'human',
    capabilities: [
      'project.read',
      'agent.work.queue',
      'agent.run.interrupt',
      'agent.run.resume',
      'task.assign',
      'task.comment',
      'artifact.review',
      'production.approve',
    ],
  }),
} satisfies Record<RoleKey, RoleTemplate>);

export function hasCapability(role: RoleKey, capability: Capability): boolean {
  return ROLE_TEMPLATES[role].capabilities.includes(capability);
}
