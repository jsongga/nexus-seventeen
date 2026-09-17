/** Decides which agent types may run a stage, and converts an executor to and from its form value. */

/* —— Imports —— */

import {
  AUTOMATION_STAGE_ALLOWED_ROLES,
  type AutomationAgentType,
  type AutomationStageExecutor,
  type WorkItemStage,
} from "../../types";

/* —— Stage executors —— */

export const machineVerifyExecutorValue = "__machine_verify__";

export function eligibleAgentTypes(
  workItemStage: WorkItemStage,
  agentTypes: AutomationAgentType[]
): AutomationAgentType[] {
  const allowedRoles = AUTOMATION_STAGE_ALLOWED_ROLES[workItemStage];
  return agentTypes.filter((agentType) => agentType.enabled && allowedRoles.includes(agentType.role));
}

export function executorValue(executor: AutomationStageExecutor): string {
  return executor.kind === "agent_type"
    ? executor.agentTypeId
    : executor.kind === "machine_verify"
      ? machineVerifyExecutorValue
      : "";
}

export function automationExecutorFromValue(value: string): AutomationStageExecutor {
  return value === machineVerifyExecutorValue
    ? { kind: "machine_verify" }
    : value
      ? { kind: "agent_type", agentTypeId: value }
      : { kind: "disabled" };
}
