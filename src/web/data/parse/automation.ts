/** Reads and writes the automation configuration the board edits as one draft. */

/* —— Imports —— */

import {
  automationConfigurationPartsBytes,
  parseAutomationAgentTypeEntity,
  parseAutomationConfigurationEntity,
  parseAutomationExecutorEntity,
  parseAutomationStageEntity,
  validateAutomationConfigurationParts,
  type JsonRecord,
} from "@shared/task-board-contract/validate";
import type {
  AutomationAgentType,
  AutomationConfiguration,
  AutomationStageConfiguration,
  AutomationStageExecutor,
} from "../../types";
import { maximumAutomationConfigurationBytes } from "../wire";
import { ms, strict } from "./scalars";

/* —— Automation —— */

const uiAgentType = (item: ReturnType<typeof parseAutomationAgentTypeEntity>): AutomationAgentType => ({
  id: item.agentTypeId,
  name: item.name,
  description: item.description,
  role: item.role,
  supplementalInstructions: item.supplementalInstructions,
  skillIds: [...item.skillIds],
  evaluatorProfile: item.evaluatorProfile,
  enabled: item.enabled,
});

export function parseAutomationAgentType(value: unknown, path: string): AutomationAgentType {
  return uiAgentType(parseAutomationAgentTypeEntity(value, path, strict));
}

export function parseAutomationExecutor(value: unknown, path: string): AutomationStageExecutor {
  return { ...parseAutomationExecutorEntity(value, path, strict) };
}

export function parseAutomationStage(value: unknown, path: string): AutomationStageConfiguration {
  const item = parseAutomationStageEntity(value, path, strict);
  return { stage: item.stage, executor: { ...item.executor } };
}

export function automationAgentTypeWire(item: AutomationAgentType): JsonRecord {
  return {
    agentTypeId: item.id,
    name: item.name,
    description: item.description,
    role: item.role,
    supplementalInstructions: item.supplementalInstructions,
    skillIds: [...item.skillIds],
    evaluatorProfile: item.evaluatorProfile,
    enabled: item.enabled,
  };
}

export function automationStageWire(item: AutomationStageConfiguration): JsonRecord {
  return {
    stage: item.stage,
    executor: item.executor.kind === "agent_type" ? { ...item.executor } : { kind: item.executor.kind },
  };
}

const canonicalAutomation = (agentTypes: AutomationAgentType[], stages: AutomationStageConfiguration[]) => ({
  agentTypes: agentTypes.map((item, index) =>
    parseAutomationAgentTypeEntity(automationAgentTypeWire(item), `agentTypes[${index}]`, strict)
  ),
  stages: stages.map((item, index) =>
    parseAutomationStageEntity(automationStageWire(item), `stages[${index}]`, strict)
  ),
});

export function validateAutomationParts(
  agentTypes: AutomationAgentType[],
  stages: AutomationStageConfiguration[],
  path: string
): void {
  const value = canonicalAutomation(agentTypes, stages);
  validateAutomationConfigurationParts(value.agentTypes, value.stages, path);
}

export function validateAutomationPayloadSize(
  agentTypes: AutomationAgentType[],
  stages: AutomationStageConfiguration[],
  path: string
): void {
  const value = canonicalAutomation(agentTypes, stages);
  if (automationConfigurationPartsBytes(value.agentTypes, value.stages) > maximumAutomationConfigurationBytes)
    throw new Error(`${path} agent types and stages cannot exceed 48 KiB of UTF-8 JSON`);
}

export function parseAutomationConfiguration(value: unknown, path: string): AutomationConfiguration {
  const item = parseAutomationConfigurationEntity(value, path, strict);
  const agentTypes = item.agentTypes.map(uiAgentType);
  const stages = item.stages.map((entry) => ({ stage: entry.stage, executor: { ...entry.executor } }));
  validateAutomationPayloadSize(agentTypes, stages, path);
  return {
    id: "company-default",
    agentTypes,
    stages,
    version: item.version,
    createdAt: item.createdAt,
    createdAtMs: ms(item.createdAt),
    updatedAt: item.updatedAt,
    updatedAtMs: ms(item.updatedAt),
    updatedBy: item.updatedBy,
  };
}
