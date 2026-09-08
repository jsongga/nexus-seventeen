/** Reads the board's HTTP response envelopes into the shapes the client returns. */

/* —— Imports —— */

import type { RejectPlanRevisionResponse } from "@shared/task-board-contract";
import type {
  AutomationConfiguration,
  BoardChildWorkItem,
  BoardProject,
  BoardSnapshot,
  BoardWorkItemDependency,
  BoardWorkItemDetail,
  HostDirectoryListing,
  HostProjectEntry,
  HostProjectRoot,
  ProjectWorkflow,
  RotateAgentTokenResult,
  SaveAutomationConfigurationInput,
} from "../../types";
import {
  automationAgentTypeWire,
  automationStageWire,
  parseAutomationAgentType,
  parseAutomationConfiguration,
  parseAutomationStage,
  validateAutomationParts,
  validateAutomationPayloadSize,
} from "../parse/automation";
import {
  parseAgent,
  parseChildWorkItem,
  parseInterrupt,
  parseProject,
  parseWorkItem,
  parseWorkItemDependency,
  parseWorkItemDetail,
} from "../parse/entities";
import {
  boundedText,
  exactRecord,
  integer,
  parseArray,
  parseBoolean,
  parseRecord,
  parseString,
} from "../parse/scalars";
import { type RawWorkItem } from "../parse/types";
import { parseProjectWorkflow, parseRawBoard } from "../parse/workflow";
import { maximumWorkItemCursorBytes, type JsonRecord } from "../parse";
import { childWorkItemProjection, normalize, projectProjection, workItemDetailProjection } from "../../model/project";
import { workItemPageSize } from "../wire";

/* —— Response envelopes —— */

export interface InterruptRunResult {
  readonly runId: string | null;
}

export function parseBoardSnapshot(value: unknown): BoardSnapshot {
  const board = parseRawBoard(value);
  return normalize([board], [board.project], [], []);
}

export function automationConfigurationFromEnvelope(value: unknown, path: string): AutomationConfiguration {
  const envelope = exactRecord(value, path, ["configuration"]);
  return parseAutomationConfiguration(envelope.configuration, `${path}.configuration`);
}

export function automationConfigurationUpdateBody(input: SaveAutomationConfigurationInput): JsonRecord {
  const version = integer(input.version, "automation configuration update.version", 1);
  const rawAgentTypes = input.agentTypes.map(automationAgentTypeWire);
  const agentTypes = rawAgentTypes.map((agentType, index) =>
    parseAutomationAgentType(agentType, `automation configuration update.agentTypes[${index}]`)
  );
  const rawStages = input.stages.map(automationStageWire);
  const stages = rawStages.map((entry, index) =>
    parseAutomationStage(entry, `automation configuration update.stages[${index}]`)
  );
  validateAutomationParts(agentTypes, stages, "automation configuration update");
  validateAutomationPayloadSize(agentTypes, stages, "automation configuration update");
  return { version, agentTypes: rawAgentTypes, stages: rawStages };
}

export function projectFromEnvelope(value: unknown, path: string): BoardProject {
  const envelope = parseRecord(value, path);
  return projectProjection(parseProject(envelope.project, `${path}.project`));
}

function parseHostProjectEntry(value: unknown, path: string): HostProjectEntry {
  const item = parseRecord(value, path);
  const modifiedAtMs = item.modifiedAtMs;
  if (typeof modifiedAtMs !== "number" || !Number.isFinite(modifiedAtMs))
    throw new Error(`${path}.modifiedAtMs must be a finite number`);
  return {
    name: parseString(item.name, `${path}.name`),
    path: parseString(item.path, `${path}.path`),
    hasGit: parseBoolean(item.hasGit, `${path}.hasGit`),
    modifiedAtMs,
  };
}

export function parseHostProjectRoot(value: unknown, path: string): HostProjectRoot {
  const item = parseRecord(value, path);
  return {
    name: parseString(item.name, `${path}.name`),
    path: parseString(item.path, `${path}.path`),
    projects: parseArray(item.projects, `${path}.projects`, parseHostProjectEntry),
    truncated: parseBoolean(item.truncated, `${path}.truncated`),
  };
}

export function parseHostDirectoryListing(value: unknown, path: string): HostDirectoryListing {
  const item = parseRecord(value, path);
  const parent = item.parent;
  if (parent !== null && typeof parent !== "string") throw new Error(`${path}.parent must be a string or null`);
  return {
    path: parseString(item.path, `${path}.path`),
    parent,
    entries: parseArray(item.entries, `${path}.entries`, (entry, entryPath) => {
      const node = parseRecord(entry, entryPath);
      return {
        name: parseString(node.name, `${entryPath}.name`),
        path: parseString(node.path, `${entryPath}.path`),
        hasGit: parseBoolean(node.hasGit, `${entryPath}.hasGit`),
      };
    }),
    truncated: parseBoolean(item.truncated, `${path}.truncated`),
  };
}

export function workItemFromEnvelope(value: unknown, path: string): BoardWorkItemDetail {
  const envelope = parseRecord(value, path);
  return workItemDetailProjection(parseWorkItemDetail(envelope.workItem, `${path}.workItem`));
}

export function childrenFromEnvelope(value: unknown, path: string): BoardChildWorkItem[] {
  const envelope = parseRecord(value, path);
  return parseArray(envelope.children, `${path}.children`, parseChildWorkItem).map(childWorkItemProjection);
}

export function dependenciesFromEnvelope(value: unknown, path: string): BoardWorkItemDependency[] {
  const envelope = parseRecord(value, path);
  return parseArray(envelope.dependencies, `${path}.dependencies`, parseWorkItemDependency);
}

export function tokenRotationFromEnvelope(value: unknown, path: string): RotateAgentTokenResult {
  const envelope = exactRecord(value, path, ["agent", "token"]);
  const agent = parseAgent(envelope.agent, `${path}.agent`);
  const token = boundedText(envelope.token, `${path}.token`, 512);
  if (token.length < 32) throw new Error(`${path}.token must contain at least 32 characters`);
  return { agentId: agent.agentId, version: agent.version, token };
}

export function interruptRunFromEnvelope(value: unknown, path: string): InterruptRunResult {
  const envelope = parseRecord(value, path);
  const interrupt = parseInterrupt(envelope.interrupt, `${path}.interrupt`);
  return { runId: interrupt.runId };
}

export function workflowFromEnvelope(value: unknown, path: string): ProjectWorkflow {
  const envelope = parseRecord(value, path);
  return parseProjectWorkflow(envelope.workflow, `${path}.workflow`);
}

export function planRejectionFromEnvelope(value: unknown, path: string): RejectPlanRevisionResponse {
  const envelope = exactRecord(value, path, ["outcome"]);
  if (envelope.outcome !== "revising" && envelope.outcome !== "parked") {
    throw new Error(`${path}.outcome must be revising or parked`);
  }
  return { outcome: envelope.outcome };
}

export function workItemPageFromEnvelope(
  value: unknown,
  path: string
): {
  workItems: RawWorkItem[];
  nextCursor: string | null;
} {
  const envelope = parseRecord(value, path);
  if (!Array.isArray(envelope.workItems)) throw new Error(`${path}.workItems must be an array`);
  if (envelope.workItems.length > workItemPageSize) {
    throw new Error(`${path}.workItems cannot contain more than ${workItemPageSize} records`);
  }
  const workItems = envelope.workItems.map((item, index) => parseWorkItem(item, `${path}.workItems[${index}]`));
  if (!("nextCursor" in envelope)) return { workItems, nextCursor: null };
  const nextCursor = parseString(envelope.nextCursor, `${path}.nextCursor`);
  if (nextCursor.length === 0 || new TextEncoder().encode(nextCursor).byteLength > maximumWorkItemCursorBytes) {
    throw new Error(
      `${path}.nextCursor must be a nonempty string no larger than ${maximumWorkItemCursorBytes} UTF-8 bytes`
    );
  }
  return { workItems, nextCursor };
}
