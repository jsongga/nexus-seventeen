import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskBoardClient } from '../data/client';
import type { AutomationConfiguration, AutomationStageExecutor } from '../types';
import { AutomationPage, automationExecutorFromValue } from './AutomationPage';

const timestamp = '2026-08-18T12:00:00.000Z';

describe('automation executor display', () => {
  it('labels a configured machine verification executor', () => {
    const configuration: AutomationConfiguration = {
      id: 'company-default',
      agentTypes: [],
      stages: [{ stage: 'testing', executor: { kind: 'machine_verify' } }],
      version: 1,
      createdAt: timestamp,
      createdAtMs: Date.parse(timestamp),
      updatedAt: timestamp,
      updatedAtMs: Date.parse(timestamp),
      updatedBy: 'human:operator',
    };

    const markup = renderToStaticMarkup(createElement(AutomationPage, {
      client: {} as TaskBoardClient,
      connected: true,
      editorState: { saved: configuration, draft: configuration, remote: null },
      onEditorStateChange: () => undefined,
    }));

    expect(markup).toContain('Machine verify');
  });

  it.each([
    { kind: 'disabled' } as const,
    { kind: 'agent_type', agentTypeId: 'testing-verifier' } as const,
  ])('offers machine verification for testing when the saved executor is $kind', (executor) => {
    const configuration: AutomationConfiguration = {
      id: 'company-default',
      agentTypes: executor.kind === 'agent_type' ? [{
        id: 'testing-verifier',
        name: 'Testing verifier',
        description: 'Runs testing-stage checks.',
        role: 'verifier',
        supplementalInstructions: '',
        skillIds: [],
        evaluatorProfile: 'tests',
        enabled: true,
      }] : [],
      stages: [{ stage: 'testing', executor: executor as AutomationStageExecutor }],
      version: 1,
      createdAt: timestamp,
      createdAtMs: Date.parse(timestamp),
      updatedAt: timestamp,
      updatedAtMs: Date.parse(timestamp),
      updatedBy: 'human:operator',
    };

    const markup = renderToStaticMarkup(createElement(AutomationPage, {
      client: {} as TaskBoardClient,
      connected: true,
      editorState: { saved: configuration, draft: configuration, remote: null },
      onEditorStateChange: () => undefined,
    }));

    expect(markup).toContain('<option value="__machine_verify__">Machine verify</option>');
  });

  it('maps the machine-verify selection sentinel to the saved configuration payload', () => {
    expect(automationExecutorFromValue('__machine_verify__')).toEqual({ kind: 'machine_verify' });
  });

  it('renders an invalid saved timestamp verbatim', () => {
    const configuration: AutomationConfiguration = {
      id: 'company-default',
      agentTypes: [],
      stages: [],
      version: 1,
      createdAt: timestamp,
      createdAtMs: Date.parse(timestamp),
      updatedAt: 'invalid-timestamp',
      updatedAtMs: Number.NaN,
      updatedBy: 'human:operator',
    };

    const markup = renderToStaticMarkup(createElement(AutomationPage, {
      client: {} as TaskBoardClient,
      connected: true,
      editorState: { saved: configuration, draft: configuration, remote: null },
      onEditorStateChange: () => undefined,
    }));

    expect(markup).toContain('Updated invalid-timestamp by human:operator');
  });
});
