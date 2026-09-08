/** Names the browser-side shapes: each wire record plus the millisecond fields the UI sorts on. */

/* —— Imports —— */

import type {
  AgentInterrupt,
  AgentProfile,
  Repository,
  AgentRun,
  BoardPause,
  HumanQuestion,
  Project,
  TaskEvent,
  TaskMessage,
  TaskPhase,
} from "@shared/task-board-contract";
import {
  type ParsedWorkItemTransition,
  type TolerantBoardNotification,
  type TolerantGateAction,
  type TolerantFindingsLedger,
  type TolerantParkRecord,
  type TolerantParksLedger,
  type TolerantReviewFindingEntity,
  type TolerantTaskEntity,
  type TolerantWorkItemEntity,
} from "@shared/task-board-contract/validate";
import type { ParkCategory } from "../../types";

/* —— Raw record types —— */

export const maximumTaskMessages = 10_000;

export const maximumWorkItemPages = 50;

export const maximumRawWorkItems = 10_000;

type WithMs<T, K extends string> = T & Record<`${K}Ms`, number>;

type WithNullableMs<T, K extends string> = T & Record<`${K}Ms`, number | null>;

type WithOptionalNullableMs<T, K extends string> = T & Partial<Record<`${K}Ms`, number | null>>;

type WithoutApi<T> = Omit<T, "apiVersion">;

export type RawProject = WithMs<WithMs<WithoutApi<Project>, "createdAt">, "updatedAt">;

export type RawWorkItem = WithOptionalNullableMs<
  WithOptionalNullableMs<
    WithNullableMs<
      WithNullableMs<WithMs<WithMs<WithoutApi<TolerantWorkItemEntity>, "createdAt">, "updatedAt">, "endedAt">,
      "archivedAt"
    >,
    "stateSince"
  >,
  "heartbeatAt"
>;

export type RawChildWorkItem = RawWorkItem &
  Readonly<{
    deployAttested: boolean;
    mergeSha: string | null;
  }>;

export type RawWorkItemTransition = WithMs<ParsedWorkItemTransition, "createdAt">;

export type RawWorkItemDetail = RawWorkItem &
  Readonly<{
    transitions: RawWorkItemTransition[];
    gapReportArtifactId: string | null;
    parkCategory?: ParkCategory | null;
  }>;

type RawGateAction = WithMs<TolerantGateAction, "createdAt">;

export interface RawWorkItemAudit {
  gateActions: RawGateAction[];
  transitions: RawWorkItemTransition[];
}

export type RawReviewFinding = WithMs<TolerantReviewFindingEntity, "createdAt">;

export interface RawFindingsLedger extends Omit<TolerantFindingsLedger, "recent"> {
  recent: Array<RawReviewFinding & Readonly<{ workItemId: string }>>;
}

export type RawParkRecord = WithNullableMs<WithMs<TolerantParkRecord, "parkedAt">, "resolvedAt">;

type RawLedgerParkRecord = RawParkRecord & Readonly<{ workItemTitle: string }>;

export interface RawParksLedger extends Omit<TolerantParksLedger, "open" | "resolved"> {
  open: RawLedgerParkRecord[];
  resolved: RawLedgerParkRecord[];
}

export type RawBoardNotification = WithNullableMs<WithMs<TolerantBoardNotification, "createdAt">, "readAt">;

export type RawBoardPause = WithMs<BoardPause, "updatedAt">;

export type RawAgent = WithMs<WithoutApi<AgentProfile>, "createdAt">;

export type RawRepository = WithMs<WithMs<WithoutApi<Repository>, "createdAt">, "updatedAt">;

export type RawTaskPhase = WithMs<
  WithMs<WithNullableMs<WithNullableMs<WithoutApi<TaskPhase>, "startedAt">, "endedAt">, "createdAt">,
  "updatedAt"
>;

export type RawTask = WithMs<
  WithMs<
    WithNullableMs<
      WithNullableMs<
        WithNullableMs<
          WithNullableMs<
            Omit<WithoutApi<TolerantTaskEntity>, "phases" | "workspaceRefs"> & {
              phases: RawTaskPhase[];
              workspaceRefs: string[];
            },
            "estimateRecordedAt"
          >,
          "startedAt"
        >,
        "expectedCompletedAt"
      >,
      "endedAt"
    >,
    "createdAt"
  >,
  "updatedAt"
>;

export type RawQuestion = WithMs<
  WithNullableMs<Omit<WithoutApi<HumanQuestion>, "runId" | "answeredBy">, "answeredAt">,
  "askedAt"
>;

export type RawRun = WithNullableMs<
  WithMs<WithNullableMs<Omit<WithoutApi<AgentRun>, "claimId" | "wakeupId" | "result">, "endedAt">, "startedAt">,
  "heartbeatAt"
>;

export type RawInterrupt = WithMs<
  Pick<AgentInterrupt, "sequence" | "agentId" | "runId" | "requestedAt">,
  "requestedAt"
>;

export type RawEvent = WithMs<WithoutApi<TaskEvent>, "createdAt">;

export type RawMessage = WithMs<Omit<WithoutApi<TaskMessage>, "runId">, "createdAt">;

export interface RawBoard {
  project: RawProject;
  repositories: RawRepository[];
  agents: RawAgent[];
  tasks: RawTask[];
  questions: RawQuestion[];
  runs: RawRun[];
  interrupts: RawInterrupt[];
  events: RawEvent[];
}
