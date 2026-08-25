import type { AgentRole } from "#shared/task-board-contract";
import type { ContainerAgentLauncherOptions } from "./container-launcher.js";

const HOST_ONLY_ENVIRONMENT_KEYS = new Set([
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // These Claude controls configure the host launcher only. They were not part
  // of the shipped Claude container environment before runtime adapters.
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "DISABLE_AUTOUPDATER",
]);

function runtimeEnvironmentKeys(environment: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(environment)
    .filter(([key, value]) => typeof value === "string" && !HOST_ONLY_ENVIRONMENT_KEYS.has(key))
    .map(([key]) => key);
}

export interface ContainerRunPlan {
  readonly args: readonly string[];
  readonly containerName: string;
}

export function buildContainerRunPlan(input: {
  readonly options: Required<Pick<ContainerAgentLauncherOptions, "adapter" | "profile" | "model" | "image" | "networkName" | "proxyUrl">>
    & Pick<ContainerAgentLauncherOptions, "agentCommand" | "extraContainerEnv">;
  readonly runId: string;
  readonly taskId: string;
  readonly fixedRole: AgentRole;
  readonly workspacePath: string;
  readonly bareApiKey: boolean;
  /** The adapter environment already computed by the launcher for this spawn. */
  readonly runtimeEnvironment: NodeJS.ProcessEnv;
}): ContainerRunPlan {
  const containerName = `steward-task-${input.runId}`;
  const { adapter, model, profile } = input.options;
  const cliArgs = adapter.args({
    model,
    workingDirectory: "/workspace",
    schemaPath: "/opt/steward/agent-result.schema.json",
    bareApiKey: input.bareApiKey,
    proxyEgress: true,
  }, input.fixedRole, profile);
  const runtimeKeys = runtimeEnvironmentKeys(input.runtimeEnvironment);
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
      ...runtimeKeys.flatMap((key) => ["-e", key]),
      ...Object.entries(input.options.extraContainerEnv ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      input.options.image,
      input.options.agentCommand ?? profile.binary,
      ...cliArgs,
    ],
  };
}
