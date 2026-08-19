import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDeclaredScope,
  scopeViolationResult,
} from "#server/task-board/collaborators/scope-check";

const BASE_SHA = "a".repeat(40);

test("declared-scope matching is exact at prefix boundaries", async (t) => {
  const cases = [
    { name: "file equals prefix", changed: "src\n", scope: ["src"], expected: { ok: true } },
    { name: "file is rooted below prefix", changed: "src/server/index.ts\n", scope: ["src"], expected: { ok: true } },
    { name: "file is outside every prefix", changed: "docs/design.md\n", scope: ["src", "tests"], expected: { ok: false, files: ["docs/design.md"] } },
    { name: "adjacent prefix does not match", changed: "srcx/server/index.ts\n", scope: ["src"], expected: { ok: false, files: ["srcx/server/index.ts"] } },
    {
      name: "only outside files are reported in git order",
      changed: "src/server/index.ts\ndocs/design.md\ntests/server/index.test.ts\npackage.json\n",
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
        "diff", "--name-only", `${BASE_SHA}..task/work-item-one`, "--",
      ]]);
    });
  }
});

test("scope-violation results are bounded to the settlement limit", () => {
  const result = scopeViolationResult(Array.from({ length: 300 }, (_, index) => `outside/${index.toString().padStart(3, "0")}-${"x".repeat(20)}.ts`));

  assert.equal(result.length, 2_000);
  assert.match(result, /^scope violation: outside\/000-/u);
});
