import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { HOST_LIST_CAP, listDirectories, listProjectRoots } from "#server/task-board/host";

async function makeHome(): Promise<string> {
  // realpath: on macOS tmpdir is a /var -> /private/var symlink; containment compares realpaths.
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-test-")));
  await mkdir(join(home, "WebstormProjects", "alpha", ".git"), { recursive: true });
  await mkdir(join(home, "WebstormProjects", "beta"), { recursive: true });
  await mkdir(join(home, "WebstormProjects", ".hidden"), { recursive: true });
  await mkdir(join(home, "PycharmProjects", "gamma"), { recursive: true });
  await mkdir(join(home, "NotAroot"), { recursive: true });
  await mkdir(join(home, ".dotProjects"), { recursive: true });
  await writeFile(join(home, "WebstormProjects", "afile.txt"), "x");
  return home;
}

test("listProjectRoots finds *Projects roots, skips hidden and files, flags git", async () => {
  const home = await makeHome();
  try {
    const roots = await listProjectRoots({ homeDir: home, rootsOverride: null });
    assert.deepEqual(roots.map((root) => root.name), ["PycharmProjects", "WebstormProjects"]);
    const web = roots[1];
    assert.deepEqual(web.projects.map((p) => p.name), ["alpha", "beta"]);
    assert.equal(web.projects[0].hasGit, true);
    assert.equal(web.projects[1].hasGit, false);
    assert.ok(web.projects.every((p) => p.modifiedAtMs > 0));
    assert.equal(web.truncated, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listProjectRoots override replaces detection and skips missing roots", async () => {
  const home = await makeHome();
  try {
    const roots = await listProjectRoots({
      homeDir: home,
      rootsOverride: [join(home, "NotAroot"), join(home, "missing")],
    });
    assert.deepEqual(roots.map((root) => root.name), ["NotAroot"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listDirectories lists subdirectories with parent, rejects escape/missing/file", async () => {
  const home = await makeHome();
  try {
    const context = { homeDir: home, rootsOverride: null };
    const listing = await listDirectories(context, join(home, "WebstormProjects"));
    assert.deepEqual(listing.entries.map((e) => e.name), ["alpha", "beta"]);
    assert.equal(listing.parent, home);
    const top = await listDirectories(context, home);
    assert.equal(top.parent, null);
    await assert.rejects(() => listDirectories(context, "/etc"), (error: { code: string }) => error.code === "HOST_PATH_OUTSIDE_ROOTS");
    await assert.rejects(() => listDirectories(context, join(home, "nope")), (error: { code: string }) => error.code === "HOST_PATH_NOT_FOUND");
    await assert.rejects(() => listDirectories(context, join(home, "WebstormProjects", "afile.txt")), (error: { code: string }) => error.code === "HOST_PATH_NOT_DIRECTORY");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listDirectories refuses a symlink that escapes the browsable area", async () => {
  const home = await makeHome();
  try {
    await symlink("/etc", join(home, "escape"));
    await assert.rejects(
      () => listDirectories({ homeDir: home, rootsOverride: null }, join(home, "escape")),
      (error: { code: string }) => error.code === "HOST_PATH_OUTSIDE_ROOTS",
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listings cap at HOST_LIST_CAP and set truncated", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-cap-")));
  try {
    const root = join(home, "BigProjects");
    await Promise.all(Array.from({ length: HOST_LIST_CAP + 1 }, (_, i) =>
      mkdir(join(root, `p${String(i).padStart(4, "0")}`), { recursive: true })));
    const roots = await listProjectRoots({ homeDir: home, rootsOverride: null });
    assert.equal(roots[0].projects.length, HOST_LIST_CAP);
    assert.equal(roots[0].truncated, true);
    const listing = await listDirectories({ homeDir: home, rootsOverride: null }, root);
    assert.equal(listing.entries.length, HOST_LIST_CAP);
    assert.equal(listing.truncated, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("listProjectRoots skips an auto-detected root symlinked outside home", async () => {
  const home = await makeHome();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "host-outside-")));
  try {
    await mkdir(join(outside, "secret"));
    await symlink(outside, join(home, "EvilProjects"));
    const roots = await listProjectRoots({ homeDir: home, rootsOverride: null });
    assert.equal(roots.some((root) => root.name === "EvilProjects"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("project and directory listings skip entries symlinked outside home", async () => {
  const home = await makeHome();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "host-outside-")));
  try {
    await symlink(outside, join(home, "WebstormProjects", "external"));
    const roots = await listProjectRoots({ homeDir: home, rootsOverride: null });
    const web = roots.find((root) => root.name === "WebstormProjects");
    assert.deepEqual(web?.projects.map((project) => project.name), ["alpha", "beta"]);

    const listing = await listDirectories(
      { homeDir: home, rootsOverride: null },
      join(home, "WebstormProjects"),
    );
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["alpha", "beta"]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("listDirectories rejects an existing sibling with a shared path prefix", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "host-prefix-")));
  const home = join(fixture, "home", "user");
  const sibling = join(fixture, "home", "username-other");
  try {
    await mkdir(home, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await assert.rejects(
      () => listDirectories({ homeDir: home, rootsOverride: null }, sibling),
      (error: { code: string; status: number }) =>
        error.status === 403 && error.code === "HOST_PATH_OUTSIDE_ROOTS",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("listDirectories does not reveal whether paths outside home exist", async () => {
  const home = await makeHome();
  try {
    const context = { homeDir: home, rootsOverride: null };
    await assert.rejects(
      () => listDirectories(context, "/definitely/not/a/real/path"),
      (error: { code: string; status: number }) =>
        error.status === 403 && error.code === "HOST_PATH_OUTSIDE_ROOTS",
    );
    await assert.rejects(
      () => listDirectories(context, join(home, "nope")),
      (error: { code: string; status: number }) =>
        error.status === 404 && error.code === "HOST_PATH_NOT_FOUND",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listDirectories reports an unreadable directory", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can read mode-0o000 directories");
    return;
  }
  const home = await makeHome();
  const unreadable = join(home, "unreadable");
  try {
    await mkdir(unreadable);
    await chmod(unreadable, 0o000);
    await assert.rejects(
      () => listDirectories({ homeDir: home, rootsOverride: null }, unreadable),
      (error: { code: string; status: number }) =>
        error.status === 403 && error.code === "HOST_PATH_UNREADABLE",
    );
  } finally {
    await chmod(unreadable, 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

test("listProjectRoots sorts override roots by name", async () => {
  const home = await makeHome();
  const rootA = join(home, "A");
  const rootB = join(home, "B");
  try {
    await mkdir(rootA);
    await mkdir(rootB);
    const roots = await listProjectRoots({ homeDir: home, rootsOverride: [rootB, rootA] });
    assert.deepEqual(roots.map((root) => root.name), ["A", "B"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a filesystem-root base admits absolute paths", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "host-root-base-")));
  try {
    const listing = await listDirectories({ homeDir: sep, rootsOverride: null }, directory);
    assert.equal(listing.path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
