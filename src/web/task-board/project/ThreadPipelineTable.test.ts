import { describe, expect, it } from 'vitest';
import { pipelineStageForStatus } from './ThreadPipelineTable';
import type { TaskStatus } from '../types';

describe('pipelineStageForStatus', () => {
  it.each([
    ['queued', { label: 'Queued', tone: 'purple' }],
    ['backlog', { label: 'Queued', tone: 'purple' }],
    ['proposed', { label: 'Queued', tone: 'purple' }],
    ['running', { label: 'Agent Working', tone: 'blue' }],
    ['waiting_for_human', { label: 'Awaiting Review', tone: 'amber' }],
    ['blocked', { label: 'Changes Requested', tone: 'red' }],
    ['failed', { label: 'Changes Requested', tone: 'red' }],
    ['interrupted', { label: 'Changes Requested', tone: 'red' }],
    ['completed', { label: 'Merged', tone: 'green' }],
  ] satisfies Array<[TaskStatus, ReturnType<typeof pipelineStageForStatus>]>)('maps %s to its workspace stage', (status, stage) => {
    expect(pipelineStageForStatus(status)).toEqual(stage);
  });
});
