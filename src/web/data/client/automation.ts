/** Provides automation configuration methods over a shared client context. */

import type { TaskBoardClient } from "../client";
import { requestJson, type TaskBoardClientContext } from "./context";
import { automationConfigurationFromEnvelope, automationConfigurationUpdateBody } from "./envelopes";

/* —— Automation methods —— */

export function createAutomationMethods(
  context: TaskBoardClientContext
): Pick<TaskBoardClient, "getAutomationConfiguration" | "saveAutomationConfiguration"> {
  const json = (path: string, init?: RequestInit): Promise<unknown> => requestJson(context, path, init);

  return {
    async getAutomationConfiguration(signal) {
      return automationConfigurationFromEnvelope(
        await json("/v1/automation-configuration", { signal }),
        "automation configuration response"
      );
    },
    async saveAutomationConfiguration(input) {
      return automationConfigurationFromEnvelope(
        await json("/v1/automation-configuration", {
          method: "PATCH",
          body: JSON.stringify(automationConfigurationUpdateBody(input)),
        }),
        "save automation configuration response"
      );
    },
  };
}
