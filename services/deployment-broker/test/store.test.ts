import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DeploymentGrantBroker } from "../src/broker.js";
import { sha256 } from "../src/canonical.js";
import { normalizeConfig } from "../src/config.js";
import { createRequest, handoffRequest, options, tempRoot } from "./helpers.js";

test("store is private, contains no credentials, and recovers an incomplete tail", async () => {
  const root = await tempRoot();
  const config = normalizeConfig(options(root));
  const broker = await DeploymentGrantBroker.open(config);
  const handoff = await broker.registerManagerHandoff(handoffRequest(), "handoff-storage-0001");
  await broker.createGrant(createRequest({ handoffId: handoff.handoff.handoffId }), "create-storage-0001");
  await broker.close();

  assert.equal((await stat(config.storePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  const before = await readFile(config.storePath, "utf8");
  assert.doesNotMatch(before, /human-reviewer-token|external-deployer-token/u);
  await appendFile(config.storePath, "{\"partial\":", "utf8");

  const recovered = await DeploymentGrantBroker.open(config);
  await recovered.close();
  assert.equal(await readFile(config.storePath, "utf8"), before);
});

test("complete corruption and content tampering fail closed", async () => {
  const root = await tempRoot();
  const config = normalizeConfig(options(root));
  await mkdir(join(root, "private"), { mode: 0o700 });
  await writeFile(config.storePath, "{\"complete\":\"but invalid\"}\n", { mode: 0o600 });
  await assert.rejects(DeploymentGrantBroker.open(config), /STORE_CORRUPT/u);

  const secondRoot = await tempRoot();
  const secondConfig = normalizeConfig(options(secondRoot));
  const broker = await DeploymentGrantBroker.open(secondConfig);
  const handoff = await broker.registerManagerHandoff(handoffRequest(), "handoff-tamper-0001");
  await broker.createGrant(createRequest({ handoffId: handoff.handoff.handoffId }), "create-tamper-0001");
  await broker.close();
  const lines = (await readFile(secondConfig.storePath, "utf8")).trim().split("\n");
  const event = JSON.parse(lines[1]!) as Record<string, unknown>;
  (event.grant as Record<string, unknown>).taskId = "tampered-task";
  lines[1] = JSON.stringify(event);
  await writeFile(secondConfig.storePath, `${lines.join("\n")}\n`, { mode: 0o600 });
  await assert.rejects(DeploymentGrantBroker.open(secondConfig), /content hash does not match/u);
});

test("every existing lock fails closed until an operator removes the exact verified stale lock", async () => {
  const root = await tempRoot();
  const config = normalizeConfig(options(root));
  const privateDirectory = join(root, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  await writeFile(`${config.storePath}.lock`, JSON.stringify({
    pid: 2_147_483_647,
    nonce: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-07-18T20:00:00.000Z",
  }), { mode: 0o600 });
  await assert.rejects(DeploymentGrantBroker.open(config), /STORE_LOCKED/u);
  await unlink(`${config.storePath}.lock`);
  const first = await DeploymentGrantBroker.open(config);
  await assert.rejects(DeploymentGrantBroker.open(config), /STORE_LOCKED/u);
  await first.close();
  assert.equal((await stat(privateDirectory)).isDirectory(), true);
});

test("an existing shared state directory is rejected instead of being silently relabeled private", async () => {
  const root = await tempRoot();
  await chmod(root, 0o755);
  const config = normalizeConfig({ ...options(root), storePath: join(root, "grants.jsonl") });
  await assert.rejects(DeploymentGrantBroker.open(config), /DIRECTORY_UNSAFE/u);
  assert.equal((await stat(root)).mode & 0o777, 0o755);
});

test("legacy v2 records without a manifest binding fail closed", async () => {
  const root = await tempRoot();
  const config = normalizeConfig(options(root));
  const broker = await DeploymentGrantBroker.open(config);
  await broker.registerManagerHandoff(handoffRequest(), "handoff-version-0001");
  await broker.close();

  const legacy = JSON.parse((await readFile(config.storePath, "utf8")).trim()) as Record<string, unknown>;
  delete legacy.contentHash;
  legacy.storeVersion = 2;
  const legacyHandoff = legacy.handoff as Record<string, unknown>;
  legacyHandoff.apiVersion = 2;
  delete legacyHandoff.releaseManifestDigest;
  legacy.contentHash = sha256(legacy);
  await writeFile(config.storePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  await assert.rejects(DeploymentGrantBroker.open(config), /sequence or version is invalid/u);
});
