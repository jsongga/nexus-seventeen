import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  checkDeclaredScope,
  declaredScopesOverlap,
  runDeclaredScopeGit,
  scopeViolationResult,
} from "#server/task-board/collaborators/scope-check";
import { ContractValidationError } from "#shared/task-board-contract/validate";

const BASE_SHA = "a".repeat(40);

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function fixtureRepo(): Promise<{ root: string; repo: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "steward-scope-check-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await writeFile(join(repo, "readme.md"), "scope check\n");
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "initial"]);
  return { root, repo, head: (await git(repo, ["rev-parse", "HEAD"])).trim() };
}

async function commitFile(repo: string, branch: string, path: string): Promise<void> {
  await git(repo, ["checkout", "-b", branch]);
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), `${path}\n`);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "--", path]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", `change ${path}`]);
}

test("declared-scope overlap matches exact and nested path prefixes", async (t) => {
  const cases = [
    { name: "equal prefixes", a: ["src/server"], b: ["src/server"], expected: true },
    { name: "first prefix is the parent", a: ["src"], b: ["src/server"], expected: true },
    { name: "second prefix is the parent", a: ["src/server"], b: ["src"], expected: true },
    { name: "disjoint siblings", a: ["src/server"], b: ["src/web"], expected: false },
    { name: "trailing slashes are normalized", a: ["src/server///"], b: ["src/server/routes/"], expected: true },
    { name: "any pair may overlap", a: ["docs", "src/server"], b: ["tests", "src"], expected: true },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      assert.equal(declaredScopesOverlap(item.a, item.b), item.expected);
    });
  }
});

test("declared-scope overlap rejects empty normalized prefixes", () => {
  assert.throws(() => declaredScopesOverlap([""], ["src"]), ContractValidationError);
  assert.throws(() => declaredScopesOverlap(["src"], ["///"]), ContractValidationError);
});

test("declared-scope matching is exact at prefix boundaries", async (t) => {
  const cases = [
    { name: "file equals prefix", changed: "src\0", scope: ["src"], expected: { ok: true } },
    { name: "file is rooted below prefix", changed: "src/server/index.ts\0", scope: ["src"], expected: { ok: true } },
    { name: "trailing slashes are normalized", changed: "src/server/index.ts\0", scope: ["src/"], expected: { ok: true } },
    { name: "file is outside every prefix", changed: "docs/design.md\0", scope: ["src", "tests"], expected: { ok: false, files: ["docs/design.md"] } },
    { name: "adjacent prefix does not match", changed: "srcx/server/index.ts\0", scope: ["src"], expected: { ok: false, files: ["srcx/server/index.ts"] } },
    {
      name: "only outside files are reported in git order",
      changed: "src/server/index.ts\0docs/design.md\0tests/server/index.test.ts\0package.json\0",
      scope: ["src", "tests/server"],
      expected: { ok: false, files: ["docs/design.md", "package.json"] },
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, () => {
      const calls: string[][] = [];
      const actual = checkDeclaredScope({
        repoPath: "/registered/repository",
        baseSha: BASE_SHA,
        branch: "task/work-item-one",
        declaredScope: item.scope,
        git: (arguments_) => {
          calls.push([...arguments_]);
          return item.changed;
        },
      });

      assert.deepEqual(actual, item.expected);
      assert.deepEqual(calls, [[
        "-c", "core.fsmonitor=",
        "-c", "core.hooksPath=",
        "-C", "/registered/repository",
        "diff", "--no-renames", "--name-only", "-z", `${BASE_SHA}..task/work-item-one`, "--",
      ]]);
    });
  }
});

test("empty declared-scope prefixes fail closed before Git runs", () => {
  for (const declaredScope of [[""], ["/"], ["///"]]) {
    let gitCalled = false;
    assert.throws(() => checkDeclaredScope({
      repoPath: "/registered/repository",
      baseSha: BASE_SHA,
      branch: "task/work-item-one",
      declaredScope,
      git: () => {
        gitCalled = true;
        return "";
      },
    }), /empty path prefix/u);
    assert.equal(gitCalled, false);
  }
});

test("NUL-delimited scope checks preserve spaces and non-ASCII path characters", async (t) => {
  const repository = await fixtureRepo();
  t.after(async () => rm(repository.root, { recursive: true, force: true }));
  const branch = "task/unicode-path";
  await commitFile(repository.repo, branch, "src/café file.ts");

  assert.deepEqual(checkDeclaredScope({
    repoPath: repository.repo,
    baseSha: repository.head,
    branch,
    declaredScope: ["src"],
    git: runDeclaredScopeGit,
  }), { ok: true });
});

test("renaming an outside file into declared scope still reports the deleted source", async (t) => {
  const repository = await fixtureRepo();
  t.after(async () => rm(repository.root, { recursive: true, force: true }));
  await mkdir(join(repository.repo, "docs"));
  await writeFile(join(repository.repo, "docs/outside.md"), "outside\n");
  await git(repository.repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "docs/outside.md"]);
  await git(repository.repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add outside file"]);
  const baseSha = (await git(repository.repo, ["rev-parse", "HEAD"])).trim();
  const branch = "task/rename-into-scope";
  await git(repository.repo, ["checkout", "-b", branch]);
  await mkdir(join(repository.repo, "src"));
  await git(repository.repo, ["mv", "docs/outside.md", "src/outside.md"]);
  await git(repository.repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "move into scope"]);

  assert.deepEqual(checkDeclaredScope({
    repoPath: repository.repo,
    baseSha,
    branch,
    declaredScope: ["src"],
    git: runDeclaredScopeGit,
  }), { ok: false, files: ["docs/outside.md"] });
});

test("scope-violation results are bounded to the settlement limit", () => {
  const result = scopeViolationResult(Array.from({ length: 300 }, (_, index) => `outside/${index.toString().padStart(3, "0")}-${"x".repeat(20)}.ts`));

  assert.equal(result.length, 2_000);
  assert.match(result, /^scope violation: outside\/000-/u);
});
