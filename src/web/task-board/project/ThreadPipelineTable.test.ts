import { describe, expect, it } from 'vitest';
import { pipelineStageForStatus } from './ThreadPipelineTable';
import type { TaskStatus } from '../types';

describe('pipelineStageForStatus', () => {
  it.each([
    ['proposed', { label: 'proposed', tone: 'purple' }],
    ['backlog', { label: 'backlog', tone: 'neutral' }],
    ['queued', { label: 'queued', tone: 'blue' }],
    ['running', { label: 'running', tone: 'green' }],
    ['waiting_for_human', { label: 'waiting for human', tone: 'amber' }],
    ['blocked', { label: 'blocked', tone: 'amber' }],
    ['completed', { label: 'completed', tone: 'green' }],
    ['failed', { label: 'failed', tone: 'red' }],
    ['interrupted', { label: 'interrupted', tone: 'red' }],
    ['cancelled', { label: 'cancelled', tone: 'neutral' }],
  ] satisfies Array<[TaskStatus, ReturnType<typeof pipelineStageForStatus>]>)('maps %s to its workspace stage', (status, stage) => {
    expect(pipelineStageForStatus(status)).toEqual(stage);
  });
});
