import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ContainerInfrastructureError,
  prepareContainerInfrastructure,
} from "#server/agents/task-container";

interface FakeDockerOptions {
  readonly internal?: boolean;
  readonly proxyAllowedHosts?: string;
  readonly proxyImage?: string;
  readonly proxyPort?: string;
  readonly proxyNetworks?: readonly string[];
  readonly readinessLogs?: string;
  readonly readinessRunning?: boolean;
  readonly slowProxyInspect?: boolean;
}

interface FakeDocker {
  readonly binary: string;
  readonly log: string;
  readonly root: string;
}

async function fakeDocker(options: FakeDockerOptions = {}): Promise<FakeDocker> {
  const root = await mkdtemp(join(tmpdir(), "steward-infrastructure-test-"));
  const binary = join(root, "docker");
  const log = join(root, "docker.log");
  const configuration = {
    internal: options.internal ?? true,
    proxyAllowedHosts: options.proxyAllowedHosts ?? "api.openai.com",
    proxyImage: options.proxyImage ?? "steward-agent:test",
    proxyPort: options.proxyPort ?? "3128",
    proxyNetworks: options.proxyNetworks ?? ["steward-agents", "steward-egress"],
    readinessLogs: options.readinessLogs ?? "steward-egress-proxy listening on 3128",
    readinessRunning: options.readinessRunning ?? true,
    slowProxyInspect: options.slowProxyInspect ?? false,
  };

  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const configuration = ${JSON.stringify(configuration)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const formatIndex = args.indexOf("-f");
const format = formatIndex === -1 ? "" : args[formatIndex + 1];

if (args[0] === "version") {
  console.log("27.0.0");
} else if (args[0] === "network" && args[1] === "inspect") {
  if (format === "{{.Internal}}") console.log(String(configuration.internal));
} else if (args[0] === "inspect" && format.includes("{{range .Config.Env}}")) {
  if (configuration.slowProxyInspect) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
  }
  console.log("true|STEWARD_EGRESS_ALLOWED_HOSTS=" + configuration.proxyAllowedHosts
    + " STEWARD_EGRESS_PORT=" + configuration.proxyPort + " ");
} else if (args[0] === "inspect" && format === "{{.Config.Image}}") {
  console.log(configuration.proxyImage);
} else if (args[0] === "inspect" && format === "{{json .NetworkSettings.Networks}}") {
  console.log(JSON.stringify(Object.fromEntries(configuration.proxyNetworks.map((name) => [name, {}]))));
} else if (args[0] === "inspect" && format === "{{.State.Running}}") {
  console.log(String(configuration.readinessRunning));
} else if (args[0] === "logs") {
  console.log(configuration.readinessLogs);
} else if (["create", "connect"].includes(args[1]) || ["rm", "run", "ps"].includes(args[0])) {
  if (args[0] === "run") console.log("proxy-container-id");
} else {
  process.stderr.write("unsupported fake docker invocation: " + JSON.stringify(args) + "\\n");
  process.exit(2);
}
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { binary, log, root };
}

async function invocations(fixture: FakeDocker): Promise<readonly (readonly string[])[]> {
  const content = await readFile(fixture.log, "utf8");
  return content.trim().split("\n").filter((line) => line.length > 0).map((line) => {
    const parsed: unknown = JSON.parse(line);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.every((entry) => typeof entry === "string"));
    return parsed;
  });
}

function isFormatInvocation(args: readonly string[], format: string): boolean {
  return args[0] === "inspect" && args[args.indexOf("-f") + 1] === format;
}

test("proxy reconciliations with the same container name do not interleave", async (t) => {
  const fixture = await fakeDocker({ proxyImage: "stale-image", slowProxyInspect: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await Promise.all([
    prepareContainerInfrastructure({
      image: "steward-agent:first",
      allowedHosts: ["api.openai.com"],
      dockerBinary: fixture.binary,
    }),
    prepareContainerInfrastructure({
      image: "steward-agent:second",
      allowedHosts: ["api.openai.com"],
      dockerBinary: fixture.binary,
    }),
  ]);

  const calls = await invocations(fixture);
  const proxyInspects = calls.flatMap((args, index) => (
    isFormatInvocation(args, "{{.State.Running}}|{{range .Config.Env}}{{.}} {{end}}") ? [index] : []
  ));
  const readinessInspects = calls.flatMap((args, index) => (
    isFormatInvocation(args, "{{.State.Running}}") ? [index] : []
  ));
  assert.equal(proxyInspects.length, 2);
  assert.equal(readinessInspects.length, 2);
  assert.ok(proxyInspects[1] > readinessInspects[0]);
  assert.equal(calls.filter((args) => args[0] === "run").length, 2);
});

test("proxy readiness failure includes recent logs", async (t) => {
  const fixture = await fakeDocker({
    readinessLogs: "proxy crashed before ready: sentinel-detail",
    readinessRunning: false,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    prepareContainerInfrastructure({
      image: "steward-agent:test",
      allowedHosts: ["api.openai.com"],
      dockerBinary: fixture.binary,
    }),
    (error: unknown) => error instanceof ContainerInfrastructureError
      && /exited before becoming ready/u.test(error.message)
      && /sentinel-detail/u.test(error.message),
  );
});

test("a pre-existing non-internal agent network is rejected without removal", async (t) => {
  const fixture = await fakeDocker({ internal: false });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    prepareContainerInfrastructure({
      image: "steward-agent:test",
      allowedHosts: ["api.openai.com"],
      dockerBinary: fixture.binary,
    }),
    (error: unknown) => error instanceof ContainerInfrastructureError
      && error.message.includes("docker network rm steward-agents"),
  );
  assert.equal((await invocations(fixture)).some((args) => args[0] === "rm"), false);
});

test("proxy image, port, and network mismatches each force recreation", async (t) => {
  const cases: readonly FakeDockerOptions[] = [
    { proxyImage: "steward-agent:old" },
    { proxyPort: "9999" },
    { proxyNetworks: ["steward-agents"] },
    { proxyNetworks: ["steward-egress"] },
  ];

  for (const options of cases) {
    const fixture = await fakeDocker(options);
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await prepareContainerInfrastructure({
      image: "steward-agent:test",
      allowedHosts: ["api.openai.com"],
      dockerBinary: fixture.binary,
    });
    assert.equal((await invocations(fixture)).filter((args) => args[0] === "run").length, 1);
  }
});

test("proxy allowlists converge without removing hosts needed by another lane", async (t) => {
  const fixture = await fakeDocker({ proxyAllowedHosts: "b,a" });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await prepareContainerInfrastructure({
    image: "steward-agent:test",
    allowedHosts: ["a"],
    dockerBinary: fixture.binary,
  });
  assert.equal((await invocations(fixture)).filter((args) => args[0] === "run").length, 0);

  await prepareContainerInfrastructure({
    image: "steward-agent:test",
    allowedHosts: ["c"],
    dockerBinary: fixture.binary,
  });
  const proxyRuns = (await invocations(fixture)).filter((args) => args[0] === "run");
  assert.equal(proxyRuns.length, 1);
  assert.deepEqual(proxyRuns[0], [
    "run",
    "-d",
    "--restart",
    "unless-stopped",
    "--name",
    "steward-egress-proxy",
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
    "steward-agents",
    "-e",
    "STEWARD_EGRESS_ALLOWED_HOSTS=a,b,c",
    "-e",
    "STEWARD_EGRESS_PORT=3128",
    "steward-agent:test",
    "node",
    "/opt/steward/build/server/agents/egress-proxy/main.js",
  ]);
});
