import { describe, expect, it } from 'vitest';
import { parseTaskProposal, proposalChildInput, proposalIsOnBoard } from './proposals';
import type { BoardTask } from '../types';

const parent: BoardTask = {
  id: 'parent-completed',
  projectId: 'project-one',
  parentTaskId: null,
  kind: 'work',
  requiredRole: null,
  requiresReview: true,
  title: 'Completed improvement',
  objective: 'The original improvement is complete.',
  acceptanceCriteria: 'Original checks pass.',
  workspaceRefs: ['/workspace/billing', 'packages/recovery'],
  assignedAgentId: 'billing-engineer',
  assignedRole: 'engineer',
  status: 'completed',
  expectedAgentMinutes: 30,
  estimateRecordedAt: '2026-07-19T10:00:00.000Z',
  estimateRecordedAtMs: Date.parse('2026-07-19T10:00:00.000Z'),
  expectedCompletedAt: '2026-07-19T10:30:00.000Z',
  expectedCompletedAtMs: Date.parse('2026-07-19T10:30:00.000Z'),
  orderKey: 0,
  phases: [],
  startedAt: '2026-07-19T10:00:00.000Z',
  startedAtMs: Date.parse('2026-07-19T10:00:00.000Z'),
  endedAt: '2026-07-19T10:20:00.000Z',
  endedAtMs: Date.parse('2026-07-19T10:20:00.000Z'),
  result: 'The original improvement is ready for review.',
  version: 2,
  createdAt: '2026-07-19T09:45:00.000Z',
  createdAtMs: Date.parse('2026-07-19T09:45:00.000Z'),
  updatedAt: '2026-07-19T10:20:00.000Z',
  updatedAtMs: Date.parse('2026-07-19T10:20:00.000Z'),
};

describe('agent task proposals', () => {
  it('parses the worker proposal shape and formats criteria for a human-readable todo', () => {
    expect(parseTaskProposal(JSON.stringify({
      title: 'Explain recovery failures',
      objective: 'Customers understand how to recover.',
      acceptanceCriteria: ['The failure state explains the next step.', 'Focused tests pass.'],
    }))).toEqual({
      title: 'Explain recovery failures',
      objective: 'Customers understand how to recover.',
      acceptanceCriteria: '- The failure state explains the next step.\n- Focused tests pass.',
    });
  });

  it('rejects malformed, incomplete, and unbounded proposal messages', () => {
    expect(parseTaskProposal('not json')).toBeNull();
    expect(parseTaskProposal(JSON.stringify({ title: 'Missing fields' }))).toBeNull();
    expect(parseTaskProposal(JSON.stringify({
      title: 'Unsafe\nmultiline title',
      objective: 'Objective',
      acceptanceCriteria: 'Done',
    }))).toBeNull();
    expect(parseTaskProposal(JSON.stringify({
      title: 'x'.repeat(513),
      objective: 'Objective',
      acceptanceCriteria: 'Done',
    }))).toBeNull();
  });

  it('creates an unassigned child input from a completed parent without mutating its scope', () => {
    const proposal = parseTaskProposal(JSON.stringify({
      title: 'Explain recovery failures',
      objective: 'Customers understand how to recover.',
      acceptanceCriteria: 'The next step is clear and tested.',
    }));
    expect(proposal).not.toBeNull();
    const input = proposalChildInput(parent, proposal!);
    expect(input).toEqual({
      projectId: 'project-one',
      parentTaskId: 'parent-completed',
      title: 'Explain recovery failures',
      objective: 'Customers understand how to recover.',
      acceptanceCriteria: 'The next step is clear and tested.',
      workspaceRefs: ['/workspace/billing', 'packages/recovery'],
    });
    input.workspaceRefs.pop();
    expect(parent.workspaceRefs).toHaveLength(2);
  });

  it('recognizes an already-promoted child so the UI does not create duplicates', () => {
    const proposal = {
      title: 'Explain recovery failures',
      objective: 'Customers understand how to recover.',
      acceptanceCriteria: 'The next step is clear and tested.',
    };
    const child: BoardTask = {
      ...parent,
      ...proposal,
      id: 'child-one',
      parentTaskId: parent.id,
      assignedAgentId: null,
      assignedRole: null,
      status: 'backlog',
      expectedCompletedAt: null,
      expectedCompletedAtMs: null,
      startedAt: null,
      startedAtMs: null,
      endedAt: null,
      endedAtMs: null,
      result: null,
      expectedAgentMinutes: null,
      estimateRecordedAt: null,
      estimateRecordedAtMs: null,
      phases: [],
      workspaceRefs: [...parent.workspaceRefs],
    };
    expect(proposalIsOnBoard(parent, proposal, [parent, child])).toBe(true);
    expect(proposalIsOnBoard(parent, { ...proposal, title: 'Different work' }, [parent, child])).toBe(false);
  });
});
