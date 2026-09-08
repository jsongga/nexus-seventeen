/** Verifies work-item detail states, labels, and human actions. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../components/ui";
import type { TaskBoardClient } from "../data/client";
import type { BoardChildWorkItem, BoardQuestion, BoardRepository, BoardTask, BoardWorkItem } from "../types";
import { WorkItemDetail } from "./WorkItemDetail";
import { FinalApprovalActions, FinalRejectionForm, WorkItemFooterActions } from "./work-item/approval";
import { AttestDeploymentForm, ContractAttestationGate } from "./work-item/deployment";
import { GapReportSection } from "./work-item/evidence";
import { ChildrenSection, ParentWorkItemLink, familyNotParentAfterSnapshot } from "./work-item/family";

vi.mock("../components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ui")>();
  return { ...actual, Modal: vi.fn(() => null) };
});

const timestamp = "2026-08-16T00:00:00.000Z";
const repositories: BoardRepository[] = [
  {
    id: "repository-primary",
    projectId: "project-one",
    name: "Platform API",
    path: "/repos/platform-api",
    isPrimary: true,
    version: 1,
  },
  {
    id: "repository-web",
    projectId: "project-one",
    name: "Platform web",
    path: "/repos/platform-web",
    isPrimary: false,
    version: 2,
  },
];

const parkedWorkItem: BoardWorkItem = {
  id: "work-item-one",
  originalRequest: "Plan the next campaign.",
  refinedObjective: null,
  priority: "normal",
  taskType: "standard",
  projectTarget: { mode: "auto" },
  resolvedProjectId: "project-one",
  repositoryId: null,
  parentWorkItemId: null,
  phase: null,
  childOrdinal: null,
  planningTaskId: "planning-task-one",
  state: "parked",
  currentStage: "planning",
  createdBy: "operator-one",
  version: 1,
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
  endedAt: null,
  endedAtMs: null,
  cancelledReason: null,
  archivedAt: null,
  archivedAtMs: null,
};

const planningTask: BoardTask = {
  id: "planning-task-one",
  projectId: "project-one",
  parentTaskId: null,
  kind: "work",
  requiredRole: "engineer",
  requiresReview: false,
  title: "Plan the campaign",
  objective: "Prepare the campaign plan.",
  acceptanceCriteria: null,
  workspaceRefs: [],
  assignedAgentId: "agent-one",
  assignedRole: "engineer",
  status: "waiting_for_human",
  expectedAgentMinutes: null,
  estimateRecordedAt: null,
  estimateRecordedAtMs: null,
  expectedCompletedAt: null,
  expectedCompletedAtMs: null,
  orderKey: 1,
  phases: [],
  startedAt: timestamp,
  startedAtMs: Date.parse(timestamp),
  endedAt: null,
  endedAtMs: null,
  result: null,
  version: 1,
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
};

const expandChild: BoardChildWorkItem = {
  ...parkedWorkItem,
  id: "expand-child",
  originalRequest: "Publish the additive interface.",
  refinedObjective: "Publish the additive interface.",
  parentWorkItemId: "parent-one",
  phase: "expand",
  childOrdinal: 0,
  state: "merged",
  currentStage: null,
  endedAt: timestamp,
  endedAtMs: Date.parse(timestamp),
  deployAttested: true,
  mergeSha: "0123456789abcdef0123456789abcdef01234567",
};

const openQuestion: BoardQuestion = {
  id: "question-one",
  projectId: "project-one",
  taskId: planningTask.id,
  agentId: "agent-one",
  prompt: "Which audience should this target?",
  status: "open",
  answer: null,
  askedAt: timestamp,
  askedAtMs: Date.parse(timestamp),
  answeredAt: null,
  answeredAtMs: null,
  version: 1,
};

function renderParkedDetail(question: BoardQuestion | null, workItem: BoardWorkItem = parkedWorkItem): string {
  const ok = async () => ({ ok: true as const });
  return renderToStaticMarkup(
    createElement(WorkItemDetail, {
      workItem,
      snapshotRevision: 1,
      projectName: "Project one",
      projects: [],
      repositories,
      parentWorkItem: null,
      planningTask,
      openQuestion: question,
      client: {} as TaskBoardClient,
      busy: false,
      onClose: () => undefined,
      onAnswer: ok,
      onConfirm: ok,
      onAttestDeploy: ok,
      onResumeCoordination: ok,
      onCancel: ok,
      onArchive: ok,
    })
  );
}

describe("parked work-item detail", () => {
  it("shows a neutral parked notice when there is no open question", () => {
    const markup = renderParkedDetail(null);

    expect(markup).toContain("Parked — no open question. Retry or reassign from the task view.");
    expect(markup).not.toContain("Planning needs your input");
  });

  it("shows the question UI when there is an open question", () => {
    const markup = renderParkedDetail(openQuestion);

    expect(markup).toContain("Planning needs your input");
    expect(markup).toContain("Which audience should this target?");
    expect(markup).not.toContain("Parked — no open question. Retry or reassign from the task view.");
  });

  it("names inherited and pinned repository targets", () => {
    expect(renderParkedDetail(null)).toContain("Platform API (inherits primary)");
    expect(renderParkedDetail(null, { ...parkedWorkItem, repositoryId: "repository-web" })).toContain(
      "Platform web (pinned)"
    );
  });
});

describe("work-item confirmation surfaces", () => {
  it("anchors only the dirty-free merge and archive confirms", () => {
    vi.mocked(Modal).mockClear();
    renderParkedDetail(null);

    const modalProps = new Map(vi.mocked(Modal).mock.calls.map(([props]) => [props.title, props]));
    expect(modalProps.get("Approve and merge pipeline")).toMatchObject({
      variant: "anchored",
      anchorRef: { current: null },
    });
    expect(modalProps.get("Archive work item")).toMatchObject({
      variant: "anchored",
      anchorRef: { current: null },
    });
    expect(modalProps.get("Attest deployment")).toMatchObject({
      variant: "anchored",
      anchorRef: { current: null },
    });
    expect(modalProps.get("Resume coordination")).toMatchObject({
      variant: "anchored",
      anchorRef: { current: null },
    });
    for (const takeoverTitle of ["Cancel work item", "Reject proposed plan", "Request implementation changes"]) {
      const takeoverProps = modalProps.get(takeoverTitle);
      expect(takeoverProps).toBeDefined();
      expect(takeoverProps).not.toHaveProperty("variant");
      expect(takeoverProps).not.toHaveProperty("anchorRef");
    }
  });

  it("pins the parent approval dialog and action names", () => {
    const unphasedChild = { ...expandChild, phase: null };
    const actions = renderToStaticMarkup(
      createElement(FinalApprovalActions, {
        busy: false,
        approveAnchorRef: { current: null },
        mode: unphasedChild.phase === null ? "parent" : "pipeline",
        onApprove: vi.fn(),
        onRequestChanges: vi.fn(),
      })
    );
    const confirmation = renderToStaticMarkup(
      createElement(FinalRejectionForm, {
        workItemId: "parent-one",
        note: "Revise the child.",
        busy: false,
        errors: [],
        onNoteChange: vi.fn(),
        onDismissError: vi.fn(),
        onSubmit: vi.fn(),
        onKeep: vi.fn(),
        parent: true,
      })
    );

    expect(actions).toContain("Approve &amp; merge children");
    expect(actions).toContain("Send back to coordination");
    expect(actions).toContain("scroll-mt-14");
    expect(confirmation).toContain("Send back");
    expect(confirmation).not.toContain("Send back to coordination");
  });

  it("pins that a child gets no parent affordances", () => {
    vi.mocked(Modal).mockClear();
    const ok = async () => ({ ok: true as const });
    const markup = renderToStaticMarkup(
      createElement(WorkItemDetail, {
        workItem: { ...expandChild, phase: null, state: "final_approval" },
        snapshotRevision: 1,
        projectName: "Project one",
        projects: [],
        repositories,
        parentWorkItem: parkedWorkItem,
        planningTask: null,
        openQuestion: null,
        client: {} as TaskBoardClient,
        initialFamily: {
          state: "ready",
          children: [
            { ...expandChild, phase: null, state: "final_approval" },
            {
              ...expandChild,
              id: "sibling-child",
              phase: null,
              state: "final_approval",
            },
          ],
          dependencies: [],
          error: null,
        },
        busy: false,
        onClose: vi.fn(),
        onAnswer: ok,
        onConfirm: ok,
        onApproveMerge: ok,
        onRejectFinal: ok,
        onAttestDeploy: ok,
        onResumeCoordination: ok,
        onCancel: ok,
        onArchive: ok,
      })
    );
    const modalTitles = vi.mocked(Modal).mock.calls.map(([props]) => props.title);

    expect(markup).not.toContain("Approve &amp; merge children");
    expect(markup).not.toContain("Resume coordination");
    expect(modalTitles).toContain("Approve and merge pipeline");
    expect(modalTitles).not.toContain("Approve and merge children");
  });
});

describe("decomposition detail sections", () => {
  it("opens a child parent through the per-id detail loader and clears a stale non-parent latch", () => {
    const open = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(ParentWorkItemLink, {
        parentWorkItemId: "parent-one",
        parentWorkItem: parkedWorkItem,
        onOpenWorkItem: open,
      })
    );

    expect(markup).toContain('data-detail-source="work-item-id"');
    expect(markup).toContain("<button");
    expect(markup).not.toContain("href=");
    expect(familyNotParentAfterSnapshot(true, true)).toBe(false);
    expect(familyNotParentAfterSnapshot(true, false)).toBe(true);
  });

  it("renders the ordered children table with phase, project, state, attestation, and links", () => {
    const markup = renderToStaticMarkup(
      createElement(ChildrenSection, {
        children: [
          expandChild,
          {
            ...expandChild,
            id: "contract-child",
            originalRequest: "Remove the compatibility path.",
            phase: "contract",
            childOrdinal: 2,
            state: "queued",
            endedAt: null,
            endedAtMs: null,
            deployAttested: false,
            mergeSha: null,
          },
        ],
        projects: [
          {
            id: "project-one",
            name: "Provider project",
            description: null,
            repoPath: "/repos/provider",
            createdAt: timestamp,
            createdAtMs: Date.parse(timestamp),
            updatedAt: timestamp,
            updatedAtMs: Date.parse(timestamp),
          },
        ],
        state: "ready",
        error: null,
        onRetry: vi.fn(),
      })
    );

    for (const text of [
      "Children",
      "Ordinal",
      "Phase",
      "Project",
      "State",
      "Attestation",
      "Expand",
      "Contract",
      "Provider project",
      "Attested",
      "Not required",
      "Open child",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain("#/intake/expand-child");
    expect(markup).toContain('data-detail-source="work-item-id"');
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("overflow-x-auto");
  });

  it("renders a recoverable children error", () => {
    const markup = renderToStaticMarkup(
      createElement(ChildrenSection, {
        children: [],
        projects: [],
        state: "error",
        error: "Family unavailable.",
        onRetry: vi.fn(),
      })
    );

    expect(markup).toContain("Family unavailable.");
    expect(markup).toContain("Retry");
  });

  it("keeps loading and empty candidate sections invisible", () => {
    const loading = renderToStaticMarkup(
      createElement(ChildrenSection, {
        children: [],
        projects: [],
        state: "loading",
        error: null,
        onRetry: vi.fn(),
      })
    );
    const empty = renderToStaticMarkup(
      createElement(ChildrenSection, {
        children: [],
        projects: [],
        state: "ready",
        error: null,
        onRetry: vi.fn(),
      })
    );

    expect(loading).toBe("");
    expect(empty).toBe("");
  });

  it("renders inline attestation only for merged unattested Expand and Migrate rows", () => {
    const markup = renderToStaticMarkup(
      createElement(ChildrenSection, {
        children: [
          { ...expandChild, deployAttested: false },
          { ...expandChild, id: "migrate-child", phase: "migrate", deployAttested: false },
          { ...expandChild, id: "attested-child", deployAttested: true },
        ],
        projects: [],
        state: "ready",
        error: null,
        onRetry: vi.fn(),
        onAttestChild: vi.fn(),
      })
    );

    expect(markup.match(/Attest deployed/gu)).toHaveLength(2);
    expect(markup).toContain("Open child");
  });

  it("pins the attestation dialog form names and Contract dependency statuses", () => {
    const form = renderToStaticMarkup(
      createElement(AttestDeploymentForm, {
        workItemId: expandChild.id,
        note: "",
        busy: false,
        errors: [],
        onNoteChange: vi.fn(),
        onDismissError: vi.fn(),
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
      })
    );
    expect(form).toContain("Note");
    expect(form).toContain("Optional");
    expect(form).toContain("Attest deployed");
    expect(form).toContain("Cancel");

    const gate = renderToStaticMarkup(
      createElement(ContractAttestationGate, {
        statuses: [
          { child: expandChild, direct: true, ready: true },
          {
            child: { ...expandChild, id: "migrate-child", phase: "migrate", deployAttested: false },
            direct: true,
            ready: false,
          },
        ],
        phase: "contract",
        state: "ready",
        error: null,
        onRetry: vi.fn(),
      })
    );
    expect(gate).toContain("Deployment attestations");
    expect(gate).toContain("Blocked");
    expect(gate).toContain("Direct dependency");
    expect(gate).toContain("Not attested");

    const unknown = renderToStaticMarkup(
      createElement(ContractAttestationGate, {
        statuses: [{ child: expandChild, direct: true, ready: true }],
        phase: "unrecognized",
        state: "ready",
        error: null,
        onRetry: vi.fn(),
      })
    );
    expect(unknown).toContain("Blocked");

    const failed = renderToStaticMarkup(
      createElement(ContractAttestationGate, {
        statuses: [],
        phase: "contract",
        state: "error",
        error: "The family could not load.",
        onRetry: vi.fn(),
      })
    );
    expect(failed).toContain("The family could not load.");
    expect(failed).toContain("Retry");
  });

  it("pins resume and blocks archiving a merged unattested phased child", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemFooterActions, {
        busy: false,
        finalActionBusy: false,
        showResume: true,
        showCancel: false,
        showArchive: true,
        archiveDisabled: true,
        archiveHintId: "archive-hint",
        resumeAnchorRef: { current: null },
        archiveAnchorRef: { current: null },
        onResume: vi.fn(),
        onCancel: vi.fn(),
        onArchive: vi.fn(),
      })
    );

    expect(markup).toContain("Resume coordination");
    expect(markup).toContain("Attest deployment before archiving");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="archive-hint"[^>]*>.*Archive/su);
    expect(markup).toContain("scroll-mt-14");
  });

  it("keeps candidate families silent until children are known and makes a known-parent 500 recoverable", () => {
    const ok = async () => ({ ok: true as const });
    const renderCandidate = (
      initialFamily: {
        state: "ready" | "error";
        children: BoardChildWorkItem[];
        dependencies: [];
        error: string | null;
        status?: number;
      },
      knownParent = false
    ) =>
      renderToStaticMarkup(
        createElement(WorkItemDetail, {
          workItem: { ...parkedWorkItem, state: "final_approval" },
          snapshotRevision: 1,
          projectName: "Project one",
          projects: [],
          repositories,
          parentWorkItem: null,
          planningTask: null,
          openQuestion: null,
          client: {} as TaskBoardClient,
          initialFamily,
          knownParent,
          busy: false,
          onClose: vi.fn(),
          onAnswer: ok,
          onConfirm: ok,
          onAttestDeploy: ok,
          onResumeCoordination: ok,
          onCancel: ok,
          onArchive: ok,
        })
      );

    const empty = renderCandidate({ state: "ready", children: [], dependencies: [], error: null });
    const notFound = renderCandidate({
      state: "error",
      children: [],
      dependencies: [],
      error: "Not found.",
      status: 404,
    });
    const failed = renderCandidate(
      { state: "error", children: [], dependencies: [], error: "Server failed.", status: 500 },
      true
    );

    expect(empty).not.toContain("work-item-children-heading");
    expect(notFound).not.toContain("work-item-children-heading");
    expect(notFound).not.toContain("Not found.");
    expect(failed).toContain("Children could not be loaded");
    expect(failed).toContain("Server failed.");
    expect(failed).toContain("Retry");
  });

  it("shows terminal-parent children for inspection", () => {
    const ok = async () => ({ ok: true as const });
    for (const state of ["abandoned", "dead_letter"] as const) {
      const markup = renderToStaticMarkup(
        createElement(WorkItemDetail, {
          workItem: { ...parkedWorkItem, state },
          snapshotRevision: 1,
          projectName: "Project one",
          projects: [],
          repositories,
          parentWorkItem: null,
          planningTask: null,
          openQuestion: null,
          client: {} as TaskBoardClient,
          initialFamily: { state: "ready", children: [expandChild], dependencies: [], error: null },
          knownParent: true,
          busy: false,
          onClose: vi.fn(),
          onAnswer: ok,
          onConfirm: ok,
          onAttestDeploy: ok,
          onResumeCoordination: ok,
          onCancel: ok,
          onArchive: ok,
        })
      );
      expect(markup, state).toContain("work-item-children-heading");
      expect(markup, state).toContain("Open child");
    }
  });

  it("pins phased child-failure cancellation and unphased resume", () => {
    const ok = async () => ({ ok: true as const });
    const renderFamily = (phase: BoardChildWorkItem["phase"]) =>
      renderToStaticMarkup(
        createElement(WorkItemDetail, {
          workItem: parkedWorkItem,
          snapshotRevision: 1,
          projectName: "Project one",
          projects: [],
          repositories,
          parentWorkItem: null,
          planningTask: null,
          openQuestion: null,
          client: {} as TaskBoardClient,
          initialFamily: {
            state: "ready",
            children: [{ ...expandChild, phase, state: "dead_letter" }],
            dependencies: [],
            error: null,
          },
          knownParent: true,
          busy: false,
          onClose: vi.fn(),
          onAnswer: ok,
          onConfirm: ok,
          onAttestDeploy: ok,
          onResumeCoordination: ok,
          onCancel: ok,
          onArchive: ok,
        })
      );

    const phased = renderFamily("expand");
    const unphased = renderFamily(null);
    expect(phased).not.toContain("Resume coordination");
    expect(phased).toContain("A phase failed — cancel the coordination to abandon it");
    expect(phased).toContain("Cancel work item");
    expect(unphased).toContain("Resume coordination");
    expect(unphased).not.toContain("A phase failed — cancel the coordination to abandon it");
  });

  it("pins the anchored base-change resume action on a parked child detail", () => {
    vi.mocked(Modal).mockClear();
    const ok = async () => ({ ok: true as const });
    const baseDivergedChild = {
      ...parkedWorkItem,
      id: "base-diverged-child",
      parentWorkItemId: parkedWorkItem.id,
      phase: "expand" as const,
      planningTaskId: null,
      currentStage: null,
      parkCategory: "base_diverged" as const,
    };

    const markup = renderToStaticMarkup(
      createElement(WorkItemDetail, {
        workItem: baseDivergedChild,
        snapshotRevision: 1,
        projectName: "Project one",
        projects: [],
        repositories,
        parentWorkItem: parkedWorkItem,
        planningTask: null,
        openQuestion: null,
        client: {} as TaskBoardClient,
        initialFamily: { state: "ready", children: [], dependencies: [], error: null },
        busy: false,
        onClose: vi.fn(),
        onAnswer: ok,
        onConfirm: ok,
        onAttestDeploy: ok,
        onResumeCoordination: ok,
        onCancel: ok,
        onArchive: ok,
      })
    );

    expect(markup).toContain("Resume after base change");
    expect(markup).not.toContain("Resume coordination");
    expect(vi.mocked(Modal).mock.calls.find(([props]) => props.title === "Resume child")?.[0]).toMatchObject({
      variant: "anchored",
      anchorRef: { current: null },
      description: expect.stringContaining("current repository head"),
    });
  });

  it("renders Retry in a child deployment-attestation failure section", () => {
    const ok = async () => ({ ok: true as const });
    const markup = renderToStaticMarkup(
      createElement(WorkItemDetail, {
        workItem: expandChild,
        snapshotRevision: 1,
        projectName: "Project one",
        projects: [],
        repositories,
        parentWorkItem: parkedWorkItem,
        planningTask: null,
        openQuestion: null,
        client: {} as TaskBoardClient,
        initialFamily: {
          state: "error",
          children: [],
          dependencies: [],
          error: "Attestation lookup failed.",
          status: 500,
        },
        busy: false,
        onClose: vi.fn(),
        onAnswer: ok,
        onConfirm: ok,
        onAttestDeploy: ok,
        onResumeCoordination: ok,
        onCancel: ok,
        onArchive: ok,
      })
    );

    expect(markup).toContain("deployment-attestation-heading");
    expect(markup).toContain("Attestation lookup failed.");
    expect(markup).toContain("Retry");
  });
});

describe("onboarding gap report section", () => {
  it("renders distinct loading, recorded, empty, and recoverable error states", () => {
    const loading = renderToStaticMarkup(
      createElement(GapReportSection, {
        state: "loading",
        content: null,
        error: null,
        onRetry: () => undefined,
      })
    );
    const recorded = renderToStaticMarkup(
      createElement(GapReportSection, {
        state: "ready",
        content: "# Gaps\n\n- Branch protection is deferred.",
        error: null,
        onRetry: () => undefined,
      })
    );
    const empty = renderToStaticMarkup(
      createElement(GapReportSection, {
        state: "ready",
        content: null,
        error: null,
        onRetry: () => undefined,
      })
    );
    const failed = renderToStaticMarkup(
      createElement(GapReportSection, {
        state: "error",
        content: null,
        error: "Artifact content could not be loaded.",
        onRetry: () => undefined,
      })
    );

    expect(loading).toContain("Loading gap report…");
    expect(recorded).toContain("Gap report");
    expect(recorded).toContain("# Gaps");
    expect(recorded).toContain("Branch protection is deferred.");
    expect(empty).toContain("No gap report has been recorded yet.");
    expect(failed).toContain("Artifact content could not be loaded.");
    expect(failed).toContain("Retry");
  });
});
