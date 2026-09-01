import { describe, expect, it, vi } from "vitest";
import { createTaskBoardClient } from "./client";

describe("plan revision client", () => {
  it("dispatches the exact reject request and parses both outcomes", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { note: string };
      return new Response(
        JSON.stringify({
          outcome: body.note.includes("again") ? "parked" : "revising",
        })
      );
    });
    const client = createTaskBoardClient({
      baseUrl: "https://board.example.test",
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.rejectWorkflowPlan("plan-one", "Make the rollback explicit.")).resolves.toEqual({
      outcome: "revising",
    });
    await expect(client.rejectWorkflowPlan("plan-two", "Clarify it again.")).resolves.toEqual({ outcome: "parked" });
    expect(request.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
      [
        "https://board.example.test/v1/plans/plan-one/reject",
        "POST",
        { note: "Make the rollback explicit.", expectedState: "proposed" },
      ],
      [
        "https://board.example.test/v1/plans/plan-two/reject",
        "POST",
        { note: "Clarify it again.", expectedState: "proposed" },
      ],
    ]);
  });

  it("rejects an unsupported response outcome", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ outcome: "requeued" })));
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.rejectWorkflowPlan("plan-one", "Revise it.")).rejects.toThrow(/outcome/iu);
  });
});
