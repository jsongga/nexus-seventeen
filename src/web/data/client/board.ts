/** Provides board-wide reads and mutations over a shared client context. */

import type { TaskBoardClient } from "../client";
import { normalize } from "../../model/project";
import {
  parseBoardNotification,
  parseBoardPause,
  parseFindingsLedger,
  parseMessage,
  parseParksLedger,
  parseProject,
} from "../parse/entities";
import { boundedText, integer, parseArray, parseRecord } from "../parse/scalars";
import {
  maximumRawWorkItems,
  maximumTaskMessages,
  maximumWorkItemPages,
  type RawMessage,
  type RawTask,
  type RawWorkItem,
} from "../parse/types";
import { parseRawBoard } from "../parse/workflow";
import { taskMessagePageSize } from "../wire";
import { requestJson, type TaskBoardClientContext } from "./context";
import { workItemPageFromEnvelope } from "./envelopes";

/* —— Snapshot helpers —— */

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      result[index] = await operation(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

/* —— Board methods —— */

export function createBoardMethods(
  context: TaskBoardClientContext
): Pick<
  TaskBoardClient,
  | "getSnapshot"
  | "getBoardPause"
  | "setBoardPause"
  | "resumeBoard"
  | "getFindingsLedger"
  | "getParksLedger"
  | "getNotifications"
  | "markNotificationRead"
> {
  const json = (path: string, init?: RequestInit): Promise<unknown> => requestJson(context, path, init);

  async function taskMessages(task: RawTask, signal?: AbortSignal): Promise<RawMessage[]> {
    const messages: RawMessage[] = [];
    let after = 0;
    while (true) {
      const envelope = parseRecord(
        await json(`/v1/tasks/${encodeURIComponent(task.taskId)}/messages?after=${after}`, { signal }),
        "messages response"
      );
      const page = parseArray(envelope.messages, "messages response.messages", parseMessage);
      const cursor = integer(envelope.cursor, "messages response.cursor");
      if (page.length > taskMessagePageSize) throw new Error("messages response exceeded the page size limit");
      if (cursor < after) throw new Error("messages response cursor moved backwards");
      if (page.length === 0) {
        if (cursor !== after) throw new Error("messages response cursor advanced without messages");
        return messages;
      }
      if (cursor === after) throw new Error("messages response cursor did not advance");

      let previousSequence = after;
      for (const message of page) {
        if (message.taskId !== task.taskId || message.projectId !== task.projectId) {
          throw new Error("messages response belongs to another task or project");
        }
        if (message.sequence <= previousSequence) throw new Error("messages response is not in chronological order");
        previousSequence = message.sequence;
      }
      if (cursor !== previousSequence) throw new Error("messages response cursor does not match its final message");
      if (messages.length + page.length > maximumTaskMessages) {
        throw new Error(`messages response exceeded the ${maximumTaskMessages}-message task limit`);
      }
      messages.push(...page);
      if (page.length < taskMessagePageSize) return messages;
      after = cursor;
    }
  }

  async function paginatedWorkItems(initialValue: unknown, signal?: AbortSignal): Promise<RawWorkItem[]> {
    const merged: RawWorkItem[] = [];
    const positionsById = new Map<string, number>();
    const seenCursors = new Set<string>();
    let value = initialValue;
    let pages = 0;
    let rawRows = 0;

    while (true) {
      pages += 1;
      const page = workItemPageFromEnvelope(value, `work items response page ${pages}`);
      rawRows += page.workItems.length;
      if (rawRows > maximumRawWorkItems) {
        throw new Error(
          `work items response exceeded the ${maximumRawWorkItems.toLocaleString()}-record raw pagination limit`
        );
      }
      for (const workItem of page.workItems) {
        const position = positionsById.get(workItem.workItemId);
        if (position === undefined) {
          positionsById.set(workItem.workItemId, merged.length);
          merged.push(workItem);
        } else if (workItem.version > merged[position]!.version) {
          merged[position] = workItem;
        }
      }

      const cursor = page.nextCursor;
      if (cursor === null) return merged;
      if (seenCursors.has(cursor)) throw new Error("work items response repeated a pagination cursor");
      seenCursors.add(cursor);
      if (pages >= maximumWorkItemPages || rawRows >= maximumRawWorkItems) {
        throw new Error(
          `work items response exceeded the ${maximumWorkItemPages}-page or ${maximumRawWorkItems.toLocaleString()}-record pagination limit`
        );
      }
      value = await json(`/v1/work-items?cursor=${encodeURIComponent(cursor)}`, { signal });
    }
  }

  return {
    async getSnapshot(signal, requestMarker) {
      const markerHeaders = requestMarker === undefined ? undefined : { "x-nexus-refresh-kind": requestMarker };
      const [projectsValue, workItemsValue] = await Promise.all([
        json("/v1/projects", { signal, headers: markerHeaders }),
        json("/v1/work-items", { signal, headers: markerHeaders }),
      ]);
      const projectsEnvelope = parseRecord(projectsValue, "projects response");
      const projects = parseArray(projectsEnvelope.projects, "projects response.projects", parseProject);
      const workItems = await paginatedWorkItems(workItemsValue, signal);
      const boards = await mapWithConcurrency(projects, 6, async (project) => {
        return parseRawBoard(await json(`/v1/projects/${encodeURIComponent(project.projectId)}/board`, { signal }));
      });
      const tasks = boards.flatMap((board) => board.tasks);
      const messageGroups = await mapWithConcurrency(tasks, 6, (task) => taskMessages(task, signal));
      const rawMessages = messageGroups.flat();
      context.agentRoles.clear();
      context.questionVersions.clear();
      context.taskAgents.clear();
      context.taskPolicies.clear();
      context.runAgents.clear();
      for (const board of boards) {
        for (const agent of board.agents) context.agentRoles.set(agent.agentId, agent.role);
        for (const question of board.questions) context.questionVersions.set(question.questionId, question.version);
        for (const task of board.tasks) {
          context.taskPolicies.set(task.taskId, { kind: task.kind, requiredRole: task.requiredRole });
          if (task.assignedAgentId) context.taskAgents.set(task.taskId, task.assignedAgentId);
        }
        for (const run of board.runs) context.runAgents.set(run.runId, run.agentId);
      }
      return normalize(boards, projects, rawMessages, workItems);
    },
    async getBoardPause(signal) {
      return parseBoardPause(await json("/v1/board/pause", { signal }), "board pause response");
    },
    async setBoardPause(input) {
      const reason = input.reason === null ? null : boundedText(input.reason.trim(), "board pause reason", 500);
      return parseBoardPause(
        await json("/v1/board/pause", {
          method: "POST",
          body: JSON.stringify({
            reason,
            version: integer(input.version, "board pause.version", 1),
          }),
        }),
        "board pause response"
      );
    },
    async resumeBoard(input) {
      return parseBoardPause(
        await json("/v1/board/resume", {
          method: "POST",
          body: JSON.stringify({ version: integer(input.version, "board resume.version", 1) }),
        }),
        "board resume response"
      );
    },
    async getFindingsLedger(projectId, signal) {
      const query = projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`;
      return parseFindingsLedger(await json(`/v1/ledgers/findings${query}`, { signal }), "findings ledger response");
    },
    async getParksLedger(signal) {
      return parseParksLedger(await json("/v1/ledgers/parks", { signal }), "parks ledger response");
    },
    async getNotifications(signal) {
      const envelope = parseRecord(await json("/v1/notifications", { signal }), "notifications response");
      const unread = parseArray(envelope.unread, "notifications response.unread", parseBoardNotification);
      const recentRead = parseArray(envelope.recentRead, "notifications response.recentRead", parseBoardNotification);
      if (unread.length > 100) throw new Error("notifications response.unread cannot contain more than 100 records");
      if (recentRead.length > 50)
        throw new Error("notifications response.recentRead cannot contain more than 50 records");
      return { unread, recentRead };
    },
    async markNotificationRead(notificationId, version) {
      const envelope = parseRecord(
        await json(`/v1/notifications/${encodeURIComponent(notificationId)}/read`, {
          method: "POST",
          body: JSON.stringify({ version: integer(version, "notification read.version", 1) }),
        }),
        "notification read response"
      );
      return parseBoardNotification(envelope.notification, "notification read response.notification");
    },
  };
}
