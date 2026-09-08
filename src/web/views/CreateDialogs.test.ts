import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskBoardClient } from "../data/client";
import type { BoardSnapshot } from "../types";
import { CreateDialogs } from "./CreateDialogs";

const timestamp = "2026-08-25T12:00:00.000Z";
const snapshot: BoardSnapshot = {
  revision: 1,
  generatedAt: timestamp,
  generatedAtMs: Date.parse(timestamp),
  projects: [
    {
      id: "project-one",
      name: "Project one",
      description: "/workspace/project-one",
      repoPath: "/workspace/project-one",
      createdAt: timestamp,
      createdAtMs: Date.parse(timestamp),
      updatedAt: timestamp,
      updatedAtMs: Date.parse(timestamp),
    },
  ],
  repositories: [],
  agents: [],
  tasks: [],
  messages: [],
  questions: [],
  runs: [],
  workItems: [],
};

function renderDialog(dialog: "project" | "task") {
  return renderToStaticMarkup(
    createElement(CreateDialogs, {
      client: {} as TaskBoardClient,
      dialog,
      closeDialog: vi.fn(),
      keepEditingDialog: vi.fn(),
      projectRequestCloseRef: { current: null },
      taskRequestCloseRef: { current: null },
      projectFormDirty: { current: false },
      workItemFormDirty: { current: false },
      taskAnchorRef:
        dialog === "task" ? { current: { isConnected: true } as HTMLElement } : createRef<HTMLButtonElement>(),
      dialogProject: dialog === "task" ? snapshot.projects[0] : undefined,
      snapshot,
      busy: false,
      connected: true,
      projectCreateErrors: [],
      workItemCreateErrors: [],
      dismissActionError: vi.fn(),
      createProject: vi.fn(),
      createWorkItem: vi.fn(),
    })
  );
}

describe("create dialogs", () => {
  it("renders the anchored task form with its frozen names and no takeover scrim", () => {
    const markup = renderDialog("task");

    expect(markup).toContain(">Add a task to Project one</h2>");
    expect(markup).toContain(">Task</label>");
    expect(markup).toContain('for="work-item-task-type"');
    expect(markup).toContain(">Task type</label>");
    expect(markup).toContain(">Priority</label>");
    expect(markup).toContain(">Project</label>");
    expect(markup).toContain(">Submit task</button>");
    expect(markup).toContain('<option value="standard" selected="">Standard</option>');
    expect(markup).toContain('<option value="onboarding">Onboarding</option>');
    expect(markup).not.toContain('data-testid="modal-scrim"');
    expect(markup).not.toContain("aria-modal");
    expect(markup).toContain("flex-col overflow-hidden");
    expect(markup).toContain('<header class="flex shrink-0');
    expect(markup).not.toContain('<header class="sticky');
    expect(markup).toContain('<div class="min-h-0 flex-1 overflow-y-auto">');
  });

  it("keeps the project picker as a takeover dialog", () => {
    const markup = renderDialog("project");

    expect(markup).toContain(">Add project from disk</h2>");
    expect(markup).toContain('data-testid="modal-scrim"');
  });
});
