import assert from "node:assert/strict";
import test from "node:test";
import { globToRegExp, mapChangedFiles } from "#server/agents/verify";
import type { MappingHost, VerifyRule } from "#server/agents/verify";

const RULES: readonly VerifyRule[] = [
  { match: "tests/container/**", action: { kind: "escalate" } },
  { match: "tests/**/*.test.ts", action: { kind: "self" } },
  { match: "src/server/**/*.ts", action: { kind: "mirror" } },
  { match: "src/shared/**", action: { kind: "fixed", nodeTestDirs: ["tests/server", "tests/shared"] } },
  { match: "src/web/**", action: { kind: "colocated", vitestFallback: "src/web" } },
  { match: "docs/**", action: { kind: "none" } },
];
const host = (files: string[], dirs: string[]): MappingHost => ({
  fileExists: (p) => files.includes(p),
  directoryExists: (p) => dirs.includes(p),
});

test("globToRegExp semantics", () => {
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("tests/**/*.test.ts").test("tests/foo.test.ts"));
  assert.ok(globToRegExp("src/server/**/*.ts").test("src/server/x.ts"));
  assert.ok(globToRegExp("tests/**/*.test.ts").test("tests/unit/foo.test.ts"));
  assert.ok(globToRegExp("src/server/**/*.ts").test("src/server/a/b/c.ts"));
  assert.ok(!globToRegExp("src/server/**/*.ts").test("src/web/x.ts"));
  assert.ok(!globToRegExp("src/server/*.ts").test("src/server/a/b.ts"));
  assert.ok(globToRegExp("Dockerfile").test("Dockerfile"));
  assert.ok(!globToRegExp("Dockerfile").test("sub/Dockerfile"));
  assert.ok(globToRegExp("tsconfig*.json").test("tsconfig.test.json"));
});

test("colocated selects an already-colocated test directly in fast tier and falls back in area tier", () => {
  const h = host(["src/web/x.test.tsx"], []);

  const fast = mapChangedFiles(["src/web/x.test.tsx"], RULES, "fast", h);
  assert.deepEqual(fast.vitestTargets, ["src/web/x.test.tsx"]);

  const area = mapChangedFiles(["src/web/x.test.tsx"], RULES, "area", h);
  assert.deepEqual(area.vitestTargets, ["src/web"]);
});

test("mirror fast prefers the exact test file, falls back to dir, escalates when neither exists", () => {
  const h = host(["tests/server/x/a.test.ts"], ["tests/server/x"]);
  const hit = mapChangedFiles(["src/server/x/a.ts"], RULES, "fast", h);
  assert.deepEqual(hit.nodeTestFiles, ["tests/server/x/a.test.ts"]);
  const dirOnly = mapChangedFiles(["src/server/x/b.ts"], RULES, "fast", h);
  assert.deepEqual(dirOnly.nodeTestDirs, ["tests/server/x"]);
  const nothing = mapChangedFiles(["src/server/y/c.ts"], RULES, "fast", h);
  assert.equal(nothing.escalations.length, 1);
  assert.match(nothing.escalations[0] ?? "", /no mirror/u);
});

test("first match wins, escalate and unmatched are reported, docs map to nothing", () => {
  const h = host([], ["tests/server", "tests/shared"]);
  const sel = mapChangedFiles(
    ["tests/container/x.test.ts", "docs/a.md", "weird.bin", "src/shared/contract.ts"],
    RULES, "fast", h,
  );
  assert.equal(sel.escalations.length, 1);
  assert.deepEqual(sel.unmatched, ["weird.bin"]);
  assert.deepEqual(sel.nodeTestDirs, ["tests/server", "tests/shared"]);
});

test("area tier lifts self and mirror to directories and colocated to the fallback", () => {
  const h = host(["src/web/x.test.tsx"], ["tests/server/x"]);
  const sel = mapChangedFiles(
    ["tests/server/x/a.test.ts", "src/server/x/a.ts", "src/web/x.tsx"],
    RULES, "area", h,
  );
  assert.deepEqual(sel.nodeTestFiles, []);
  assert.deepEqual(sel.nodeTestDirs, ["tests/server/x"]);
  assert.deepEqual(sel.vitestTargets, ["src/web"]);
});
