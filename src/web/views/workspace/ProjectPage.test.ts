import type { BoardAgent, BoardProject, BoardSnapshot } from "../../types";
import type { TaskBoardClient } from "../../data/client";
import { AgentPage } from "./AgentPage";
import { Modal } from "../../components/ui";
import { ProjectPage, deriveInterruptAllOutcome } from "./ProjectPage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/ui")>();
  return { ...actual, Modal: vi.fn(() => null) };
});

const timestamp = "2026-08-28T12:00:00.000Z";
const project: BoardProject = {
  id: "project-one",
  name: "Project one",
  description: "Project context.",
  repoPath: "/repos/project-one",
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
};
const agent: BoardAgent = {
  id: "agent-one",
  projectId: project.id,
  name: "Agent one",
  role: "engineer",
  area: "Project one",
  mission: "Implement the project.",
  repositoryId: null,
  model: "auto",
  status: "sleeping",
  workerConnection: null,
  lastError: null,
  currentTaskId: null,
  lastEventAt: null,
  lastEventAtMs: null,
  version: 1,
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
};
const snapshot: BoardSnapshot = {
  revision: 1,
  generatedAt: timestamp,
  generatedAtMs: Date.parse(timestamp),
  workItems: [],
  projects: [project],
  repositories: [],
  agents: [agent],
  tasks: [],
  messages: [],
  questions: [],
  runs: [],
};

beforeEach(() => {
  vi.mocked(Modal).mockClear();
});

describe("workspace confirmation surfaces", () => {
  it("renders project description as context and repoPath as its repository path", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPage, {
        project,
        snapshot,
        onTask: vi.fn(),
        onAddTask: vi.fn(),
        client: { getProjectArtifacts: vi.fn() } as unknown as TaskBoardClient,
        connected: true,
      })
    );

    expect(markup).toContain("/repos/project-one");
    expect(markup).toContain("Project context.");
    expect(markup).toContain("Repository");
  });

  it("renders the interrupt and token-rotation confirms as anchored variants", () => {
    renderToStaticMarkup(
      createElement(ProjectPage, {
        project,
        snapshot,
        onTask: vi.fn(),
        onAddTask: vi.fn(),
        client: { getProjectArtifacts: vi.fn() } as unknown as TaskBoardClient,
        connected: true,
      })
    );
    renderToStaticMarkup(
      createElement(AgentPage, {
        agent,
        snapshot,
        isPointOfContact: false,
        explicitPointOfContact: false,
        busy: false,
        rotationErrors: [],
        onDismissActionError: vi.fn(),
        onTask: vi.fn(),
        onSend: vi.fn(),
        onAnswer: vi.fn(),
        onRotateToken: vi.fn(),
      })
    );

    const modalProps = vi.mocked(Modal).mock.calls.map(([props]) => props);
    expect(modalProps.find(({ title }) => String(title).startsWith("Interrupt "))).toMatchObject({
      variant: "anchored",
      anchorRef: { current: null },
    });
    expect(modalProps.find(({ title }) => title === "Rotate agent token?")).toMatchObject({
      variant: "anchored",
      anchorRef: { current: null },
    });
  });
});

describe("deriveInterruptAllOutcome", () => {
  it("counts live interrupts, already-finished runs, and failures separately", () => {
    const error = new Error("network unavailable");
    expect(
      deriveInterruptAllOutcome(
        ["run-live", "run-finished", "run-failed"],
        [
          { status: "fulfilled", value: { runId: "run-live" } },
          { status: "fulfilled", value: { runId: null } },
          { status: "rejected", reason: error },
        ]
      )
    ).toEqual({
      handledRunIds: ["run-live", "run-finished"],
      interruptedCount: 1,
      alreadyFinishedCount: 1,
      failedCount: 1,
    });
  });
});
