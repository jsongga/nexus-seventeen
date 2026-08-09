import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  AGENT_ROLES,
  AGENT_STATUSES,
  DOCUMENT_ACTOR_TYPES,
  EVALUATOR_PROFILES,
  IDENTIFIER_PATTERN,
  PLAN_REVISION_STATES,
  QUESTION_STATUSES,
  RUN_STATUSES,
  STAGE_HANDOFF_OUTCOMES,
  TASK_BOARD_API_VERSION,
  TASK_KINDS,
  TASK_MESSAGE_PAGE_SIZE,
  TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  WORKER_CONNECTIONS,
  WORK_ITEM_PAGE_SIZE,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  WORK_NODE_STATES,
  WORKFLOW_STAGES,
} from '@shared/task-board-contract';
import {
  actorTypes,
  apiVersion,
  documentActorTypes,
  evaluatorProfiles,
  identifierPattern,
  maximumAutomationConfigurationBytes,
  planRevisionStateValues,
  planRevisionStates,
  questionStatuses,
  rawAgentStatuses,
  rawRunStatuses,
  rawTaskStatuses,
  rawWorkerConnections,
  roles,
  stageHandoffOutcomes,
  stageHandoffOutcomeValues,
  taskKinds,
  taskMessagePageSize,
  taskPhaseStages,
  taskPhaseStatuses,
  messageKinds,
  wakeReasons,
  workflowStages,
  workItemPriorities,
  workItemPageSize,
  workItemStages,
  workItemStates,
  workNodeStates,
  workNodeStateValues,
} from './wire';

describe('wire constants', () => {
  it('resolves the shared contract from source through the @shared alias', () => {
    expect(TASK_BOARD_API_VERSION).toBe('steward.task-board/v1');
  });

  it('re-exports contract constants rather than redeclaring them', () => {
    expect(apiVersion).toBe(TASK_BOARD_API_VERSION);
    expect(maximumAutomationConfigurationBytes).toBe(48 * 1_024);
    expect(taskMessagePageSize).toBe(TASK_MESSAGE_PAGE_SIZE);
    expect(workItemPageSize).toBe(WORK_ITEM_PAGE_SIZE);
    expect(identifierPattern.source).toBe(IDENTIFIER_PATTERN);
    expect(planRevisionStateValues).toBe(PLAN_REVISION_STATES);
    expect(workNodeStateValues).toBe(WORK_NODE_STATES);
    expect(stageHandoffOutcomeValues).toBe(STAGE_HANDOFF_OUTCOMES);
  });
});

describe('wire validators', () => {
  it('builds the agent status validator from the contract', () => {
    expect([...rawAgentStatuses].sort()).toEqual([...AGENT_STATUSES].sort());
  });

  it('builds the task status validator from the contract', () => {
    expect([...rawTaskStatuses].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it.each([
    ['actor types', actorTypes, ACTOR_TYPES],
    ['worker connections', rawWorkerConnections, WORKER_CONNECTIONS],
    ['run statuses', rawRunStatuses, RUN_STATUSES],
    ['roles', roles, AGENT_ROLES],
    ['task kinds', taskKinds, TASK_KINDS],
    ['phase stages', taskPhaseStages, TASK_PHASE_STAGES],
    ['phase statuses', taskPhaseStatuses, TASK_PHASE_STATUSES],
    ['message kinds', messageKinds, TASK_MESSAGE_KINDS],
    ['question statuses', questionStatuses, QUESTION_STATUSES],
    ['wake reasons', wakeReasons, WAKEUP_REASONS],
    ['work-item priorities', workItemPriorities, WORK_ITEM_PRIORITIES],
    ['work-item states', workItemStates, WORK_ITEM_STATES],
    ['work-item stages', workItemStages, WORK_ITEM_STAGES],
    ['evaluator profiles', evaluatorProfiles, EVALUATOR_PROFILES],
    ['document actor types', documentActorTypes, DOCUMENT_ACTOR_TYPES],
    ['workflow stages', workflowStages, WORKFLOW_STAGES],
    ['plan revision states', planRevisionStates, PLAN_REVISION_STATES],
    ['work-node states', workNodeStates, WORK_NODE_STATES],
    ['handoff outcomes', stageHandoffOutcomes, STAGE_HANDOFF_OUTCOMES],
  ] as const)('builds the %s validator from the contract', (_label, actual, expected) => {
    expect([...actual]).toEqual([...expected]);
  });

  it('rejects view-layer vocabulary that never appears on the wire', () => {
    // 'running' is what the view calls in_progress. If the wire validator
    // ever accepts it, the projection layer has leaked into parsing.
    expect(rawTaskStatuses.has('running' as never)).toBe(false);
    expect(rawAgentStatuses.has('sleeping' as never)).toBe(false);
  });
});
