import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  SUPERVISOR_LOCK_FILENAME,
  SupervisorProcessLocks,
} from "#server/agents/supervisor/process-lock";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((pathname) => rm(pathname, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-lock-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "workspace/one"), { recursive: true }),
    mkdir(join(root, "workspace/two"), { recursive: true }),
  ]);
  return root;
}

test("state and working directories are exclusively locked until safe release", async () => {
  const root = await fixtureRoot();
  const stateOne = join(root, "state/one");
  const stateTwo = join(root, "state/two");
  const workOne = join(root, "workspace/one");
  const workTwo = join(root, "workspace/two");
  const first = await SupervisorProcessLocks.acquire(stateOne, workOne);

  await assert.rejects(
    SupervisorProcessLocks.acquire(stateOne, workTwo),
    /already locked/,
  );
  await assert.rejects(
    SupervisorProcessLocks.acquire(stateTwo, workOne),
    /already locked/,
  );
  assert.equal((await lstat(stateOne)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(stateOne, SUPERVISOR_LOCK_FILENAME))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(workOne, SUPERVISOR_LOCK_FILENAME))).mode & 0o777, 0o600);

  await first.release();
  await assert.rejects(readFile(join(stateOne, SUPERVISOR_LOCK_FILENAME), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(join(workOne, SUPERVISOR_LOCK_FILENAME), "utf8"), { code: "ENOENT" });
  const replacement = await SupervisorProcessLocks.acquire(stateOne, workOne);
  await replacement.release();
});

test("a lock owned by a dead PID is recovered and replaced with PID/nonce metadata", async () => {
  const root = await fixtureRoot();
  const stateDirectory = join(root, "state/stale");
  const workingDirectory = join(root, "workspace/one");
  await mkdir(stateDirectory, { recursive: true });
  const canonicalState = await realpath(stateDirectory);
  await writeFile(
    join(stateDirectory, SUPERVISOR_LOCK_FILENAME),
    `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
      directory: canonicalState,
      resources: ["stateDirectory"],
    })}\n`,
    { mode: 0o600 },
  );

  const locks = await SupervisorProcessLocks.acquire(stateDirectory, workingDirectory);
  const metadata = JSON.parse(await readFile(join(stateDirectory, SUPERVISOR_LOCK_FILENAME), "utf8")) as {
    pid: number;
    nonce: string;
  };
  assert.equal(metadata.pid, process.pid);
  assert.notEqual(metadata.nonce.length, 0);
  await locks.release();
});

test("a symbolic-link state boundary is rejected without deleting its target", async () => {
  const root = await fixtureRoot();
  const target = join(root, "state/real");
  const alias = join(root, "state/alias");
  await mkdir(target, { recursive: true });
  await symlink(target, alias, "dir");

  await assert.rejects(
    SupervisorProcessLocks.acquire(alias, join(root, "workspace/one")),
    /symbolic link/,
  );
  assert.equal((await lstat(target)).isDirectory(), true);
  await assert.rejects(readFile(join(target, SUPERVISOR_LOCK_FILENAME), "utf8"), { code: "ENOENT" });
});

test("canonical path aliases cannot place supervisor state inside the writable workspace", async () => {
  const root = await fixtureRoot();
  const workingDirectory = join(root, "workspace/one");
  const alias = join(root, "state-alias");
  await symlink(workingDirectory, alias, "dir");
  const aliasedState = join(alias, "private/supervisor-state");

  await assert.rejects(
    SupervisorProcessLocks.acquire(aliasedState, workingDirectory),
    /must be disjoint/i,
  );
  await assert.rejects(
    readFile(join(workingDirectory, SUPERVISOR_LOCK_FILENAME), "utf8"),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(join(workingDirectory, "private/supervisor-state", SUPERVISOR_LOCK_FILENAME), "utf8"),
    { code: "ENOENT" },
  );
});
