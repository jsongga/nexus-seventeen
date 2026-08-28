import assert from "node:assert/strict";
import test from "node:test";
import { parseSections } from "../../../src/server/shared/sections.js";

test("parses named sections in source order without changing body bytes", () => {
  const sections = parseSections("\n \t\n## alpha\nAlpha\n## beta-two\nBeta\n", {});

  assert.deepEqual([...sections], [
    ["alpha", "Alpha\n"],
    ["beta-two", "Beta\n"],
  ]);
});

test("parses CRLF section headers without changing body bytes", () => {
  const sections = parseSections("## alpha\r\nAlpha\r\n## beta-two\r\nBeta\r\n", {});

  assert.deepEqual([...sections], [
    ["alpha", "Alpha\r\n"],
    ["beta-two", "Beta\r\n"],
  ]);
});

test("excludes trailing blank lines and normalizes bodies to one final newline", () => {
  const sections = parseSections("## alpha\nAlpha\n\n \t\n## beta\nBeta", {});

  assert.deepEqual([...sections], [
    ["alpha", "Alpha\n"],
    ["beta", "Beta\n"],
  ]);
});

test("applies an optional section-name rule", () => {
  assert.deepEqual(
    [...parseSections("## alpha.beta_gamma:delta\nBody\n", { nameRule: /^[a-z][a-z._:]+$/u })],
    [["alpha.beta_gamma:delta", "Body\n"]],
  );
  assert.throws(
    () => parseSections("## alpha\nAlpha\n", { nameRule: /^beta$/u }),
    /Section header is invalid/u,
  );
});

test("rejects ambiguous or incomplete section sources", () => {
  const cases: Array<readonly [string, string, RegExp]> = [
    ["non-blank preamble", "guidance\n## alpha\nAlpha\n", /text before the first header/u],
    ["no sections", "\n \t\n", /contains no sections/u],
    ["invalid header", "## alpha\nAlpha\n## Invalid\nOther\n", /Section header is invalid/u],
    ["duplicate name", "## alpha\nAlpha\n## alpha\nOther\n", /duplicated: alpha/u],
    ["empty body", "## alpha\n## beta\nBeta\n", /body is empty: alpha/u],
    ["whitespace-only body", "## alpha\n \t\n", /body is empty: alpha/u],
  ];

  for (const [label, source, expected] of cases) {
    assert.throws(() => parseSections(source, {}), expected, label);
  }
});

test("attributes body errors to the section containing them", () => {
  assert.throws(
    () => parseSections("## alpha\nAlpha\n\n## beta\n \t\n", {}),
    /body is empty: beta/u,
  );
});
