/** Provides work-item reads and mutations over a shared client context. */

import type { TaskBoardClient } from "../client";
import { parseDeployAttestationResult, parseWorkItemAudit } from "../parse/entities";
import { boundedText, integer } from "../parse/scalars";
import { parsePipelineSummary } from "../parse/workflow";
import { childrenFromEnvelope, dependenciesFromEnvelope, workItemFromEnvelope } from "./envelopes";
import { requestJson, type TaskBoardClientContext } from "./context";

/* —— Work-item methods —— */

export function createWorkItemMethods(
  context: TaskBoardClientContext
): Pick<
  TaskBoardClient,
  | "getWorkItemAudit"
  | "getWorkItem"
  | "getWorkItemChildren"
  | "getWorkItemDependencies"
  | "createWorkItem"
  | "cancelWorkItem"
  | "archiveWorkItem"
  | "getPipelineSummary"
  | "approvePipelineMerge"
  | "rejectFinalApproval"
  | "attestDeployment"
  | "resumeWorkItem"
> {
  const json = (path: string, init?: RequestInit): Promise<unknown> => requestJson(context, path, init);

  return {
    async getWorkItemAudit(workItemId, signal) {
      return parseWorkItemAudit(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}/audit`, { signal }),
        "work item audit response"
      );
    },
    async getWorkItem(workItemId, signal) {
      return workItemFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}`, { signal }),
        "work item detail response"
      );
    },
    async getWorkItemChildren(parentWorkItemId, signal) {
      return childrenFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(parentWorkItemId)}/children`, { signal }),
        "work item children response"
      );
    },
    async getWorkItemDependencies(workItemId, signal) {
      return dependenciesFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}/dependencies`, { signal }),
        "work item dependencies response"
      );
    },
    async createWorkItem(input) {
      const originalRequest = input.originalRequest.trim();
      if (originalRequest.length === 0) throw new Error("Enter a request");
      if (originalRequest.length > 16_000) throw new Error("Requests cannot exceed 16,000 characters");
      const idempotencyKey = input.idempotencyKey.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) {
        throw new Error("Request submission has an invalid idempotency key");
      }
      const projectId = input.projectId.trim();
      if (projectId.length === 0) throw new Error("Choose a project");
      return workItemFromEnvelope(
        await json("/v1/work-items", {
          method: "POST",
          body: JSON.stringify({
            originalRequest,
            priority: input.priority,
            taskType: input.taskType,
            projectTarget: { mode: "explicit", projectId },
          }),
          headers: { "idempotency-key": idempotencyKey },
        }),
        "create work item response"
      );
    },
    async cancelWorkItem(workItemId, input) {
      const reason = input.reason.trim();
      if (reason.length === 0) throw new Error("An abandonment reason is required");
      if (reason.length > 16_000) throw new Error("Abandonment reasons cannot exceed 16,000 characters");
      return workItemFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            version: integer(input.version, "work item cancellation.version", 1),
            action: "cancel",
            reason,
          }),
        }),
        "cancel work item response"
      );
    },
    async archiveWorkItem(workItemId, input) {
      return workItemFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            version: integer(input.version, "work item archive.version", 1),
            action: "archive",
          }),
        }),
        "archive work item response"
      );
    },
    async getPipelineSummary(workItemId, signal) {
      return parsePipelineSummary(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}/pipeline-summary`, { signal }),
        "pipeline summary response"
      );
    },
    async approvePipelineMerge(workItemId, input) {
      return workItemFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}/approve-merge`, {
          method: "POST",
          body: JSON.stringify({ version: integer(input.version, "pipeline merge approval.version", 1) }),
        }),
        "approve pipeline merge response"
      );
    },
    async rejectFinalApproval(workItemId, input) {
      const note = boundedText(input.note.trim(), "final approval rejection note", 2_000);
      return workItemFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}/reject-final`, {
          method: "POST",
          body: JSON.stringify({
            version: integer(input.version, "final approval rejection.version", 1),
            note,
          }),
        }),
        "reject final approval response"
      );
    },
    async attestDeployment(workItemId, input) {
      const note = input.note?.trim() ?? "";
      return parseDeployAttestationResult(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}/attest-deploy`, {
          method: "POST",
          body: JSON.stringify(
            note.length === 0
              ? {}
              : {
                  note: boundedText(note, "deployment attestation note", 2_000),
                }
          ),
        }),
        "deploy attestation response"
      );
    },
    async resumeWorkItem(workItemId) {
      return workItemFromEnvelope(
        await json(`/v1/work-items/${encodeURIComponent(workItemId)}/resume`, { method: "POST" }),
        "resume work item response"
      );
    },
  };
}
