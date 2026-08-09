import { describe, expect, it } from 'vitest';
import { pipelineStageForStatus, updatedLabel } from './ThreadPipelineTable';
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

describe('updatedLabel', () => {
  it('formats equivalent offset and Z timestamps from their ISO values', () => {
    const offset = '2026-07-19T12:00:00+02:00';
    const utc = '2026-07-19T10:00:00Z';

    expect(updatedLabel(offset)).toBe(updatedLabel(utc));
  });

  it('keeps the existing invalid-date fallback', () => {
    expect(updatedLabel('not-a-timestamp')).toBe('not-a-timestamp');
  });
});
