/** Defines the provider-neutral process contract that lets task launchers run and observe different agent CLIs. */

import type { AgentRole } from "#shared/task-board-contract";
import type { CredentialPatternName } from "../../shared/redact.js";
import type { ProviderArgumentOptions } from "../task-worker/agent-envelope.js";
import type { RuntimeProfile } from "./profiles.js";

export type CredentialRedactionSite = "context" | "provider_outcome" | "diagnostics";

export type RuntimeEvent =
  | { readonly type: "stage_started" }
  | { readonly type: "message_delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly name: string; readonly detail: string }
  | { readonly type: "tool_result"; readonly name: string; readonly output: string; readonly failed?: boolean }
  | {
      readonly type: "credential_redaction";
      readonly site: CredentialRedactionSite;
      readonly patternName: CredentialPatternName;
      readonly count: number;
    }
  | { readonly type: "stage_finished" }
  | { readonly type: "error"; readonly detail: string };

export class AgentProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentProcessError";
  }
}

export interface RuntimeAdapter {
  readonly runtime: string;
  assertRole(profile: RuntimeProfile, role: AgentRole): void;
  args(options: ProviderArgumentOptions, role: AgentRole, profile: RuntimeProfile): readonly string[];
  environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  events(line: string): readonly RuntimeEvent[];
  result(stdout: string): unknown;
}
