import type {
  AutomationConfiguration,
  UpdateAutomationConfigurationRequest,
} from "#shared/task-board-contract";
import { canonicalJson } from "../canonical.js";
import { conflict } from "../errors.js";
import { automationConfigurationFromRow } from "../persistence/rows.js";
import { parseUpdateAutomationConfiguration } from "../schema.js";
import { exactNow } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./runtime.js";

export class AutomationCollaborator {
  constructor(private readonly runtime: TaskBoardRuntime) {}

  getConfiguration(): AutomationConfiguration {
    const row = this.runtime.store.db.prepare(`
      SELECT * FROM automation_configuration WHERE configuration_id = 'company-default'
    `).get();
    if (!row) throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration_missing");
    return automationConfigurationFromRow(row);
  }

  updateConfiguration(request: UpdateAutomationConfigurationRequest): AutomationConfiguration {
    const normalized = parseUpdateAutomationConfiguration(request);
    return this.runtime.store.transaction(() => {
      const current = this.getConfiguration();
      if (current.version !== normalized.version) {
        throw conflict("AUTOMATION_CONFIGURATION_VERSION_CONFLICT", "Automation configuration version changed");
      }
      const nextTypes = new Map(normalized.agentTypes.map((agentType) => [agentType.agentTypeId, agentType] as const));
      for (const existing of current.agentTypes) {
        const replacement = nextTypes.get(existing.agentTypeId);
        if (replacement === undefined) {
          throw conflict(
            "AUTOMATION_AGENT_TYPE_REMOVAL_FORBIDDEN",
            "Existing agent types must be retained and may be disabled instead of removed",
          );
        }
        if (replacement.role !== existing.role) {
          throw conflict(
            "AUTOMATION_AGENT_TYPE_ROLE_IMMUTABLE",
            "An existing agent type's authority role cannot change",
          );
        }
      }
      const now = exactNow(this.runtime.config.now);
      const update = this.runtime.store.db.prepare(`
        UPDATE automation_configuration
        SET agent_types_json = ?, stages_json = ?, version = version + 1, updated_at = ?, updated_by = ?
        WHERE configuration_id = 'company-default' AND version = ?
      `).run(
        canonicalJson(normalized.agentTypes),
        canonicalJson(normalized.stages),
        now,
        this.runtime.config.humanPrincipal,
        current.version,
      );
      if (Number(update.changes) !== 1) {
        throw conflict("AUTOMATION_CONFIGURATION_VERSION_CONFLICT", "Automation configuration version changed");
      }
      return this.getConfiguration();
    });
  }
}
