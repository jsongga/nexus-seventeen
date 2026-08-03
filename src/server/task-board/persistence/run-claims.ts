import type { ClaimRunRequest } from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";

export function claimMessageCursor(request: ClaimRunRequest, taskId: string | null): number | null {
  if (request.messageCursors !== undefined) {
    return taskId === null ? null : request.messageCursors[taskId] ?? null;
  }
  return request.messageCursor ?? null;
}

export function claimRequestHash(agentId: string, request: ClaimRunRequest, taskId: string | null): string {
  return sha256({
    action: "claim_run",
    agentId,
    claimId: request.claimId,
    taskId,
    messageCursor: claimMessageCursor(request, taskId),
  });
}

export function legacyClaimRequestHash(agentId: string, claimId: string, messageCursor: number | null): string {
  return sha256({ action: "claim_run", agentId, request: { claimId, messageCursor } });
}
