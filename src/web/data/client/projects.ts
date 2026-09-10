/** Provides project, repository, workflow, and artifact methods over shared client state. */

import type { BoardRepository } from "../../types";
import type { TaskBoardClient } from "../client";
import { parseRepositoryEntity } from "@shared/task-board-contract/validate";
import { boundedText, parseArray, parseRecord } from "../parse/scalars";
import { parseProjectArtifact, parseWorkflowEvent } from "../parse/workflow";
import { SseFrameParser } from "../sse";
import { requestJson, type TaskBoardClientContext } from "./context";
import {
  parseHostDirectoryListing,
  parseHostProjectRoot,
  planRejectionFromEnvelope,
  projectFromEnvelope,
  workflowFromEnvelope,
} from "./envelopes";

/* —— Response projection —— */

function repositoryFromEnvelope(value: unknown, path: string): BoardRepository {
  const envelope = parseRecord(value, path);
  const repository = parseRepositoryEntity(envelope.repository, `${path}.repository`);
  return {
    id: repository.repositoryId,
    projectId: repository.projectId,
    name: repository.name,
    path: repository.path,
    isPrimary: repository.isPrimary,
    version: repository.version,
  };
}

/* —— Project methods —— */

export function createProjectMethods(
  context: TaskBoardClientContext
): Pick<
  TaskBoardClient,
  | "createProject"
  | "updateProject"
  | "addRepository"
  | "updateRepository"
  | "getHostProjectRoots"
  | "getHostDirectories"
  | "getProjectWorkflow"
  | "getProjectArtifacts"
  | "confirmWorkflow"
  | "rejectWorkflowPlan"
  | "subscribeProjectEvents"
  | "getArtifactBlob"
> {
  const json = (path: string, init?: RequestInit): Promise<unknown> => requestJson(context, path, init);

  return {
    async createProject(input) {
      return projectFromEnvelope(
        await json("/v1/projects", {
          method: "POST",
          body: JSON.stringify(input),
        }),
        "create project response"
      );
    },
    async updateProject(projectId, input) {
      return projectFromEnvelope(
        await json(`/v1/projects/${encodeURIComponent(projectId)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
        "update project response"
      );
    },
    async addRepository(projectId, input) {
      return repositoryFromEnvelope(
        await json(`/v1/projects/${encodeURIComponent(projectId)}/repositories`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
        "add repository response"
      );
    },
    async updateRepository(repositoryId, input) {
      return repositoryFromEnvelope(
        await json(`/v1/repositories/${encodeURIComponent(repositoryId)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
        "update repository response"
      );
    },
    async getHostProjectRoots(signal) {
      const envelope = parseRecord(await json("/v1/host/project-roots", { signal }), "host roots response");
      return parseArray(envelope.roots, "host roots response.roots", parseHostProjectRoot);
    },
    async getHostDirectories(path, signal) {
      const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
      const envelope = parseRecord(await json(`/v1/host/directories${query}`, { signal }), "host directories response");
      return parseHostDirectoryListing(envelope.listing, "host directories response.listing");
    },
    async getProjectWorkflow(projectId, signal) {
      return workflowFromEnvelope(
        await json(`/v1/projects/${encodeURIComponent(projectId)}/workflow`, { signal }),
        "workflow response"
      );
    },
    async getProjectArtifacts(projectId, signal) {
      const envelope = parseRecord(
        await json(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`, { signal }),
        "artifacts response"
      );
      return parseArray(envelope.artifacts, "artifacts response.artifacts", parseProjectArtifact);
    },
    async confirmWorkflow(planRevisionId) {
      return workflowFromEnvelope(
        await json(`/v1/plans/${encodeURIComponent(planRevisionId)}/confirm`, {
          method: "POST",
          body: JSON.stringify({ expectedState: "proposed" }),
        }),
        "confirm workflow response"
      );
    },
    async rejectWorkflowPlan(planRevisionId, note) {
      const parsedNote = boundedText(note, "plan rejection note", 2_000);
      return planRejectionFromEnvelope(
        await json(`/v1/plans/${encodeURIComponent(planRevisionId)}/reject`, {
          method: "POST",
          body: JSON.stringify({ note: parsedNote, expectedState: "proposed" }),
        }),
        "reject workflow plan response"
      );
    },
    async subscribeProjectEvents(input) {
      const response = await context.request(
        `/v1/projects/${encodeURIComponent(input.projectId)}/workflow/events?after=${input.after}`,
        { signal: input.signal, headers: { accept: "text/event-stream" } }
      );
      if (!response.body) throw new Error("The workflow event stream returned no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser({
        maximumFrameLength: 64 * 1_024,
        onEvent: (event) => {
          if (!event.data) return;
          const envelope = parseRecord(JSON.parse(event.data) as unknown, "workflow event");
          input.onEvent(parseWorkflowEvent(envelope.event, "workflow event.event"));
        },
        sizeLimitError: () => new Error("A workflow event exceeded the size limit"),
      });
      try {
        while (true) {
          const chunk = await reader.read();
          parser.push(decoder.decode(chunk.value, { stream: !chunk.done }));
          if (chunk.done) {
            parser.finish();
            return;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
    async getArtifactBlob(artifactId, signal) {
      return context
        .request(`/v1/artifacts/${encodeURIComponent(artifactId)}`, { signal })
        .then((response) => response.blob());
    },
  };
}
