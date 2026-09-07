import { Modal } from "../../components/ui";
import { activityUpdates } from "./ProjectPage";
import { agentPageUsesPointOfContactMode } from "./AgentPage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { latestByAskedAt, latestByUpdatedAt, orderAgentChatEntries } from "./agent-chat";

vi.mock("../../components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/ui")>();
  return { ...actual, Modal: vi.fn(() => null) };
});

beforeEach(() => {
  vi.mocked(Modal).mockClear();
});

describe("agentPageUsesPointOfContactMode", () => {
  it("enables POC chat framing only for the selected explicit POC", () => {
    expect(agentPageUsesPointOfContactMode(true, true)).toBe(true);
    expect(agentPageUsesPointOfContactMode(true, false)).toBe(false);
    expect(agentPageUsesPointOfContactMode(false, true)).toBe(false);
  });
});

describe("workspace timestamp ordering", () => {
  it("orders activity and chat by absolute instants", () => {
    const earlierOffset = "2026-07-19T12:00:00+02:00";
    const laterFraction = "2026-07-19T10:00:00.500Z";

    expect(
      activityUpdates(
        [
          {
            id: "earlier",
            projectId: "project-one",
            taskId: "task-one",
            taskTitle: "Task",
            author: "Agent",
            body: "Earlier",
            kind: "progress",
            createdAt: earlierOffset,
            createdAtMs: Date.parse(earlierOffset),
          },
          {
            id: "later",
            projectId: "project-one",
            taskId: "task-one",
            taskTitle: "Task",
            author: "Agent",
            body: "Later",
            kind: "progress",
            createdAt: laterFraction,
            createdAtMs: Date.parse(laterFraction),
          },
        ],
        []
      ).map((update) => update.id)
    ).toEqual(["later", "earlier"]);

    expect(
      orderAgentChatEntries([
        {
          id: "earlier",
          author: "Agent",
          body: "Earlier",
          createdAt: earlierOffset,
          createdAtMs: Date.parse(earlierOffset),
          sender: "agent",
          contextRole: null,
          order: 0,
        },
        {
          id: "later",
          author: "Agent",
          body: "Later",
          createdAt: laterFraction,
          createdAtMs: Date.parse(laterFraction),
          sender: "agent",
          contextRole: null,
          order: 0,
        },
      ]).map((entry) => entry.id)
    ).toEqual(["earlier", "later"]);

    expect(
      latestByUpdatedAt([
        { id: "earlier", updatedAt: earlierOffset, updatedAtMs: Date.parse(earlierOffset) },
        { id: "later", updatedAt: laterFraction, updatedAtMs: Date.parse(laterFraction) },
      ])?.id
    ).toBe("later");
    expect(
      latestByAskedAt([
        { id: "earlier", askedAt: earlierOffset, askedAtMs: Date.parse(earlierOffset) },
        { id: "later", askedAt: laterFraction, askedAtMs: Date.parse(laterFraction) },
      ])?.id
    ).toBe("later");
  });

  it("selects the same latest entity for equivalent instants in either input order", () => {
    const utc = "2026-07-19T10:00:00Z";
    const offset = "2026-07-19T12:00:00+02:00";
    const items = [
      { id: "item-alpha", updatedAt: utc, updatedAtMs: Date.parse(utc) },
      { id: "item-omega", updatedAt: offset, updatedAtMs: Date.parse(offset) },
    ];

    expect(latestByUpdatedAt(items)?.id).toBe("item-omega");
    expect(latestByUpdatedAt([...items].reverse())?.id).toBe("item-omega");
  });
});
