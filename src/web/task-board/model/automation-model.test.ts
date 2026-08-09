import { describe, expect, it } from 'vitest';
import {
  acceptRemoteAutomationConfiguration,
  automationEditorFromConfiguration,
  automationEditorIsDirty,
  ClientOperationGate,
  reconcileAutomationConfiguration,
} from './automation-model';
import type { AutomationConfiguration } from '../types';

function configuration(version = 1): AutomationConfiguration {
  return {
    id: 'company-default',
    agentTypes: [{
      id: 'workflow-manager',
      name: 'Workflow manager',
      description: 'Refines and routes work.',
      role: 'manager',
      supplementalInstructions: 'Keep the original request and make routing decisions explicit.',
      skillIds: ['task-refinement'],
      evaluatorProfile: 'editorial',
      enabled: true,
    }],
    stages: [
      { stage: 'refinement', executor: { kind: 'agent_type', agentTypeId: 'workflow-manager' } },
      { stage: 'project_resolution', executor: { kind: 'agent_type', agentTypeId: 'workflow-manager' } },
      { stage: 'research', executor: { kind: 'disabled' } },
      { stage: 'planning', executor: { kind: 'disabled' } },
      { stage: 'implementation', executor: { kind: 'disabled' } },
      { stage: 'testing', executor: { kind: 'disabled' } },
      { stage: 'verification', executor: { kind: 'disabled' } },
      { stage: 'human_review', executor: { kind: 'human' } },
      { stage: 'deployment', executor: { kind: 'disabled' } },
    ],
    version,
    createdAt: '2026-07-19T10:00:00.000Z',
    createdAtMs: Date.parse('2026-07-19T10:00:00.000Z'),
    updatedAt: `2026-07-19T10:${version.toString().padStart(2, '0')}:00.000Z`,
    updatedAtMs: Date.parse(`2026-07-19T10:${version.toString().padStart(2, '0')}:00.000Z`),
    updatedBy: 'human:operator',
  };
}

function dirtyState() {
  const state = automationEditorFromConfiguration(configuration());
  return {
    ...state,
    draft: {
      ...state.draft!,
      agentTypes: state.draft!.agentTypes.map((agentType) => ({
        ...agentType,
        description: 'Locally refined purpose that has not been saved.',
      })),
    },
  };
}

describe('automation editor reconciliation', () => {
  it('adopts a reconnect read when there is no local draft change', () => {
    const current = automationEditorFromConfiguration(configuration());
    const next = reconcileAutomationConfiguration(current, configuration(2));

    expect(next.saved?.version).toBe(2);
    expect(next.draft?.version).toBe(2);
    expect(next.remote).toBeNull();
  });

  it('preserves a dirty draft when navigation or reconnect reloads the same base version', () => {
    const current = dirtyState();
    const next = reconcileAutomationConfiguration(current, configuration());

    expect(next).toBe(current);
    expect(next.draft?.agentTypes[0]?.description).toContain('Locally refined');
    expect(automationEditorIsDirty(next)).toBe(true);
  });

  it('preserves a dirty draft and retains a newer remote version for explicit reload', () => {
    const current = dirtyState();
    const next = reconcileAutomationConfiguration(current, configuration(2));

    expect(next.saved?.version).toBe(1);
    expect(next.draft?.agentTypes[0]?.description).toContain('Locally refined');
    expect(next.remote?.version).toBe(2);

    const reloaded = acceptRemoteAutomationConfiguration(next);
    expect(reloaded.saved?.version).toBe(2);
    expect(reloaded.draft?.version).toBe(2);
    expect(reloaded.remote).toBeNull();
    expect(automationEditorIsDirty(reloaded)).toBe(false);
  });
});

describe('client operation gate', () => {
  it('fences a parent editor dispatch as soon as its connection identity changes', async () => {
    const connectionA = { baseUrl: '/board-a', token: 'a' };
    const connectionB = { baseUrl: '/board-b', token: 'b' };
    const gate = new ClientOperationGate(connectionA);
    let editor = 'draft from A';
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const dispatchFrom = (connection: typeof connectionA, value: string) => {
      if (gate.isActiveFor(connection)) editor = value;
    };
    const staleCompletion = pending.then(() => dispatchFrom(connectionA, 'saved response from A'));

    gate.activate(connectionB);
    editor = 'empty for B';
    release();
    await staleCompletion;

    expect(editor).toBe('empty for B');
    dispatchFrom(connectionB, 'loaded from B');
    expect(editor).toBe('loaded from B');

    const reconnectedA = { baseUrl: '/board-a', token: 'a' };
    gate.activate(reconnectedA);
    dispatchFrom(connectionA, 'old A response after reconnect');
    expect(editor).toBe('loaded from B');
    dispatchFrom(reconnectedA, 'loaded from reconnected A');
    expect(editor).toBe('loaded from reconnected A');
  });

  it('rejects a client A completion after the editor receives client B', async () => {
    const clientA = {};
    const clientB = {};
    const gate = new ClientOperationGate(clientA);
    const token = gate.begin();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let applied = false;
    const completion = pending.then(() => {
      if (gate.isCurrent(token)) applied = true;
    });

    gate.activate(clientB);
    release();
    await completion;

    expect(applied).toBe(false);
    const clientBToken = gate.begin();
    expect(gate.isCurrent(clientBToken)).toBe(true);
  });

  it('rejects completions after unmount and after a newer same-client operation', () => {
    const client = {};
    const gate = new ClientOperationGate(client);
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);

    gate.deactivate();
    expect(gate.isCurrent(second)).toBe(false);
  });
});
