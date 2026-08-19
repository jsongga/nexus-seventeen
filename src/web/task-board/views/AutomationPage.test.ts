import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskBoardClient } from '../data/client';
import type { AutomationConfiguration } from '../types';
import { AutomationPage } from './AutomationPage';

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
});
