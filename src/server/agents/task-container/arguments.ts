import type { AgentRole } from "#shared/task-board-contract";
import {
  claudeProviderArgs,
  codexProviderArgs,
} from "#server/agents/task-worker/agent-envelope";
import type { ContainerAgentLauncherOptions } from "./container-launcher.js";

export interface ContainerRunPlan {
  readonly args: readonly string[];
  readonly containerName: string;
}

export function buildContainerRunPlan(input: {
  readonly options: Required<Pick<ContainerAgentLauncherOptions, "provider" | "model" | "image" | "networkName" | "proxyUrl">>
    & Pick<ContainerAgentLauncherOptions, "agentCommand" | "extraContainerEnv">;
  readonly runId: string;
  readonly taskId: string;
  readonly fixedRole: AgentRole;
  readonly workspacePath: string;
  readonly bareApiKey: boolean;
}): ContainerRunPlan {
  const containerName = `steward-task-${input.runId}`;
  const { model } = input.options;
  const cliArgs = input.options.provider === "codex"
    ? codexProviderArgs({ model, workingDirectory: "/workspace", schemaPath: "/opt/steward/agent-result.schema.json", bareApiKey: input.bareApiKey }, input.fixedRole)
    : claudeProviderArgs({ model, workingDirectory: "/workspace", schemaPath: "/opt/steward/agent-result.schema.json", bareApiKey: input.bareApiKey }, input.fixedRole);
  const providerKeys = input.options.provider === "codex"
    ? ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ORGANIZATION", "OPENAI_PROJECT"]
    : ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"];
  return {
    containerName,
    args: [
      "run", "--rm", "-i",
      "--name", containerName,
      "--label", `steward.task=${input.taskId}`,
      "--network", input.options.networkName,
      "--user", "node",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", "4g",
      "--pids-limit", "512",
      "-v", `${input.workspacePath}:/workspace:rw`,
      "-w", "/workspace",
      "-e", `HTTP_PROXY=${input.options.proxyUrl}`,
      "-e", `HTTPS_PROXY=${input.options.proxyUrl}`,
      "-e", `http_proxy=${input.options.proxyUrl}`,
      "-e", `https_proxy=${input.options.proxyUrl}`,
      "-e", "NO_PROXY=localhost,127.0.0.1",
      ...providerKeys.flatMap((key) => ["-e", key]),
      ...Object.entries(input.options.extraContainerEnv ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      input.options.image,
      input.options.agentCommand ?? input.options.provider,
      ...cliArgs,
    ],
  };
}
