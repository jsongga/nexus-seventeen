import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TaskBoardClient } from '../data/client';
import type { BoardSnapshot } from '../types';
import { CreateDialogs } from './CreateDialogs';

const timestamp = '2026-08-25T12:00:00.000Z';

describe('work-item create dialog task type', () => {
  it('offers standard and onboarding with standard selected by default', () => {
    const snapshot: BoardSnapshot = {
      revision: 1,
      generatedAt: timestamp,
      generatedAtMs: Date.parse(timestamp),
      projects: [{
        id: 'project-one',
        name: 'Project one',
        description: '/workspace/project-one',
        createdAt: timestamp,
        createdAtMs: Date.parse(timestamp),
        updatedAt: timestamp,
        updatedAtMs: Date.parse(timestamp),
      }],
      agents: [],
      tasks: [],
      messages: [],
      questions: [],
      runs: [],
      workItems: [],
      documents: [],
    };
    const markup = renderToStaticMarkup(createElement(CreateDialogs, {
      client: {} as TaskBoardClient,
      dialog: 'task',
      closeDialog: vi.fn(),
      projectFormDirty: { current: false },
      workItemFormDirty: { current: false },
      dialogProject: snapshot.projects[0],
      snapshot,
      busy: false,
      connected: true,
      projectCreateErrors: [],
      workItemCreateErrors: [],
      dismissActionError: vi.fn(),
      createProject: vi.fn(),
      createWorkItem: vi.fn(),
    }));

    expect(markup).toContain('for="work-item-task-type"');
    expect(markup).toContain('>Task type</label>');
    expect(markup).toContain('<option value="standard" selected="">Standard</option>');
    expect(markup).toContain('<option value="onboarding">Onboarding</option>');
  });
});
