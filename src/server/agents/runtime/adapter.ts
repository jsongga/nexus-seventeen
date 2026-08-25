import type { AgentRole } from "#shared/task-board-contract";
import type { ProviderArgumentOptions } from "../task-worker/agent-envelope.js";
import type { RuntimeEvent } from "./events.js";

export interface RuntimeAdapter {
  readonly runtime: string;
  args(options: ProviderArgumentOptions, role: AgentRole): readonly string[];
  environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  events(line: string): readonly RuntimeEvent[];
  result(stdout: string): unknown;
}
