/** Projects stored task-board entities from wire records into their browser shapes. */

/* —— Imports —— */

import { GIT_OBJECT_ID_PATTERN } from "@shared/task-board-contract";
import type {
  AgentInterrupt,
  AgentProfile,
  AgentRun,
  HumanQuestion,
  Project,
  TaskEvent,
  TaskMessage,
  TaskPhase,
} from "@shared/task-board-contract";
import {
  arrayOf,
  booleanValue,
  parseAgentEntity,
  parseBoardNotification as parseBoardNotificationContract,
  parseBoardPause as parseBoardPauseContract,
  parseDesignRecordEntity,
  parseEventEntity,
  parseFindingsLedger as parseFindingsLedgerContract,
  parseGateAction as parseGateActionContract,
  parseInterruptEntity,
  parseMessageEntity,
  parseParkRecord as parseParkRecordContract,
  parseParksLedger as parseParksLedgerContract,
  parseProjectEntity,
  parseQuestionEntity,
  parseReviewFindingEntity,
  parseRunEntity,
  parseTaskEntity,
  parseWorkItemAudit as parseWorkItemAuditContract,
  parseWorkItemEntity,
  parseWorkItemTransitionEntity,
  record as contractRecord,
  stringValue,
  type TolerantDesignRecordEntity,
  type TolerantGateAction,
  type TolerantParkRecord,
  type TolerantReviewFindingEntity,
  type TolerantTaskEntity,
  type TolerantWorkItemAudit,
  type TolerantWorkItemEntity,
} from "@shared/task-board-contract/validate";
import type { BoardWorkItemDependency, DeployAttestationResult } from "../../types";
import { parkCategories } from "../wire";
import { identifier, loose, member, ms, nullableMs, withoutApiVersion } from "./scalars";
import {
  type RawAgent,
  type RawBoardNotification,
  type RawBoardPause,
  type RawChildWorkItem,
  type RawEvent,
  type RawFindingsLedger,
  type RawInterrupt,
  type RawMessage,
  type RawParkRecord,
  type RawParksLedger,
  type RawProject,
  type RawQuestion,
  type RawReviewFinding,
  type RawRun,
  type RawTask,
  type RawTaskPhase,
  type RawWorkItem,
  type RawWorkItemAudit,
  type RawWorkItemDetail,
  type RawWorkItemTransition,
} from "./types";

/* —— Entities —— */

export function projectProject(item: Project): RawProject {
  return { ...withoutApiVersion(item), createdAtMs: ms(item.createdAt), updatedAtMs: ms(item.updatedAt) };
}

export function parseProject(value: unknown, path: string): RawProject {
  return projectProject(parseProjectEntity(value, path, loose));
}

function projectWorkItem(item: TolerantWorkItemEntity): RawWorkItem {
  return {
    ...withoutApiVersion(item),
    ...(item.stateSince === undefined ? {} : { stateSinceMs: nullableMs(item.stateSince) }),
    ...(item.heartbeatAt === undefined ? {} : { heartbeatAtMs: nullableMs(item.heartbeatAt) }),
    createdAtMs: ms(item.createdAt),
    updatedAtMs: ms(item.updatedAt),
    endedAtMs: nullableMs(item.endedAt),
    archivedAtMs: nullableMs(item.archivedAt),
  };
}

export function parseWorkItem(value: unknown, path: string): RawWorkItem {
  return projectWorkItem(parseWorkItemEntity(value, path, loose));
}

export function parseChildWorkItem(value: unknown, path: string): RawChildWorkItem {
  const item = contractRecord(value, path);
  const mergeSha = item.mergeSha === null ? null : stringValue(item.mergeSha, `${path}.mergeSha`);
  if (mergeSha !== null && !GIT_OBJECT_ID_PATTERN.test(mergeSha)) {
    throw new Error(`${path}.mergeSha must be a Git object id or null`);
  }
  return {
    ...projectWorkItem(parseWorkItemEntity(item, path, loose)),
    deployAttested: booleanValue(item.deployAttested, `${path}.deployAttested`),
    mergeSha,
  };
}

export function parseWorkItemDependency(value: unknown, path: string): BoardWorkItemDependency {
  const item = contractRecord(value, path);
  return {
    workItemId: stringValue(item.workItemId, `${path}.workItemId`),
    dependsOnWorkItemId: stringValue(item.dependsOnWorkItemId, `${path}.dependsOnWorkItemId`),
  };
}

function parseWorkItemTransitions(value: unknown, path: string): RawWorkItemTransition[] {
  return arrayOf(value, path, (entry, entryPath) => {
    const transition = parseWorkItemTransitionEntity(entry, entryPath, loose);
    return { ...transition, createdAtMs: ms(transition.createdAt) };
  });
}

export function parseWorkItemDetail(value: unknown, path: string): RawWorkItemDetail {
  const item = contractRecord(value, path);
  return {
    ...projectWorkItem(parseWorkItemEntity(item, path, loose)),
    transitions: parseWorkItemTransitions(item.transitions, `${path}.transitions`),
    gapReportArtifactId:
      item.gapReportArtifactId === undefined || item.gapReportArtifactId === null
        ? null
        : identifier(item.gapReportArtifactId, `${path}.gapReportArtifactId`),
    parkCategory:
      item.parkCategory === undefined || item.parkCategory === null
        ? null
        : member(item.parkCategory, parkCategories, `${path}.parkCategory`),
  };
}

export function projectAgent(item: AgentProfile): RawAgent {
  return { ...withoutApiVersion(item), createdAtMs: ms(item.createdAt) };
}

export function parseAgent(value: unknown, path: string): RawAgent {
  return projectAgent(parseAgentEntity(value, path, loose));
}

function projectTaskPhase(item: TaskPhase): RawTaskPhase {
  return {
    ...withoutApiVersion(item),
    startedAtMs: nullableMs(item.startedAt),
    endedAtMs: nullableMs(item.endedAt),
    createdAtMs: ms(item.createdAt),
    updatedAtMs: ms(item.updatedAt),
  };
}

export function projectTask(item: TolerantTaskEntity): RawTask {
  return {
    ...withoutApiVersion(item),
    workspaceRefs: [...item.workspaceRefs],
    phases: item.phases.map(projectTaskPhase),
    estimateRecordedAtMs: nullableMs(item.estimateRecordedAt),
    startedAtMs: nullableMs(item.startedAt),
    expectedCompletedAtMs: nullableMs(item.expectedCompletedAt),
    endedAtMs: nullableMs(item.endedAt),
    createdAtMs: ms(item.createdAt),
    updatedAtMs: ms(item.updatedAt),
  };
}

export function parseTask(value: unknown, path: string): RawTask {
  return projectTask(parseTaskEntity(value, path, loose));
}

export function projectQuestion(value: HumanQuestion): RawQuestion {
  const { apiVersion: _apiVersion, runId: _runId, answeredBy: _answeredBy, ...item } = value;
  return { ...item, askedAtMs: ms(item.askedAt), answeredAtMs: nullableMs(item.answeredAt) };
}

export function parseQuestion(value: unknown, path: string): RawQuestion {
  return projectQuestion(parseQuestionEntity(value, path, loose));
}

export function projectRun(value: AgentRun): RawRun {
  const { apiVersion: _apiVersion, claimId: _claimId, wakeupId: _wakeupId, result: _result, ...item } = value;
  return {
    ...item,
    startedAtMs: ms(item.startedAt),
    heartbeatAtMs: nullableMs(item.heartbeatAt),
    endedAtMs: nullableMs(item.endedAt),
  };
}

export function parseRun(value: unknown, path: string): RawRun {
  return projectRun(parseRunEntity(value, path, loose));
}

export function projectInterrupt(item: AgentInterrupt): RawInterrupt {
  return {
    sequence: item.sequence,
    agentId: item.agentId,
    runId: item.runId,
    requestedAt: item.requestedAt,
    requestedAtMs: ms(item.requestedAt),
  };
}

export function parseInterrupt(value: unknown, path: string): RawInterrupt {
  return projectInterrupt(parseInterruptEntity(value, path, loose));
}

export function projectEvent(item: TaskEvent): RawEvent {
  return { ...withoutApiVersion(item), createdAtMs: ms(item.createdAt) };
}

export function parseEvent(value: unknown, path: string): RawEvent {
  return projectEvent(parseEventEntity(value, path, loose));
}

function projectMessage(value: TaskMessage): RawMessage {
  const { apiVersion: _apiVersion, runId: _runId, ...item } = value;
  return { ...item, createdAtMs: ms(item.createdAt) };
}

export function parseMessage(value: unknown, path: string): RawMessage {
  return projectMessage(parseMessageEntity(value, path, loose));
}

function projectParkRecord(item: TolerantParkRecord): RawParkRecord {
  return {
    ...item,
    parkedAtMs: ms(item.parkedAt),
    resolvedAtMs: nullableMs(item.resolvedAt),
  };
}

export function parseParkRecord(value: unknown, path: string): RawParkRecord {
  return projectParkRecord(parseParkRecordContract(value, path, loose));
}

function projectReviewFinding(item: TolerantReviewFindingEntity): RawReviewFinding {
  return { ...item, createdAtMs: ms(item.createdAt) };
}

export function parseFindingsLedger(value: unknown, path: string): RawFindingsLedger {
  const item = parseFindingsLedgerContract(value, path, loose);
  return {
    ...item,
    recent: item.recent.map((finding) => ({
      ...projectReviewFinding(finding),
      workItemId: finding.workItemId,
    })),
  };
}

export function parseParksLedger(value: unknown, path: string): RawParksLedger {
  const item = parseParksLedgerContract(value, path, loose);
  return {
    ...item,
    open: item.open.map((park) => ({ ...projectParkRecord(park), workItemTitle: park.workItemTitle })),
    resolved: item.resolved.map((park) => ({ ...projectParkRecord(park), workItemTitle: park.workItemTitle })),
  };
}

export function parseBoardNotification(value: unknown, path: string): RawBoardNotification {
  const item = parseBoardNotificationContract(value, path, loose);
  return {
    ...item,
    createdAtMs: ms(item.createdAt),
    readAtMs: nullableMs(item.readAt),
  };
}

export function parseBoardPause(value: unknown, path: string): RawBoardPause {
  const item = parseBoardPauseContract(value, path, loose);
  return { ...item, updatedAtMs: ms(item.updatedAt) };
}

export function parseGateAction(value: unknown, path: string): TolerantGateAction {
  return parseGateActionContract(value, path, loose);
}

export function parseDeployAttestationResult(value: unknown, path: string): DeployAttestationResult {
  const item = contractRecord(value, path);
  const action = parseGateActionContract(item.gateAction, `${path}.gateAction`, loose);
  return {
    gateAction: {
      id: action.gateActionId,
      workItemId: action.workItemId,
      gate: action.gate,
      actorId: action.actorId,
      planRevisionId: action.planRevisionId,
      verifiedSha: action.verifiedSha,
      mergeSha: action.mergeSha,
      refId: action.refId,
      note: action.note,
      createdAt: action.createdAt,
      createdAtMs: ms(action.createdAt),
    },
    duplicate: booleanValue(item.duplicate, `${path}.duplicate`),
  };
}

export function parseWorkItemAudit(value: unknown, path: string): RawWorkItemAudit {
  const item: TolerantWorkItemAudit = parseWorkItemAuditContract(value, path, loose);
  return {
    gateActions: item.gateActions.map((action) => ({
      ...action,
      createdAtMs: ms(action.createdAt),
    })),
    transitions: item.transitions.map((transition) => ({
      ...transition,
      createdAtMs: ms(transition.createdAt),
    })),
  };
}

export function parseReviewFinding(value: unknown, path: string): RawReviewFinding {
  return projectReviewFinding(parseReviewFindingEntity(value, path, loose));
}

export function parseDesignRecord(value: unknown, path: string): TolerantDesignRecordEntity {
  const item = parseDesignRecordEntity(value, path, loose);
  return {
    ...item,
    states: [...item.states],
    transitions: item.transitions.map((transition) => ({ ...transition })),
    failurePoints: item.failurePoints.map((failurePoint) => ({ ...failurePoint })),
    idempotencyKeys: item.idempotencyKeys.map((key) => ({ ...key })),
    faultInjectionCases: item.faultInjectionCases.map((faultCase) => ({ ...faultCase })),
  };
}
