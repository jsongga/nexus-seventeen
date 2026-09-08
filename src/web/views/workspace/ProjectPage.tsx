/** Renders one project's workspace: its threads, context documents and bulk controls. */

/* —— Imports —— */

import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, Modal } from "../../components/ui";
import { ActivityFeed, type ActivityFeedUpdate } from "../ActivityFeed";
import type { InterruptRunResult, TaskBoardClient } from "../../data/client";
import { ContextSidebar, type ContextDocument } from "../ContextSidebar";
import type { ActionResult } from "../../model/action-errors";
import { parseProjectMetadata, type ProjectMetadataEntry } from "../../model/project-metadata";
import { ThreadPipelineTable } from "../ThreadPipelineTable";
import type { BoardProject, BoardSnapshot, ProjectArtifact } from "../../types";
import { WorkspaceHeader } from "../WorkspaceHeader";
import { type ProjectUpdate, updatesForProject } from "../../model/workspace-model";
import { beginArtifactPreviewLoad } from "../../model/artifact-previews";
import { ProjectRepositories } from "./ProjectRepositories";

/* —— Project page —— */

function projectLinkLabel(href: string): string {
  const url = new URL(href);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
  return `${url.host}${path}${url.search}${url.hash}`;
}

function resourceId(entry: ProjectMetadataEntry, index: number): string {
  return `${entry.key}:${entry.value}:${index}`;
}

function contextDocuments(entries: ProjectMetadataEntry[]): ContextDocument[] {
  return entries.map((entry, index) => ({
    ...entry,
    id: resourceId(entry, index),
    meta: entry.href ? projectLinkLabel(entry.href) : entry.value,
  }));
}

/** Adds every artifact to the feed without duplicating it across task messages. */
export function activityUpdates(updates: ProjectUpdate[], artifacts: ProjectArtifact[]): ActivityFeedUpdate[] {
  const taskTitleById = new Map(updates.map((update) => [update.taskId, update.taskTitle]));

  const artifactUpdates = artifacts.map((artifact): ActivityFeedUpdate => {
    const taskTitle = artifact.taskId ? taskTitleById.get(artifact.taskId) : undefined;
    return {
      id: `artifact:${artifact.artifactId}`,
      author: "Artifact",
      body: taskTitle
        ? `${artifact.caption} was added to ${taskTitle}.`
        : `${artifact.caption} was added to the project.`,
      createdAt: artifact.createdAt,
      createdAtMs: artifact.createdAtMs,
      artifacts: [
        {
          artifactId: artifact.artifactId,
          caption: artifact.caption,
          mediaType: artifact.mediaType,
        },
      ],
    };
  });

  return [
    ...updates.map(
      (update): ActivityFeedUpdate => ({
        id: update.id,
        author: update.author,
        body: update.body,
        createdAt: update.createdAt,
        createdAtMs: update.createdAtMs,
        artifacts: [],
      })
    ),
    ...artifactUpdates,
  ].sort((left, right) => right.createdAtMs - left.createdAtMs || left.id.localeCompare(right.id));
}

interface InterruptAllOutcome {
  handledRunIds: string[];
  interruptedCount: number;
  alreadyFinishedCount: number;
  failedCount: number;
}

export function deriveInterruptAllOutcome(
  runIds: readonly string[],
  results: readonly PromiseSettledResult<InterruptRunResult>[]
): InterruptAllOutcome {
  const outcome: InterruptAllOutcome = {
    handledRunIds: [],
    interruptedCount: 0,
    alreadyFinishedCount: 0,
    failedCount: 0,
  };
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      outcome.failedCount += 1;
      continue;
    }
    const runId = runIds[index];
    if (runId !== undefined) outcome.handledRunIds.push(runId);
    if (result.value.runId === null) outcome.alreadyFinishedCount += 1;
    else outcome.interruptedCount += 1;
  }
  return outcome;
}

export function ProjectPage({
  project,
  snapshot,
  onTask,
  onAddTask,
  client,
  connected,
  busy,
  onRepositoryMutation,
}: {
  project: BoardProject;
  snapshot: BoardSnapshot;
  onTask: (taskId: string) => void;
  onAddTask: (anchorRef: RefObject<HTMLElement | null>, event: Event) => void;
  client: TaskBoardClient;
  connected: boolean;
  busy: boolean;
  onRepositoryMutation: (operation: () => Promise<unknown>) => Promise<ActionResult>;
}) {
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string | null>>({});
  const [interruptingAll, setInterruptingAll] = useState(false);
  const [interruptConfirmationOpen, setInterruptConfirmationOpen] = useState(false);
  const [handledRunIds, setHandledRunIds] = useState<Set<string>>(() => new Set());
  const [interruptOutcome, setInterruptOutcome] = useState<Pick<
    InterruptAllOutcome,
    "interruptedCount" | "alreadyFinishedCount"
  > | null>(null);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const addTaskAnchorRef = useRef<HTMLButtonElement>(null);
  const interruptAllAnchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .getProjectArtifacts(project.id, controller.signal)
      .then((nextArtifacts) => {
        setArtifacts((current) =>
          current.length === nextArtifacts.length &&
          current.every((artifact, index) => artifact.artifactId === nextArtifacts[index]?.artifactId)
            ? current
            : nextArtifacts
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, project.id, snapshot.generatedAt]);

  useEffect(() => {
    setArtifactUrls({});
    const load = beginArtifactPreviewLoad({
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
      getBlob: (artifactId, signal) => client.getArtifactBlob(artifactId, signal),
      onPreview: (artifactId, url) => setArtifactUrls((current) => ({ ...current, [artifactId]: url })),
    });
    return () => load.dispose();
  }, [artifacts, client]);

  const updates = updatesForProject(snapshot, project.id);
  const metadata = parseProjectMetadata(project.description ?? "");
  const tasks = snapshot.tasks
    .filter((task) => task.projectId === project.id)
    .sort((left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id));
  const agents = snapshot.agents.filter((agent) => agent.projectId === project.id);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const documents = contextDocuments([...metadata.entries]);
  const repositories = useMemo(
    () => snapshot.repositories.filter((repository) => repository.projectId === project.id),
    [project.id, snapshot.repositories]
  );
  const feedUpdates = activityUpdates(updates, artifacts);
  const activeRuns = snapshot.runs.filter(
    (run) =>
      run.projectId === project.id &&
      (run.status === "running" || run.status === "queued") &&
      run.interruptRequestedAt === null &&
      !handledRunIds.has(run.id)
  );

  const interruptAllAgents = async () => {
    const runsToInterrupt = activeRuns;
    if (runsToInterrupt.length === 0) {
      setInterruptConfirmationOpen(false);
      return;
    }
    setInterruptingAll(true);
    setInterruptOutcome(null);
    setInterruptError(null);
    const results = await Promise.allSettled(runsToInterrupt.map((run) => client.interruptRun(run.id)));
    const outcome = deriveInterruptAllOutcome(
      runsToInterrupt.map((run) => run.id),
      results
    );
    if (outcome.handledRunIds.length > 0) {
      setHandledRunIds((current) => new Set([...current, ...outcome.handledRunIds]));
      setInterruptOutcome({
        interruptedCount: outcome.interruptedCount,
        alreadyFinishedCount: outcome.alreadyFinishedCount,
      });
    }
    if (outcome.failedCount > 0) {
      setInterruptError("Some active agents could not be interrupted. Refresh and try again.");
    }
    setInterruptingAll(false);
    setInterruptConfirmationOpen(false);
  };

  const openInterruptConfirmation = () => {
    setInterruptOutcome(null);
    setInterruptError(null);
    setInterruptConfirmationOpen(true);
  };

  const openArtifact = (artifactId: string) => {
    const url = artifactUrls[artifactId];
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <>
      <div className="flex h-[calc(100dvh-3.5rem)] min-w-0 flex-col overflow-hidden bg-canvas lg:h-dvh">
        <WorkspaceHeader
          eyebrow="Workspace, Project Overview"
          title={project.name}
          actions={
            <button
              ref={addTaskAnchorRef}
              type="button"
              className="flex size-8 items-center justify-center rounded-[99px] border-0 bg-canvas text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
              aria-label="Add task"
              title="Add task"
              data-dialog-trigger="task"
              disabled={!connected}
              onClick={(event) => onAddTask(addTaskAnchorRef, event.nativeEvent)}
            >
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          }
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
          <ContextSidebar
            intro={metadata.summaries.join("\n\n") || `Project context and reference materials for ${project.name}.`}
            documents={documents}
            orderStorageKey={`nexus-seventeen:project-resources:${project.id}`}
          />
          <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-hidden p-4 sm:gap-8 sm:p-8">
            <ProjectRepositories
              projectId={project.id}
              repositories={repositories}
              client={client}
              connected={connected}
              busy={busy}
              onMutation={onRepositoryMutation}
            />
            <ThreadPipelineTable tasks={tasks} agentById={agentById} onTask={onTask} />
            <div className="flex min-h-0 flex-1 flex-col">
              <ActivityFeed updates={feedUpdates} artifactUrls={artifactUrls} onOpenArtifact={openArtifact} />
              {interruptOutcome !== null ? (
                <p className="pt-2 text-right text-[11px] text-success" role="status" aria-live="polite">
                  {`Interrupted ${interruptOutcome.interruptedCount} ${interruptOutcome.interruptedCount === 1 ? "agent" : "agents"}${
                    interruptOutcome.alreadyFinishedCount > 0
                      ? `; ${interruptOutcome.alreadyFinishedCount} had already finished.`
                      : "."
                  }`}
                </p>
              ) : null}
              {interruptError ? (
                <p className="pt-2 text-right text-[11px] text-urgent" role="alert">
                  {interruptError}
                </p>
              ) : null}
              <div className="mt-auto flex justify-end gap-2 pt-4">
                <Button
                  ref={interruptAllAnchorRef}
                  variant="danger"
                  size="sm"
                  className="!min-h-0 !px-4 !py-2"
                  disabled={!connected || activeRuns.length === 0 || interruptingAll}
                  title={
                    !connected
                      ? "Reconnect the task board to interrupt agents"
                      : activeRuns.length === 0
                        ? "No active agents to interrupt"
                        : undefined
                  }
                  onClick={openInterruptConfirmation}
                >
                  {interruptingAll ? "Interrupting…" : "Interrupt all agents"}
                </Button>
                {/* Compile reporting stays disabled because no report endpoint exists. */}
                <Button
                  variant="primary"
                  size="sm"
                  className="!min-h-0 !border-0 !px-4 !py-2"
                  disabled
                  title="Compile Report is not implemented yet"
                >
                  Compile Report
                </Button>
              </div>
            </div>
          </section>
        </main>
      </div>
      <Modal
        open={interruptConfirmationOpen}
        onClose={() => {
          if (!interruptingAll) setInterruptConfirmationOpen(false);
        }}
        variant="anchored"
        anchorRef={interruptAllAnchorRef}
        title={`Interrupt ${activeRuns.length} ${activeRuns.length === 1 ? "agent" : "agents"}?`}
        description={`This will interrupt ${activeRuns.length} active ${activeRuns.length === 1 ? "agent" : "agents"} in ${project.name}.`}
      >
        <div className="space-y-4 p-5 sm:p-6">
          <p className="text-sm leading-6 text-muted">
            Interrupted tasks are recoverable via Retry from their task details.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              data-dialog-initial-focus
              disabled={interruptingAll}
              onClick={() => setInterruptConfirmationOpen(false)}
            >
              Cancel
            </Button>
            <Button variant="danger" disabled={interruptingAll} onClick={() => void interruptAllAgents()}>
              {interruptingAll ? "Interrupting…" : "Interrupt all agents"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
