import type { AgentRole } from "#shared/task-board-contract";
import type { ProviderArgumentOptions } from "../task-worker/agent-envelope.js";
import type { RuntimeEvent } from "./events.js";
import type { RuntimeProfile } from "./profiles.js";

export interface RuntimeAdapter {
  readonly runtime: string;
  assertRole(profile: RuntimeProfile, role: AgentRole): void;
  args(options: ProviderArgumentOptions, role: AgentRole, profile: RuntimeProfile): readonly string[];
  environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  events(line: string): readonly RuntimeEvent[];
  result(stdout: string): unknown;
}
