import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureNetwork } from "#server/agents/task-container";
import { docker, requireDocker } from "./helpers.js";

// Pinned 2026-08-26. Keep equal to docker-compose.outline.yml; the
// container test asserts this rather than letting the two deployment paths drift.
export const OUTLINE_IMAGE = "outlinewiki/outline:1.9.2";
export const POSTGRES_IMAGE = "postgres:16-alpine";
export const REDIS_IMAGE = "redis:7-alpine";

const NETWORK = "steward-outline-e2e";
const LABEL = "steward.outline-e2e";
const POSTGRES_USER = "outline";
const POSTGRES_PASSWORD = "outline-e2e-password";
const POSTGRES_DATABASE = "outline";
const READY_POLL_MS = 500;
const OUTLINE_READY_TIMEOUT_MS = 180_000;
const DEPENDENCY_READY_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = "100";
const SECRET_KEY = randomBytes(32).toString("hex");
const UTILS_SECRET = randomBytes(32).toString("hex");
const TOKEN_VALUE = `ol_api_${randomBytes(19).toString("hex")}`;
const JWT_SECRET_HEX = randomBytes(32).toString("hex");
const TEAM_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const API_KEY_ID = "10000000-0000-4000-8000-000000000003";

interface ContainerNames {
  readonly outline: string;
  readonly postgres: string;
  readonly redis: string;
}

export interface OutlineFixture {
  readonly baseUrl: string;
  readonly token: string;
  readonly containers: ContainerNames;
  step<T>(name: string, operation: () => Promise<T>): Promise<T>;
  teardown(): Promise<void>;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function logTail(container: string): Promise<string> {
  try {
    const logs = await docker(["logs", "--tail", LOG_TAIL_LINES, container]);
    return logs.trim() || "<no logs>";
  } catch (error) {
    return `<logs unavailable: ${errorDetail(error)}>`;
  }
}

async function diagnosticError(
  step: string,
  containers: ContainerNames,
  error: unknown,
): Promise<Error> {
  const names = [containers.postgres, containers.redis, containers.outline];
  const tails = await Promise.all(names.map(async (name) =>
    `--- ${name} (last ${LOG_TAIL_LINES} log lines) ---\n${await logTail(name)}`));
  return new Error(
    `[outline-e2e:${step}] failed; containers=${names.join(", ")}\n`
      + `${errorDetail(error)}\n${tails.join("\n")}`,
    { cause: error },
  );
}

async function runStep<T>(
  step: string,
  containers: ContainerNames,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw await diagnosticError(step, containers, error);
  }
}

async function removeContainersBestEffort(containers: ContainerNames): Promise<void> {
  for (const name of [containers.outline, containers.redis, containers.postgres]) {
    try {
      await docker(["rm", "-f", name]);
    } catch {
      // A failed boot may not have created every container. The network is
      // deliberately retained, matching the other container-tier fixtures.
    }
  }
}

async function sweepStrays(): Promise<void> {
  const output = await docker(["ps", "-aq", "--filter", `label=${LABEL}`]);
  const ids = output.split(/\r?\n/u).map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]);
}

async function waitForCommand(
  container: string,
  args: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "command not attempted";
  while (Date.now() < deadline) {
    try {
      await docker(["exec", container, ...args]);
      return;
    } catch (error) {
      lastError = errorDetail(error);
    }

    const state = await docker(["inspect", "-f", "{{.State.Running}}|{{.State.ExitCode}}", container]);
    if (!state.trim().startsWith("true|")) {
      throw new Error(`${container} exited while waiting for ${label}; state=${state.trim()}; last=${lastError}`);
    }
    await delay(Math.min(READY_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${container} did not pass ${label} within ${timeoutMs}ms; last=${lastError}`);
}

async function waitForOutlineHealth(baseUrl: string, outlineContainer: string): Promise<void> {
  const deadline = Date.now() + OUTLINE_READY_TIMEOUT_MS;
  let lastResult = "request not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/_health`, {
        signal: AbortSignal.timeout(5_000),
      });
      lastResult = `HTTP ${response.status} ${await response.text()}`.trim();
      if (response.ok) return;
    } catch (error) {
      lastResult = errorDetail(error);
    }

    const state = await docker([
      "inspect",
      "-f",
      "{{.State.Running}}|{{.State.ExitCode}}",
      outlineContainer,
    ]);
    if (!state.trim().startsWith("true|")) {
      throw new Error(`${outlineContainer} exited before /_health was ready; state=${state.trim()}; last=${lastResult}`);
    }
    await delay(Math.min(READY_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `${outlineContainer} GET /_health did not become ready within ${OUTLINE_READY_TIMEOUT_MS}ms; last=${lastResult}`,
  );
}

function psql(postgresContainer: string, args: readonly string[]): Promise<string> {
  return docker([
    "exec",
    postgresContainer,
    "psql",
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "-U",
    POSTGRES_USER,
    "-d",
    POSTGRES_DATABASE,
    ...args,
  ]);
}

async function inspectSeedTables(containers: ContainerNames): Promise<void> {
  const postgresContainer = containers.postgres;
  // Keep these light checks separate so any future pinned-schema drift has a
  // precise controller failure label. Outline 1.9.2 uses quoted camelCase
  // "apiKeys"; see outline-192-verified-facts.md.
  const inspect = (step: string, relation: string): Promise<void> =>
    runStep(step, containers, async () => {
      const output = await psql(postgresContainer, ["-c", `\\dt ${relation}`]);
      if (!output.includes("List of relations")) {
        throw new Error(`pinned ${OUTLINE_IMAGE} relation ${relation} was not listed by psql: ${output.trim()}`);
      }
    });

  await inspect("seed:inspect-schema-teams", "teams");
  await inspect("seed:inspect-schema-users", "users");
  await inspect("seed:inspect-schema-apiKeys", "\"apiKeys\"");
}

async function seedApiToken(postgresContainer: string): Promise<void> {
  const tokenHash = createHash("sha256").update(TOKEN_VALUE).digest("hex");

  // Verified against a running Outline 1.9.2 stack; keep this SQL aligned with
  // .superpowers/sdd/2026-08-26-outline-docs-pipeline/outline-192-verified-facts.md.
  const sql = `
BEGIN;
INSERT INTO teams (id, name, "createdAt", "updatedAt")
VALUES ('${TEAM_ID}', 'Seed Team', NOW(), NOW());

INSERT INTO users (
  id, email, name, "teamId", "createdAt", "updatedAt", role
)
VALUES (
  '${USER_ID}', 'seed@example.com', 'Seed Admin', '${TEAM_ID}', NOW(), NOW(), 'admin'
);

UPDATE users
SET "jwtSecret" = decode('${JWT_SECRET_HEX}', 'hex')
WHERE id = '${USER_ID}';

INSERT INTO "apiKeys" (id, name, "userId", "createdAt", "updatedAt", hash, last4)
VALUES (
  '${API_KEY_ID}', 'e2e', '${USER_ID}', NOW(), NOW(), '${tokenHash}', '${TOKEN_VALUE.slice(-4)}'
);
COMMIT;`;

  await psql(postgresContainer, ["-c", sql]);
}

async function verifyApiToken(baseUrl: string): Promise<void> {
  // auth.info requires richer user presenter state and returns 500 for this
  // minimal seed. collections.list is the publisher-relevant auth probe verified
  // in .superpowers/sdd/2026-08-26-outline-docs-pipeline/outline-192-verified-facts.md.
  const response = await fetch(`${baseUrl}/api/collections.list`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${TOKEN_VALUE}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (response.status === 401) {
    throw new Error(
      `seeded API token was rejected with HTTP 401 by pinned ${OUTLINE_IMAGE}; `
        + `the v1.9.2 api-key schema/hash seed must be revisited. Response: ${body.slice(0, 2_000)}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `seeded API token verification against ${OUTLINE_IMAGE} returned HTTP ${response.status}: `
        + body.slice(0, 2_000),
    );
  }
}

function namesForRun(): ContainerNames {
  const suffix = randomUUID().slice(0, 8);
  return Object.freeze({
    outline: `steward-outline-${suffix}`,
    postgres: `steward-outline-postgres-${suffix}`,
    redis: `steward-outline-redis-${suffix}`,
  });
}

export async function bootOutline(): Promise<OutlineFixture> {
  const containers = namesForRun();
  const runId = containers.outline.slice("steward-outline-".length);
  let baseUrl = "";
  try {
    await runStep("boot:docker-daemon", containers, requireDocker);
    await runStep("boot:sweep-stray-containers", containers, sweepStrays);
    await runStep("boot:ensure-network", containers, () => ensureNetwork("docker", NETWORK, false));
    await runStep("boot:start-postgres", containers, () => docker([
      "run", "-d",
      "--name", containers.postgres,
      "--label", `${LABEL}=${runId}`,
      "--network", NETWORK,
      "--network-alias", "postgres",
      "-e", `POSTGRES_USER=${POSTGRES_USER}`,
      "-e", `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
      "-e", `POSTGRES_DB=${POSTGRES_DATABASE}`,
      POSTGRES_IMAGE,
    ]));
    await runStep("boot:start-redis", containers, () => docker([
      "run", "-d",
      "--name", containers.redis,
      "--label", `${LABEL}=${runId}`,
      "--network", NETWORK,
      "--network-alias", "redis",
      REDIS_IMAGE,
    ]));
    await runStep("boot:postgres-readiness", containers, () => waitForCommand(
      containers.postgres,
      ["pg_isready", "-U", POSTGRES_USER, "-d", POSTGRES_DATABASE],
      DEPENDENCY_READY_TIMEOUT_MS,
      "pg_isready",
    ));
    await runStep("boot:redis-readiness", containers, () => waitForCommand(
      containers.redis,
      ["redis-cli", "ping"],
      DEPENDENCY_READY_TIMEOUT_MS,
      "redis-cli ping",
    ));
    await runStep("boot:start-outline", containers, () => docker([
      "run", "-d",
      "--name", containers.outline,
      "--label", `${LABEL}=${runId}`,
      "--network", NETWORK,
      "--network-alias", "outline",
      "-p", "127.0.0.1::3000",
      "-e", "NODE_ENV=production",
      "-e", "URL=http://outline:3000",
      "-e", "PORT=3000",
      "-e", "FORCE_HTTPS=false",
      "-e", `SECRET_KEY=${SECRET_KEY}`,
      "-e", `UTILS_SECRET=${UTILS_SECRET}`,
      "-e", `DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DATABASE}`,
      "-e", "PGSSLMODE=disable",
      "-e", "REDIS_URL=redis://redis:6379",
      "-e", "FILE_STORAGE=local",
      "-e", "FILE_STORAGE_LOCAL_ROOT_DIR=/var/lib/outline/data",
      "-e", "FILE_STORAGE_UPLOAD_MAX_SIZE=26214400",
      "-e", "WEB_CONCURRENCY=1",
      OUTLINE_IMAGE,
    ]));
    const portOutput = await runStep("boot:resolve-ephemeral-port", containers, () =>
      docker(["port", containers.outline, "3000/tcp"]));
    const port = /127\.0\.0\.1:(\d+)/u.exec(portOutput)?.[1];
    if (port === undefined) {
      throw await diagnosticError(
        "boot:resolve-ephemeral-port",
        containers,
        new Error(`unexpected docker port output: ${portOutput.trim()}`),
      );
    }
    baseUrl = `http://127.0.0.1:${port}`;
    await runStep("boot:outline-health", containers, () => waitForOutlineHealth(baseUrl, containers.outline));
    await inspectSeedTables(containers);
    await runStep("seed:insert-team-user-api-key", containers, () =>
      seedApiToken(containers.postgres));
    await runStep("seed:verify-collections-list", containers, () => verifyApiToken(baseUrl));

    return Object.freeze({
      baseUrl,
      token: TOKEN_VALUE,
      containers,
      step: <T>(name: string, operation: () => Promise<T>) => runStep(`arc:${name}`, containers, operation),
      teardown: () => removeContainersBestEffort(containers),
    });
  } catch (error) {
    await removeContainersBestEffort(containers);
    throw error;
  }
}
