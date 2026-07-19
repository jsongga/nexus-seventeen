import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RegistrationIntentStore } from "../src/registration-intent.js";
import { configFixture, registrationIdentity } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "steward-registration-intent-"));
  temporaryDirectories.push(root);
  const config = configFixture(root, { runtimeInstanceId: "runtime-new-config" });
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  return { root, config, store: new RegistrationIntentStore(config.stateDirectory) };
}

test("registration intent survives both pre-commit and issued-epoch crash boundaries", async () => {
  const { config, store } = await fixture();
  const request = registrationIdentity(null);
  await store.write(request);

  assert.deepEqual(await store.load(config, 0, null), request, "intent survives before the registration POST");
  assert.deepEqual(await store.load(config, 1, null), request, "intent survives after issued epoch persistence");
  await assert.rejects(
    store.load(config, 2, null),
    /inconsistent with the durably observed runtime epoch/i,
  );

  await store.clear(request);
  assert.equal(await store.load(config, 1, null), null);
});

test("registration intent rejects public modes and symbolic-link substitution", async () => {
  const { root, config, store } = await fixture();
  const request = registrationIdentity(null);
  const intentPath = join(config.stateDirectory, "registration-intent.json");
  await store.write(request);
  await chmod(intentPath, 0o644);
  await assert.rejects(store.load(config, 0, null), /private bounded regular file/i);

  await rm(intentPath);
  const target = join(root, "outside-intent.json");
  await writeFile(target, `${JSON.stringify({ version: 1, request })}\n`, { mode: 0o600 });
  await symlink(target, intentPath);
  await assert.rejects(store.load(config, 0, null), (error: unknown) => {
    return ["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "");
  });
  assert.match(await readFile(target, "utf8"), /runtime-test/);
});

test("registration intent refuses changed identity, role, provider, or checkpoint", async () => {
  const { config, store } = await fixture();
  await store.write(registrationIdentity(null));
  const changedRole = configFixture(config.workingDirectory.replace(/\/workspace\/project$/, ""), {
    runtimeInstanceId: "runtime-other",
    role: "manager",
  });
  await assert.rejects(store.load(changedRole, 0, null), /does not match.*configuration/i);
  await assert.rejects(store.load(config, 0, "different-checkpoint"), /checkpoint reference/i);
});
