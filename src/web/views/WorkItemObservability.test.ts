import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { markNotificationReadAndRefresh } from "../BoardApp";
import { NotificationsBlock } from "../board/notifications";
import { BoardPauseBanner } from "../board/pause";
import type { BoardNotifications, TaskBoardClient } from "../data/client";
import type { RawBoardNotification, RawBoardPause, RawWorkItemAudit } from "../data/parse";
import type { BoardSnapshot, BoardWorkItem, BoardWorkItemTransition } from "../types";
import { WorkItemRow } from "./TaskList";
import { AuditSection, StatusTimeline } from "./work-item/observability";
import { WorkspaceFrame } from "./WorkspaceSidebar";

const now = "2026-08-21T12:00:00.000Z";
const nowMs = Date.parse(now);

function workItem(overrides: Partial<BoardWorkItem> = {}): BoardWorkItem {
  return {
    id: "work-item-one",
    originalRequest: "Make operational state visible.",
    refinedObjective: null,
    priority: "normal",
    taskType: "standard",
    projectTarget: { mode: "explicit", projectId: "project-one" },
    resolvedProjectId: "project-one",
    repositoryId: null,
    planningTaskId: null,
    state: "reviewing",
    currentStage: "human_review",
    createdBy: "human:operator",
    version: 1,
    createdAt: "2026-08-21T10:00:00.000Z",
    createdAtMs: Date.parse("2026-08-21T10:00:00.000Z"),
    updatedAt: now,
    updatedAtMs: nowMs,
    endedAt: null,
    endedAtMs: null,
    cancelledReason: null,
    archivedAt: null,
    archivedAtMs: null,
    ...overrides,
    parentWorkItemId: overrides.parentWorkItemId ?? null,
    phase: overrides.phase ?? null,
    childOrdinal: overrides.childOrdinal ?? null,
  };
}

const notification: RawBoardNotification = {
  notificationId: "notification-one",
  sequence: 1,
  kind: "park_aged",
  dedupeKey: null,
  projectId: "project-one",
  workItemId: "work-item-one",
  summary: "A parked work item needs attention.",
  createdAt: now,
  createdAtMs: nowMs,
  readAt: null,
  readAtMs: null,
  version: 2,
};

const notifications: BoardNotifications = { unread: [notification], recentRead: [] };
const pausedBoard: RawBoardPause = {
  paused: true,
  reason: "Database maintenance window.",
  version: 2,
  updatedAt: now,
  updatedAtMs: nowMs,
  updatedBy: "human:operator",
};

describe("default observability view", () => {
  it("renders unread notifications and dispatches mark-read before refreshing", async () => {
    const markup = renderToStaticMarkup(
      createElement(NotificationsBlock, {
        notifications,
        loading: false,
        error: null,
        markingId: null,
        onMarkRead: vi.fn(),
        onOpenWorkItem: vi.fn(),
        onRetry: vi.fn(),
      })
    );
    expect(markup).toContain("1 unread");
    expect(markup).toContain("A parked work item needs attention.");
    expect(markup).toContain("Mark read");

    const markNotificationRead = vi.fn().mockResolvedValue({ ...notification, readAt: now, version: 3 });
    const getNotifications = vi.fn().mockResolvedValue({ unread: [], recentRead: [] });
    const client = { markNotificationRead, getNotifications } as unknown as TaskBoardClient;
    await expect(markNotificationReadAndRefresh(client, notification)).resolves.toEqual({
      notifications: { unread: [], recentRead: [] },
      refreshError: null,
    });
    expect(markNotificationRead).toHaveBeenCalledWith("notification-one", 2);
    expect(getNotifications).toHaveBeenCalledOnce();
    expect(markNotificationRead.mock.invocationCallOrder[0]).toBeLessThan(
      getNotifications.mock.invocationCallOrder[0]!
    );
  });

  it("renders an explicit notification empty state", () => {
    const markup = renderToStaticMarkup(
      createElement(NotificationsBlock, {
        notifications: { unread: [], recentRead: [] },
        loading: false,
        error: null,
        markingId: null,
        onMarkRead: vi.fn(),
        onOpenWorkItem: vi.fn(),
        onRetry: vi.fn(),
      })
    );
    expect(markup).toContain("No unread notifications.");
  });

  it("shows parked, final-review, and unread counts in the workspace navigation", () => {
    const snapshot: BoardSnapshot = {
      revision: 1,
      generatedAt: now,
      generatedAtMs: nowMs,
      workItems: [
        workItem({ id: "parked-one", state: "parked" }),
        workItem({ id: "final-one", state: "final_approval" }),
      ],
      projects: [],
      repositories: [],
      agents: [],
      tasks: [],
      messages: [],
      questions: [],
      runs: [],
    };
    const markup = renderToStaticMarkup(
      createElement(WorkspaceFrame, {
        snapshot,
        page: { kind: "tasks" },
        pointOfContact: null,
        drawerOpen: false,
        onDrawerChange: vi.fn(),
        onNavigate: vi.fn(),
        onAddProject: vi.fn(),
        canAddProject: true,
        unreadNotifications: 4,
        boardPause: pausedBoard,
        pauseBusy: false,
        pauseControlError: null,
        onPauseBoard: vi.fn(),
        onResumeBoard: vi.fn(),
        children: createElement("div", null, "Content"),
      })
    );

    expect(markup).toContain("1 parked");
    expect(markup).toContain("1 final");
    expect(markup).toContain('aria-label="1 request awaits final approval"');
    expect(markup).toContain('aria-label="4 unread notifications"');
    expect(markup).toContain("Requests");
    expect(markup).toContain("Automation");
    expect(markup).toContain("Ledgers");
    expect(markup).not.toContain("Documents");
    expect(markup).toContain("Resume board");

    const pausePopoverMarkup = renderToStaticMarkup(
      createElement(WorkspaceFrame, {
        snapshot,
        page: { kind: "tasks" },
        pointOfContact: null,
        drawerOpen: false,
        onDrawerChange: vi.fn(),
        onNavigate: vi.fn(),
        onAddProject: vi.fn(),
        canAddProject: true,
        boardPause: { ...pausedBoard, paused: false, reason: null },
        pausePopoverOpen: true,
        pauseControlError: "Pause state changed",
        children: createElement("div", null, "Content"),
      })
    );
    expect(pausePopoverMarkup).toContain('aria-label="Pause board"');
    expect(pausePopoverMarkup).toContain(">Reason</label>");
    expect(pausePopoverMarkup).toContain('maxLength="500"');
    expect(pausePopoverMarkup).toContain('placeholder="Why are you pausing the board?"');
    expect(pausePopoverMarkup).toContain("Confirm pause");
    expect(pausePopoverMarkup).toContain("Cancel");
    expect(pausePopoverMarkup).toContain('role="alert"');
    expect(pausePopoverMarkup).toContain("Pause state changed");

    const disconnectedPopoverMarkup = renderToStaticMarkup(
      createElement(WorkspaceFrame, {
        snapshot,
        page: { kind: "tasks" },
        pointOfContact: null,
        drawerOpen: false,
        onDrawerChange: vi.fn(),
        onNavigate: vi.fn(),
        onAddProject: vi.fn(),
        canAddProject: false,
        boardPause: { ...pausedBoard, paused: false, reason: null },
        pausePopoverOpen: true,
        pauseControlDisabled: true,
        children: createElement("div", null, "Content"),
      })
    );
    const disconnectedReason = /<textarea[^>]*>/u.exec(disconnectedPopoverMarkup)?.[0];
    const disconnectedConfirm = /<button[^>]*>Confirm pause<\/button>/u.exec(disconnectedPopoverMarkup)?.[0];
    const disconnectedCancel = /<button[^>]*>Cancel<\/button>/u.exec(disconnectedPopoverMarkup)?.[0];
    expect(disconnectedReason).toContain('disabled=""');
    expect(disconnectedConfirm).toContain('disabled=""');
    expect(disconnectedCancel).not.toContain('disabled=""');

    const unavailableMarkup = renderToStaticMarkup(
      createElement(WorkspaceFrame, {
        snapshot,
        page: { kind: "tasks" },
        pointOfContact: null,
        drawerOpen: false,
        onDrawerChange: vi.fn(),
        onNavigate: vi.fn(),
        onAddProject: vi.fn(),
        canAddProject: true,
        boardPause: null,
        children: createElement("div", null, "Content"),
      })
    );
    expect(unavailableMarkup).not.toContain("Board controls");
    expect(unavailableMarkup).not.toContain("Pause board");
  });

  it("renders the paused banner with its reason", () => {
    const markup = renderToStaticMarkup(createElement(BoardPauseBanner, { boardPause: pausedBoard }));
    expect(markup).toContain("Board paused");
    expect(markup).toContain("Database maintenance window.");
    expect(
      renderToStaticMarkup(
        createElement(BoardPauseBanner, {
          boardPause: { ...pausedBoard, paused: false, reason: null },
        })
      )
    ).toBe("");
  });

  it("renders work-item stage, state age, round, and heartbeat freshness", () => {
    const currentMarkup = renderToStaticMarkup(
      createElement(WorkItemRow, {
        workItem: workItem({
          stateSince: "2026-08-21T09:55:00.000Z",
          stateSinceMs: Date.parse("2026-08-21T09:55:00.000Z"),
          reviewRound: 3,
          heartbeatAt: "2026-08-21T11:58:31.000Z",
          heartbeatAtMs: Date.parse("2026-08-21T11:58:31.000Z"),
        }),
        projects: [
          {
            id: "project-one",
            name: "Project one",
            description: null,
            repoPath: "/repos/project-one",
            createdAt: now,
            createdAtMs: nowMs,
            updatedAt: now,
            updatedAtMs: nowMs,
          },
        ],
        selected: false,
        onSelect: vi.fn(),
        buttonRef: vi.fn(),
        nowMs,
      })
    );
    expect(currentMarkup).toContain("Preparing human review");
    expect(currentMarkup).toContain("in reviewing for 2h 5m");
    expect(currentMarkup).toContain("round 3");
    expect(currentMarkup).toContain('aria-label="Heartbeat current"');

    const staleMarkup = renderToStaticMarkup(
      createElement(WorkItemRow, {
        workItem: workItem({ heartbeatAt: "2026-08-21T11:58:30.000Z", heartbeatAtMs: nowMs - 90_000 }),
        projects: [],
        selected: false,
        onSelect: vi.fn(),
        buttonRef: vi.fn(),
        nowMs,
      })
    );
    expect(staleMarkup).toContain('aria-label="Heartbeat stale"');
  });

  it("renders an unknown work-item task type verbatim", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemRow, {
        workItem: workItem({ taskType: "future_onboarding" }),
        projects: [],
        selected: false,
        onSelect: vi.fn(),
        buttonRef: vi.fn(),
        nowMs,
      })
    );

    expect(markup).toContain("future_onboarding");
  });

  it("renders nothing for absent optional work-item observability fields", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemRow, {
        workItem: workItem({ currentStage: null }),
        projects: [],
        selected: false,
        onSelect: vi.fn(),
        buttonRef: vi.fn(),
        nowMs,
      })
    );
    expect(markup).not.toContain("in reviewing for");
    expect(markup).not.toContain("round ");
    expect(markup).not.toContain("Heartbeat current");
    expect(markup).not.toContain("Heartbeat stale");
  });
});

describe("work-item timeline and audit", () => {
  const transitions: BoardWorkItemTransition[] = [
    {
      fromState: null,
      toState: "queued",
      actorType: "human",
      actorId: "human:operator",
      createdAt: "2026-08-21T10:00:00.000Z",
      createdAtMs: Date.parse("2026-08-21T10:00:00.000Z"),
    },
    {
      fromState: "queued",
      toState: "planning",
      actorType: "system",
      actorId: "system:intake",
      createdAt: "2026-08-21T10:05:00.000Z",
      createdAtMs: Date.parse("2026-08-21T10:05:00.000Z"),
    },
  ];

  it("renders real transition rows with actors, elapsed state time, and total time", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusTimeline, {
        workItem: workItem(),
        transitions,
        state: "ready",
        nowMs: Date.parse("2026-08-21T11:05:00.000Z"),
      })
    );

    expect(markup).toContain("Total 1h 5m");
    expect(markup).toContain("Queued");
    expect(markup).toContain("human:operator");
    expect(markup).toContain("5m");
    expect(markup).toContain("Planning");
    expect(markup).toContain("system:intake");
    expect(markup).toContain("1h");
  });

  it("renders gate actions with abbreviated monospace shas and an explicit empty state", () => {
    const verifiedSha = "0123456789abcdef0123456789abcdef01234567";
    const mergeSha = "abcdef0123456789abcdef0123456789abcdef01";
    const audit: RawWorkItemAudit = {
      transitions,
      gateActions: [
        {
          gateActionId: "gate-one",
          workItemId: "work-item-one",
          gate: "final_approve",
          actorId: "human:operator",
          planRevisionId: "plan-one",
          verifiedSha,
          mergeSha,
          refId: null,
          note: "Approved after machine verification.",
          createdAt: now,
          createdAtMs: nowMs,
        },
      ],
    };
    const markup = renderToStaticMarkup(createElement(AuditSection, { audit }));
    expect(markup).toContain("Audit");
    expect(markup).toContain("final approve");
    expect(markup).toContain("human:operator");
    expect(markup).toContain("0123456789");
    expect(markup).toContain("abcdef0123");
    expect(markup).toContain("font-mono");
    expect(markup).not.toContain(verifiedSha);
    expect(markup).not.toContain(mergeSha);

    const emptyMarkup = renderToStaticMarkup(
      createElement(AuditSection, {
        audit: { gateActions: [], transitions: [] },
      })
    );
    expect(emptyMarkup).toContain("No gate actions were recorded.");
  });
});
