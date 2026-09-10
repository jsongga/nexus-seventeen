/** Provides agent mutations over a shared client context. */

import type { TaskBoardClient } from "../client";
import { integer } from "../parse/scalars";
import { requestJson, type TaskBoardClientContext } from "./context";
import { interruptRunFromEnvelope, tokenRotationFromEnvelope } from "./envelopes";

/* —— Agent methods —— */

export function createAgentMethods(
  context: TaskBoardClientContext
): Pick<TaskBoardClient, "rotateAgentToken" | "interruptRun"> {
  const json = (path: string, init?: RequestInit): Promise<unknown> => requestJson(context, path, init);

  return {
    async rotateAgentToken(agentId, input) {
      return tokenRotationFromEnvelope(
        await json(`/v1/agents/${encodeURIComponent(agentId)}/rotate-token`, {
          method: "POST",
          body: JSON.stringify({ version: integer(input.version, "agent token rotation.version", 1) }),
        }),
        "agent token rotation response"
      );
    },
    async interruptRun(runId) {
      const agentId = context.runAgents.get(runId);
      if (!agentId) throw new Error("Refresh the board before interrupting this run");
      return interruptRunFromEnvelope(
        await json(`/v1/agents/${encodeURIComponent(agentId)}/interrupt`, {
          method: "POST",
          body: JSON.stringify({ reason: "Human interrupted this agent from the task board" }),
          headers: { "idempotency-key": `interrupt:${runId}` },
        }),
        "interrupt response"
      );
    },
  };
}
