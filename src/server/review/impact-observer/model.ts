import type {
  ImpactModelInvocation,
  ImpactModelRequest,
  ImpactModelResult,
  WeakImpactModelAdapter,
} from "./types.js";

/** A network-free adapter for local development and deterministic tests. */
export class FakeWeakImpactModelAdapter implements WeakImpactModelAdapter {
  readonly name = "fake-weak-impact-model";
  readonly requests: ImpactModelRequest[] = [];
  readonly routedRequests: ImpactModelInvocation[] = [];

  async summarize(
    request: ImpactModelRequest | ImpactModelInvocation,
    signal?: AbortSignal,
  ): Promise<ImpactModelResult> {
    if (signal?.aborted) throw signal.reason;
    this.requests.push(structuredClone(request));
    if ("route" in request) this.routedRequests.push(structuredClone(request));
    const latest = request.task.recentUpdates.at(-1)?.toLowerCase() ?? "";
    let text: string;
    if (request.task.status === "completed") {
      text = "The requested improvement is complete and ready for human review before any user release.";
    } else if (request.task.status === "failed") {
      text = "The requested improvement is not ready for users yet; more work is needed before human review.";
    } else if (request.task.status === "paused") {
      text = "Work on the requested improvement is paused; user-facing results are not confirmed yet.";
    } else if (latest.includes("passed")) {
      text = "The requested improvement passed its latest checks and is awaiting final review; users are not affected yet.";
    } else if (request.task.status === "running") {
      text = "Work on the requested improvement is underway; user-facing results are not confirmed yet.";
    } else {
      text = "The requested improvement is queued; users are not affected yet.";
    }
    return { text };
  }
}
