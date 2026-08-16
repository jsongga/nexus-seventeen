import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TaskBoardError,
  createTaskBoardService,
  normalizeTaskBoardConfig,
} from "#server/task-board";
import { AGENT_ONE_TOKEN, HUMAN_TOKEN } from "./helpers.js";

async function makeHome(): Promise<{ home: string; outside: string; databaseRoot: string }> {
  // realpath: on macOS tmpdir is a /var -> /private/var symlink; containment compares realpaths.
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-routes-test-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "host-routes-outside-")));
  const databaseRoot = await realpath(await mkdtemp(join(tmpdir(), "host-routes-database-")));
  await mkdir(join(home, "WebstormProjects", "alpha", ".git"), { recursive: true });
  await mkdir(join(home, "WebstormProjects", "beta"), { recursive: true });
  await mkdir(join(home, "PycharmProjects", "gamma"), { recursive: true });
  await mkdir(join(home, "NotAroot", "delta"), { recursive: true });
  await mkdir(join(outside, "secret"));
  await symlink(join(outside, "secret"), join(home, "WebstormProjects", "external"));
  await symlink(outside, join(home, "EvilProjects"));
  return { home, outside, databaseRoot };
}

function get(origin: string, path: string, token?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

function serviceOptions(homeDir?: string, projectRoots?: readonly string[], databaseRoot = tmpdir()) {
  return {
    dbPath: join(databaseRoot, "private", `host-routes-${crypto.randomUUID()}.sqlite`),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    host: homeDir === undefined ? undefined : { homeDir, projectRoots },
  };
}

test("host configuration defaults, resolves overrides, and validates project roots", () => {
  const defaults = normalizeTaskBoardConfig(serviceOptions());
  assert.deepEqual(defaults.host, { homeDir: homedir(), rootsOverride: null });

  const explicit = normalizeTaskBoardConfig(serviceOptions("/tmp/test-home", ["/tmp/project-root"]));
  assert.deepEqual(explicit.host, {
    homeDir: "/tmp/test-home",
    rootsOverride: ["/tmp/project-root"],
  });

  assert.throws(
    () => normalizeTaskBoardConfig(serviceOptions("/tmp/test-home", ["relative/root"])),
    (error: unknown) => error instanceof TaskBoardError
      && error.status === 500
      && error.code === "INVALID_CONFIGURATION"
      && error.message === "host.projectRoots entries must be absolute paths",
  );

  for (const projectRoot of [" /tmp/project-root", "/tmp/project\u0000root", `/${"a".repeat(4_096)}`]) {
    assert.throws(
      () => normalizeTaskBoardConfig(serviceOptions("/tmp/test-home", [projectRoot])),
      (error: unknown) => error instanceof TaskBoardError
        && error.status === 500
        && error.code === "INVALID_CONFIGURATION"
        && error.message === "host.projectRoots entry is invalid",
    );
  }
});

test("host routes are human-only and expose detected roots and safe directory listings", async () => {
  const { home, outside, databaseRoot } = await makeHome();
  const service = await createTaskBoardService(serviceOptions(home, undefined, databaseRoot));
  try {
    const address = await service.start();

    assert.equal((await get(address.url, "/v1/host/project-roots")).status, 401);
    assert.equal((await get(address.url, "/v1/host/project-roots", AGENT_ONE_TOKEN)).status, 401);
    assert.equal((await get(address.url, "/v1/host/directories")).status, 401);
    assert.equal((await get(address.url, "/v1/host/directories", AGENT_ONE_TOKEN)).status, 401);

    const rootsResponse = await get(address.url, "/v1/host/project-roots", HUMAN_TOKEN);
    assert.equal(rootsResponse.status, 200);
    const rootsBody = await rootsResponse.json() as {
      roots: Array<{
        name: string;
        path: string;
        projects: Array<{ name: string; path: string; hasGit: boolean; modifiedAtMs: number }>;
        truncated: boolean;
      }>;
    };
    assert.deepEqual(rootsBody.roots.map((root) => ({
      name: root.name,
      path: root.path,
      projects: root.projects.map((project) => ({
        name: project.name,
        path: project.path,
        hasGit: project.hasGit,
      })),
      truncated: root.truncated,
    })), [
      {
        name: "PycharmProjects",
        path: join(home, "PycharmProjects"),
        projects: [{
          name: "gamma",
          path: join(home, "PycharmProjects", "gamma"),
          hasGit: false,
        }],
        truncated: false,
      },
      {
        name: "WebstormProjects",
        path: join(home, "WebstormProjects"),
        projects: [
          { name: "alpha", path: join(home, "WebstormProjects", "alpha"), hasGit: true },
          { name: "beta", path: join(home, "WebstormProjects", "beta"), hasGit: false },
        ],
        truncated: false,
      },
    ]);
    assert.ok(rootsBody.roots.every((root) =>
      root.projects.every((project) => Number.isSafeInteger(project.modifiedAtMs) && project.modifiedAtMs > 0)));

    const homeResponse = await get(address.url, "/v1/host/directories", HUMAN_TOKEN);
    assert.equal(homeResponse.status, 200);
    assert.equal((await homeResponse.json() as { listing: { path: string } }).listing.path, home);

    const projectsResponse = await get(
      address.url,
      `/v1/host/directories?path=${encodeURIComponent(join(home, "WebstormProjects"))}`,
      HUMAN_TOKEN,
    );
    assert.equal(projectsResponse.status, 200);
    const projectsBody = await projectsResponse.json() as {
      listing: { entries: Array<{ name: string }> };
    };
    assert.deepEqual(projectsBody.listing.entries.map((entry) => entry.name), ["alpha", "beta"]);

    const outsideResponse = await get(address.url, "/v1/host/directories?path=%2Fetc", HUMAN_TOKEN);
    assert.equal(outsideResponse.status, 403);
    assert.deepEqual(await outsideResponse.json(), {
      error: { code: "HOST_PATH_OUTSIDE_ROOTS", message: "The folder is outside the browsable area" },
    });

    const outsideMissingResponse = await get(
      address.url,
      "/v1/host/directories?path=%2Fdefinitely%2Fnot%2Fa%2Freal%2Fpath",
      HUMAN_TOKEN,
    );
    assert.equal(outsideMissingResponse.status, 403);
    assert.deepEqual(await outsideMissingResponse.json(), {
      error: { code: "HOST_PATH_OUTSIDE_ROOTS", message: "The folder is outside the browsable area" },
    });

    const missingResponse = await get(
      address.url,
      `/v1/host/directories?path=${encodeURIComponent(join(home, "nope"))}`,
      HUMAN_TOKEN,
    );
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), {
      error: { code: "HOST_PATH_NOT_FOUND", message: "The folder does not exist" },
    });

    const duplicatePath = `/v1/host/directories?path=${encodeURIComponent(home)}&path=%2Fx`;
    assert.equal((await get(address.url, duplicatePath, HUMAN_TOKEN)).status, 400);
    assert.equal((await get(address.url, "/v1/host/directories?other=1", HUMAN_TOKEN)).status, 400);
    const nulResponse = await get(address.url, "/v1/host/directories?path=%2Ftmp%00x", HUMAN_TOKEN);
    assert.equal(nulResponse.status, 400);
    assert.deepEqual(await nulResponse.json(), {
      error: {
        code: "INVALID_REQUEST",
        message: "path must be an absolute path of at most 512 characters",
      },
    });
    assert.equal((await get(
      address.url,
      `/v1/host/directories?path=${encodeURIComponent(`/${"a".repeat(512)}`)}`,
      HUMAN_TOKEN,
    )).status, 400);
  } finally {
    await service.close();
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(databaseRoot, { recursive: true, force: true });
  }
});

test("project root overrides replace automatic detection", async () => {
  const { home, outside, databaseRoot } = await makeHome();
  const overrideRoot = join(home, "NotAroot");
  const service = await createTaskBoardService(serviceOptions(home, [overrideRoot], databaseRoot));
  try {
    const address = await service.start();
    const response = await get(address.url, "/v1/host/project-roots", HUMAN_TOKEN);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      roots: Array<{ name: string; path: string; projects: Array<{ name: string }> }>;
    };
    assert.deepEqual(body.roots.map((root) => ({
      name: root.name,
      path: root.path,
      projects: root.projects.map((project) => project.name),
    })), [{ name: "NotAroot", path: overrideRoot, projects: ["delta"] }]);
  } finally {
    await service.close();
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(databaseRoot, { recursive: true, force: true });
  }
});
