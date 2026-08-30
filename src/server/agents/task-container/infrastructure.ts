import { execFile } from "node:child_process";

const DOCKER_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_NETWORK = "steward-agents";
const DEFAULT_EGRESS_NETWORK = "steward-egress";
const DEFAULT_PROXY_CONTAINER_NAME = "steward-egress-proxy";
const DEFAULT_PROXY_PORT = 3128;
const PROXY_READY_MESSAGE = "steward-egress-proxy listening";
const PROXY_READY_TIMEOUT_MS = 10_000;
const PROXY_READY_POLL_MS = 250;

const proxyReconciliations = new Map<string, Promise<void>>();

export const DEFAULT_ALLOWED_HOSTS = Object.freeze(["api.anthropic.com", "api.openai.com", "registry.npmjs.org"]);

export interface ContainerInfrastructureOptions {
  readonly image: string;
  readonly allowedHosts: readonly string[];
  readonly dockerBinary?: string;
  readonly agentNetwork?: string;
  readonly egressNetwork?: string;
  readonly proxyContainerName?: string;
  readonly proxyPort?: number;
}

export interface ContainerInfrastructure {
  readonly agentNetwork: string;
  readonly proxyUrl: string;
}

export class ContainerInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContainerInfrastructureError";
  }
}

class DockerExecutionError extends ContainerInfrastructureError {
  readonly detail: string;

  constructor(args: readonly string[], detail: string, cause: Error) {
    super(`docker ${args[0] ?? "command"} failed: ${detail}`, { cause });
    this.detail = detail;
  }
}

interface DockerCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function dockerCommandOutput(
  dockerBinary: string,
  args: readonly string[],
  timeoutMs = DOCKER_TIMEOUT_MS
): Promise<DockerCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      dockerBinary,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim() || error.message.trim();
          reject(new DockerExecutionError(args, detail, error));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function dockerCommand(
  dockerBinary: string,
  args: readonly string[],
  timeoutMs = DOCKER_TIMEOUT_MS
): Promise<string> {
  return (await dockerCommandOutput(dockerBinary, args, timeoutMs)).stdout;
}

function dockerDetail(error: unknown): string {
  if (error instanceof DockerExecutionError) return error.detail;
  if (error instanceof Error) return error.message.trim();
  return String(error).trim();
}

function isMissingContainer(error: unknown): boolean {
  return /No such container|No such object/iu.test(dockerDetail(error));
}

function isAlreadyConnected(error: unknown): boolean {
  return /already connected|already exists in network/iu.test(dockerDetail(error));
}

function isContainerNameConflict(error: unknown): boolean {
  return /container name.*already in use|already in use by container/iu.test(dockerDetail(error));
}

export async function assertDockerAvailable(dockerBinary = "docker"): Promise<void> {
  try {
    await dockerCommand(dockerBinary, ["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    const detail = dockerDetail(error);
    throw new ContainerInfrastructureError(`Docker daemon unreachable — start Docker Desktop and retry (${detail})`, {
      cause: error,
    });
  }
}

export async function ensureNetwork(dockerBinary: string, networkName: string, internal: boolean): Promise<void> {
  try {
    await dockerCommand(dockerBinary, ["network", "inspect", networkName]);
    return;
  } catch {
    // A missing network and every other inspect failure are resolved by a create attempt.
  }

  try {
    await dockerCommand(dockerBinary, ["network", "create", ...(internal ? ["--internal"] : []), networkName]);
  } catch (createError) {
    try {
      await dockerCommand(dockerBinary, ["network", "inspect", networkName]);
    } catch {
      throw createError;
    }
  }
}

async function assertInternalNetwork(dockerBinary: string, networkName: string): Promise<void> {
  const output = await dockerCommand(dockerBinary, ["network", "inspect", "-f", "{{.Internal}}", networkName]);
  if (output.trim() !== "true") {
    throw new ContainerInfrastructureError(
      `Docker network ${networkName} exists but is not internal and must be removed; use ` +
        `\`docker network rm ${networkName}\` and retry`
    );
  }
}

interface ProxyInspection {
  running: boolean;
  allowedHosts: string | null;
  proxyPort: string | null;
  image: string;
  networks: readonly string[];
}

function proxyEnvironmentInspection(output: string): Readonly<{
  running: boolean;
  allowedHosts: string | null;
  proxyPort: string | null;
}> {
  const separator = output.indexOf("|");
  if (separator === -1) return { running: false, allowedHosts: null, proxyPort: null };
  const running = output.slice(0, separator).trim() === "true";
  const environment = output.slice(separator + 1);
  const allowedHosts = /(?:^|\s)STEWARD_EGRESS_ALLOWED_HOSTS=([^\s]*)/u.exec(environment);
  const proxyPort = /(?:^|\s)STEWARD_EGRESS_PORT=([^\s]*)/u.exec(environment);
  return {
    running,
    allowedHosts: allowedHosts?.[1] ?? null,
    proxyPort: proxyPort?.[1] ?? null,
  };
}

function inspectedNetworkNames(output: string): readonly string[] {
  try {
    const networks: unknown = JSON.parse(output);
    if (typeof networks !== "object" || networks === null || Array.isArray(networks)) return [];
    return Object.keys(networks);
  } catch {
    return [];
  }
}

async function inspectProxy(dockerBinary: string, proxyContainerName: string): Promise<ProxyInspection | null> {
  try {
    const environmentOutput = await dockerCommand(dockerBinary, [
      "inspect",
      "-f",
      "{{.State.Running}}|{{range .Config.Env}}{{.}} {{end}}",
      proxyContainerName,
    ]);
    const image = await dockerCommand(dockerBinary, ["inspect", "-f", "{{.Config.Image}}", proxyContainerName]);
    const networks = await dockerCommand(dockerBinary, [
      "inspect",
      "-f",
      "{{json .NetworkSettings.Networks}}",
      proxyContainerName,
    ]);
    return {
      ...proxyEnvironmentInspection(environmentOutput),
      image: image.trim(),
      networks: inspectedNetworkNames(networks),
    };
  } catch {
    return null;
  }
}

interface ProxyConfiguration {
  readonly dockerBinary: string;
  readonly proxyContainerName: string;
  readonly agentNetwork: string;
  readonly egressNetwork: string;
  readonly allowedHosts: string;
  readonly proxyPort: number;
  readonly image: string;
}

function allowedHostList(value: string | null): readonly string[] {
  return value === null
    ? []
    : value
        .split(",")
        .map((host) => host.trim())
        .filter((host) => host.length > 0);
}

function isAllowedHostSuperset(actual: string | null, requested: string): boolean {
  if (actual === null) return false;
  const actualHosts = new Set(allowedHostList(actual));
  return allowedHostList(requested).every((host) => actualHosts.has(host));
}

function reconciledAllowedHosts(proxy: ProxyInspection | null, requested: string): string {
  // Removed hosts linger by design under union reconciliation. For exact recovery,
  // run `docker rm -f steward-egress-proxy` and restart the fleet; fleet-wide
  // convergence is campaign 7 scope.
  const current = proxy?.running === true ? allowedHostList(proxy.allowedHosts) : [];
  return [...new Set([...current, ...allowedHostList(requested)])].sort().join(",");
}

function isProxyHealthy(proxy: ProxyInspection | null, expected: ProxyConfiguration): boolean {
  return (
    proxy !== null &&
    proxy.running &&
    isAllowedHostSuperset(proxy.allowedHosts, expected.allowedHosts) &&
    proxy.proxyPort === String(expected.proxyPort) &&
    proxy.image === expected.image &&
    proxy.networks.includes(expected.agentNetwork) &&
    proxy.networks.includes(expected.egressNetwork)
  );
}

async function startProxy(input: ProxyConfiguration): Promise<void> {
  try {
    await dockerCommand(input.dockerBinary, ["rm", "-f", input.proxyContainerName]);
  } catch (error) {
    if (!isMissingContainer(error)) throw error;
  }

  try {
    await dockerCommand(input.dockerBinary, [
      "run",
      "-d",
      "--restart",
      "unless-stopped",
      "--name",
      input.proxyContainerName,
      "--user",
      "node",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "512m",
      "--pids-limit",
      "128",
      "--network",
      input.agentNetwork,
      "-e",
      `STEWARD_EGRESS_ALLOWED_HOSTS=${input.allowedHosts}`,
      "-e",
      `STEWARD_EGRESS_PORT=${input.proxyPort}`,
      input.image,
      "node",
      "/opt/steward/build/server/agents/egress-proxy/main.js",
    ]);
  } catch (error) {
    if (isContainerNameConflict(error)) {
      const racedProxy = await inspectProxy(input.dockerBinary, input.proxyContainerName);
      if (isProxyHealthy(racedProxy, input)) return;
    }
    throw error;
  }

  try {
    await dockerCommand(input.dockerBinary, ["network", "connect", input.egressNetwork, input.proxyContainerName]);
  } catch (error) {
    if (!isAlreadyConnected(error)) throw error;
  }
}

function proxyReadinessError(
  proxyContainerName: string,
  reason: string,
  logs: string,
  cause?: unknown
): ContainerInfrastructureError {
  const logTail = logs.slice(-500).trim() || "<no logs>";
  return new ContainerInfrastructureError(
    `Egress proxy ${proxyContainerName} ${reason}. Last docker logs (up to 500 chars): ${logTail}`,
    cause === undefined ? undefined : { cause }
  );
}

async function waitForProxyReady(dockerBinary: string, proxyContainerName: string): Promise<void> {
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  let lastLogs = "";

  while (true) {
    const logsTimeoutMs = Math.max(1, deadline - Date.now());
    try {
      const output = await dockerCommandOutput(dockerBinary, ["logs", proxyContainerName], logsTimeoutMs);
      lastLogs = [output.stdout, output.stderr].filter((entry) => entry.length > 0).join("\n");
    } catch (error) {
      lastLogs = `docker logs failed: ${dockerDetail(error)}`;
    }
    if (Date.now() >= deadline) {
      throw proxyReadinessError(
        proxyContainerName,
        `did not become ready within ${PROXY_READY_TIMEOUT_MS}ms`,
        lastLogs
      );
    }

    let running: string;
    try {
      running = await dockerCommand(
        dockerBinary,
        ["inspect", "-f", "{{.State.Running}}", proxyContainerName],
        Math.max(1, deadline - Date.now())
      );
    } catch (error) {
      throw proxyReadinessError(
        proxyContainerName,
        `could not be inspected during readiness polling (${dockerDetail(error)})`,
        lastLogs,
        error
      );
    }

    if (running.trim() !== "true") {
      throw proxyReadinessError(proxyContainerName, "exited before becoming ready", lastLogs);
    }
    if (lastLogs.includes(PROXY_READY_MESSAGE)) return;
    if (Date.now() >= deadline) {
      throw proxyReadinessError(
        proxyContainerName,
        `did not become ready within ${PROXY_READY_TIMEOUT_MS}ms`,
        lastLogs
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(PROXY_READY_POLL_MS, Math.max(1, deadline - Date.now())))
    );
  }
}

async function reconcileProxy(input: ProxyConfiguration): Promise<void> {
  const proxy = await inspectProxy(input.dockerBinary, input.proxyContainerName);
  if (!isProxyHealthy(proxy, input)) {
    await startProxy({
      ...input,
      allowedHosts: reconciledAllowedHosts(proxy, input.allowedHosts),
    });
  }
  await waitForProxyReady(input.dockerBinary, input.proxyContainerName);
}

async function serializeProxyReconciliation(proxyContainerName: string, reconcile: () => Promise<void>): Promise<void> {
  const previous = proxyReconciliations.get(proxyContainerName) ?? Promise.resolve();
  const current = previous.then(reconcile, reconcile);
  proxyReconciliations.set(proxyContainerName, current);
  try {
    await current;
  } finally {
    if (proxyReconciliations.get(proxyContainerName) === current) {
      proxyReconciliations.delete(proxyContainerName);
    }
  }
}

async function sweepOrphanedTaskContainers(dockerBinary: string): Promise<void> {
  // Safe only while no task lane is live and while a single fleet process owns the host.
  // Docker-gated test files run serially so a prepare-time sweep in one file cannot
  // remove another file's active lane. Multi-fleet ownership labels are campaign 7 scope.
  const output = await dockerCommand(dockerBinary, ["ps", "-aq", "--filter", "label=steward.task"]);
  const containerIds = output
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  for (const containerId of containerIds) {
    await dockerCommand(dockerBinary, ["rm", "-f", containerId]);
  }
}

export async function prepareContainerInfrastructure(
  options: ContainerInfrastructureOptions
): Promise<ContainerInfrastructure> {
  const dockerBinary = options.dockerBinary ?? "docker";
  const agentNetwork = options.agentNetwork ?? DEFAULT_AGENT_NETWORK;
  const egressNetwork = options.egressNetwork ?? DEFAULT_EGRESS_NETWORK;
  const proxyContainerName = options.proxyContainerName ?? DEFAULT_PROXY_CONTAINER_NAME;
  const proxyPort = options.proxyPort ?? DEFAULT_PROXY_PORT;
  const allowedHosts = [...options.allowedHosts].sort().join(",");

  await assertDockerAvailable(dockerBinary);
  await ensureNetwork(dockerBinary, agentNetwork, true);
  await assertInternalNetwork(dockerBinary, agentNetwork);
  await ensureNetwork(dockerBinary, egressNetwork, false);

  await serializeProxyReconciliation(proxyContainerName, () =>
    reconcileProxy({
      dockerBinary,
      proxyContainerName,
      agentNetwork,
      egressNetwork,
      allowedHosts,
      proxyPort,
      image: options.image,
    })
  );

  await sweepOrphanedTaskContainers(dockerBinary);
  return Object.freeze({
    agentNetwork,
    proxyUrl: `http://${proxyContainerName}:${proxyPort}`,
  });
}
