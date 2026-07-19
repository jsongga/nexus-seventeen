import { randomUUID } from "node:crypto";

/** A process generation gets a fresh ID; only a durable registration intent may reuse one. */
export function createManagerRuntimeInstanceId(): string {
  return `runtime-${randomUUID()}`;
}
