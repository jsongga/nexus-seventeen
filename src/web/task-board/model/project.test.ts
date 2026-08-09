import { describe, expect, it } from 'vitest';
import type { RawBoard, RawEvent, RawProject, RawRun } from '../data/parse';
import { normalize } from './project';

const project: RawProject = {
  projectId: 'project-one',
  name: 'Project one',
  description: 'A test project.',
  version: 1,
  createdAt: '2026-08-09T10:00:00.000Z',
  createdAtMs: Date.parse('2026-08-09T10:00:00.000Z'),
  updatedAt: '2026-08-09T10:00:00.000Z',
  updatedAtMs: Date.parse('2026-08-09T10:00:00.000Z'),
};

const tasklessRun: RawRun = {
  runId: 'run-one',
  projectId: project.projectId,
  agentId: 'agent-one',
  taskId: null,
  status: 'completed',
  startedAt: '2026-08-09T10:01:00.000Z',
  startedAtMs: Date.parse('2026-08-09T10:01:00.000Z'),
  endedAt: '2026-08-09T10:02:00.000Z',
  endedAtMs: Date.parse('2026-08-09T10:02:00.000Z'),
};

function runEvent(
  eventId: string,
  createdAt: string,
  taskId: string | null,
  data: Record<string, unknown>,
): RawEvent {
  return {
    eventId,
    projectId: project.projectId,
    taskId,
    actorType: 'agent',
    actorId: 'agent-one',
    eventType: 'agent_run_claimed',
    data: { runId: tasklessRun.runId, ...data },
    createdAt,
    createdAtMs: Date.parse(createdAt),
  };
}

function normalizeRuns(events: RawEvent[], runs: RawRun[] = [tasklessRun]) {
  const board: RawBoard = {
    project,
    agents: [],
    tasks: [],
    questions: [],
    runs,
    interrupts: [],
    events,
    documents: [],
  };
  return normalize([board], [project], [], []).runs;
}

describe('run/event projection', () => {
  it('retains a run whose task id is null when no event supplies one', () => {
    expect(normalizeRuns([])).toEqual([
      expect.objectContaining({ id: tasklessRun.runId, taskId: null, wakeReason: null }),
    ]);
  });

  it('prefers an informative event over an uninformative event in both input orders', () => {
    const informative = runEvent(
      'event-informative',
      '2026-08-09T10:02:00.000Z',
      'task-one',
      { wakeReason: 'human_assignment' },
    );
    const uninformative = runEvent('event-uninformative', '2026-08-09T10:03:00.000Z', null, {});

    for (const events of [[informative, uninformative], [uninformative, informative]]) {
      expect(normalizeRuns(events)[0]).toMatchObject({
        taskId: 'task-one',
        wakeReason: 'human_assignment',
      });
    }
  });

  it('prefers a fully populated event over a partially populated one at the same instant', () => {
    // Server behavior: task_run_started and agent_run_claimed share a timestamp;
    // both carry taskId but only the claimed event carries wakeReason.
    const started = runEvent('event-started', '2026-08-09T10:02:00.000Z', 'task-one', {});
    const claimed = runEvent(
      'event-claimed',
      '2026-08-09T10:02:00.000Z',
      'task-one',
      { wakeReason: 'assigned' },
    );

    for (const events of [[started, claimed], [claimed, started]]) {
      expect(normalizeRuns(events)[0]).toMatchObject({
        taskId: 'task-one',
        wakeReason: 'assigned',
      });
    }
  });

  it('chooses the newest informative event by parsed milliseconds in both input orders', () => {
    const older = runEvent(
      'event-older',
      '2026-08-09T12:02:00+02:00',
      'task-older',
      { wakeReason: 'assigned' },
    );
    const newer = runEvent(
      'event-newer',
      '2026-08-09T10:02:00.500Z',
      'task-newer',
      { wakeReason: 'resumed' },
    );

    for (const events of [[older, newer], [newer, older]]) {
      expect(normalizeRuns(events)[0]).toMatchObject({ taskId: 'task-newer', wakeReason: 'resumed' });
    }
  });
});
