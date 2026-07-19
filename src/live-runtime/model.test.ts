import { describe, expect, it } from 'vitest';
import type {
  AgentTaskProjection,
  RegisteredAgentProjection,
  UiSnapshot,
} from '@cicada/steward-protocol';
import {
  buildInterruptCommand,
  buildQueueWorkCommand,
  buildResumeAgentCommand,
  buildWorkspacePauseCommand,
  createClientCommandId,
  expectedCompletionForAgentTime,
  mapSnapshotToAgents,
} from './model';

const patch = {
  workspaceId: 'workspace-alpha',
  agentId: 'agent-patch',
  laneId: 'lane-patch',
  runtimeInstanceId: 'runtime-patch',
  runtimeEpoch: 2,
  displayName: 'Patch',
  role: 'engineer',
  capabilities: ['research', 'plan', 'modify_workspace', 'run_tests'],
  provider: { name: 'codex', model: 'gpt-5.4-mini' },
  softwareVersion: '0.1.0',
  checkpointRef: null,
  registeredAt: '2026-07-18T19:00:00.000Z',
  lastSeenAt: '2026-07-18T20:00:00.000Z',
  leaseExpiresAt: '2026-07-18T20:01:00.000Z',
  currentAction: null,
  connectionState: 'online',
  controlState: 'active',
  controlVersion: 7,
  queue: ['task-two', 'task-one'],
} as unknown as RegisteredAgentProjection;

const vale = {
  ...patch,
  agentId: 'agent-vale',
  laneId: 'lane-vale',
  runtimeInstanceId: 'runtime-vale',
  displayName: 'Vale',
  role: 'verifier',
  provider: { name: 'claude', model: 'claude-haiku' },
  queue: [],
} as unknown as RegisteredAgentProjection;

function task(
  taskId: string,
  agent = patch,
  status: AgentTaskProjection['status'] = 'queued',
): AgentTaskProjection {
  return {
    taskId,
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
    laneId: agent.laneId,
    title: taskId,
    objective: `Finish ${taskId}`,
    status,
    expectedAgentMinutes: 30,
    expectedCompletedAt: '2026-07-18T20:30:00.000Z',
    startedAt: status === 'queued' ? null : '2026-07-18T20:00:00.000Z',
    endedAt: status === 'completed' ? '2026-07-18T20:20:00.000Z' : null,
  } as AgentTaskProjection;
}

function snapshot(): UiSnapshot {
  return {
    apiVersion: 'steward.ui/v1',
    workspaceId: patch.workspaceId,
    generatedAt: '2026-07-18T20:00:00.000Z',
    sequence: 12,
    paused: false,
    controlVersion: 7,
    agents: [patch, vale],
    tasks: [task('task-one'), task('task-two'), task('task-vale', vale, 'running')],
    progress: [
      {
        taskId: 'task-vale',
        phase: 'research',
        iteration: 1,
        journal: 'Checked the reported behavior.',
        occurredAt: '2026-07-18T20:02:00.000Z',
      },
      {
        taskId: 'task-vale',
        phase: 'plan',
        iteration: 1,
        journal: 'Selected the verification cases.',
        occurredAt: '2026-07-18T20:03:00.000Z',
      },
    ],
  } as unknown as UiSnapshot;
}

describe('authoritative live-runtime mapping', () => {
  it('discovers every agent and keeps queues, tasks, and journals on their owning lane', () => {
    const views = mapSnapshotToAgents(snapshot());

    expect(views.map((view) => view.agent.displayName)).toEqual(['Patch', 'Vale']);
    expect(views[0]?.tasks.queued.map((item) => item.taskId)).toEqual([
      'task-two',
      'task-one',
    ]);
    expect(views[0]?.progress).toEqual([]);
    expect(views[1]?.tasks.running.map((item) => item.taskId)).toEqual(['task-vale']);
    expect(views[1]?.progress.map((item) => item.phase)).toEqual(['plan', 'research']);
  });
});

describe('live-runtime command construction', () => {
  it('snaps agent-only working time upward to the next quarter-hour', () => {
    expect(
      expectedCompletionForAgentTime(new Date('2026-07-18T20:07:31.000Z'), 30),
    ).toBe('2026-07-18T20:45:00.000Z');
    expect(
      expectedCompletionForAgentTime(new Date('2026-07-18T20:00:00.000Z'), 15),
    ).toBe('2026-07-18T20:15:00.000Z');
    expect(() => expectedCompletionForAgentTime(new Date(), 20)).toThrow(/multiple of 15/i);
  });

  it('uses the authoritative workspace version and a stable caller-supplied id', () => {
    const replica = snapshot();
    const id = createClientCommandId(() => 'fixed-intent');
    const queue = buildQueueWorkCommand({
      snapshot: replica,
      agent: patch,
      clientCommandId: id,
      issuedAt: new Date('2026-07-18T20:07:31.000Z'),
      title: '  Repair sign in  ',
      objective: '  Users can sign in again.  ',
      expectedAgentMinutes: 30,
    });
    const interrupt = buildInterruptCommand({
      snapshot: replica,
      agent: vale,
      clientCommandId: 'ui_second-intent',
      issuedAt: new Date('2026-07-18T20:08:00.000Z'),
      reason: '  Human review found a risky assumption.  ',
    });

    expect(queue.clientCommandId).toBe('ui_fixed-intent');
    expect(queue.expectedControlVersion).toBe(7);
    expect(queue.payload).toMatchObject({
      type: 'queue_work',
      title: 'Repair sign in',
      objective: 'Users can sign in again.',
      expectedAgentMinutes: 30,
      expectedCompletedAt: '2026-07-18T20:45:00.000Z',
    });
    expect(interrupt.expectedControlVersion).toBe(7);
    expect(interrupt.payload).toMatchObject({
      type: 'request_interrupt',
      agentId: vale.agentId,
      laneId: vale.laneId,
      reason: 'Human review found a risky assumption.',
    });
  });

  it('constructs workspace and lane resume controls from authoritative state', () => {
    const replica = snapshot();
    const pausedTask = task('task-paused', patch, 'paused');
    const pausedAgent = {
      ...patch,
      controlState: 'paused',
      checkpointRef: 'checkpoint-patch',
    } as RegisteredAgentProjection;
    const resume = buildResumeAgentCommand({
      snapshot: replica,
      agent: pausedAgent,
      task: pausedTask,
      clientCommandId: 'ui_resume',
      issuedAt: new Date('2026-07-18T20:10:00.000Z'),
    });
    const pauseWorkspace = buildWorkspacePauseCommand({
      snapshot: replica,
      paused: true,
      reason: '  Human review found a release risk.  ',
      clientCommandId: 'ui_pause_workspace',
      issuedAt: new Date('2026-07-18T20:11:00.000Z'),
    });

    expect(resume.expectedControlVersion).toBe(7);
    expect(resume.payload).toEqual({
      type: 'resume_agent',
      agentId: patch.agentId,
      laneId: patch.laneId,
      taskId: pausedTask.taskId,
      checkpointRef: 'checkpoint-patch',
    });
    expect(pauseWorkspace.expectedControlVersion).toBe(7);
    expect(pauseWorkspace.payload).toEqual({
      type: 'set_workspace_pause',
      paused: true,
      reason: 'Human review found a release risk.',
    });
    expect(() => buildResumeAgentCommand({
      snapshot: replica,
      agent: pausedAgent,
      task: task('wrong-owner', vale, 'paused'),
      clientCommandId: 'ui_wrong_owner',
      issuedAt: new Date('2026-07-18T20:12:00.000Z'),
    })).toThrow(/belong to the selected agent lane/i);
  });
});
