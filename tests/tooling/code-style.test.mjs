import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const excludedDirectories = new Set([
  ".git",
  ".superpowers",
  ".test-dist",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const bannerExtensions = new Set([".cjs", ".css", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const productionExtension = /\.(?:[cm]?[jt]sx?)$/u;
const testModule = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const singleLineModuleHeader = /^\/\*\* \S(?:.*\S)? \*\/$/u;
const expandedModuleHeaderLine = /^ \*(?: .*)?$/u;
const banner = /^\/\* —— .+ —— \*\/$/u;
// A banner attempt is any COMMENT line carrying the em-dash pair. Detection
// ignores how the comment was opened, so every malformed variant (doc-comment
// opener, no spaces, line-comment form, indented, or a marker split across a
// block comment body) reaches the exact-form check instead of slipping past it.
// The pair inside a string or template literal is data, not a banner: the
// scanner below tracks literal state so quoting a banner never trips the rule.
// Regex literals are not tracked — a regex containing `/*` would be read as
// opening a comment. No source does that today, and the cost of being wrong is
// a loud failing test, not a silent bypass.
const emDashPair = /——/u;
const moduleHeaderAllowlistBaseline = 125;

// Returns true when the line contains a comment (line or block, including a
// continuation of one opened earlier), tracking string and template state so a
// `/*` inside a literal does not open one. `state` is carried across lines.
function commentCarryingEmDash(line, state) {
  let inComment = state.inBlockComment;
  let index = 0;
  while (index < line.length) {
    const two = line.slice(index, index + 2);
    if (state.inBlockComment) {
      if (two === "*/") {
        state.inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (state.inTemplate) {
      if (line[index] === "\\") index += 2;
      else {
        if (line[index] === "`") state.inTemplate = false;
        index += 1;
      }
      continue;
    }
    if (line[index] === "'" || line[index] === '"') {
      const quote = line[index];
      index += 1;
      while (index < line.length && line[index] !== quote) index += line[index] === "\\" ? 2 : 1;
      index += 1;
      continue;
    }
    if (line[index] === "`") {
      state.inTemplate = true;
      index += 1;
      continue;
    }
    if (two === "//") return emDashPair.test(line);
    if (two === "/*") {
      state.inBlockComment = true;
      inComment = true;
      index += 2;
      continue;
    }
    index += 1;
  }
  return (inComment || state.inBlockComment) && emDashPair.test(line);
}

async function collectFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) files.push(...(await collectFiles(resolve(directory, entry.name))));
      } else if (entry.isFile()) {
        files.push(resolve(directory, entry.name));
      }
    })
  );
  return files;
}

function pathFrom(root, path) {
  return relative(root, path).split(sep).join("/");
}

function hasModuleHeader(source) {
  const lines = source.split(/\r?\n/u);
  if (singleLineModuleHeader.test(lines[0] ?? "")) return true;
  if (lines[0] !== "/**") return false;
  const closingLine = lines.indexOf(" */", 1);
  if (closingLine < 2) return false;
  const body = lines.slice(1, closingLine);
  return body.every((line) => expandedModuleHeaderLine.test(line)) && body.some((line) => /^ \* \S/u.test(line));
}

async function invalidSectionBanners(root) {
  const files = (await collectFiles(root)).filter((path) => bannerExtensions.has(extname(path)));
  const invalid = [];
  await Promise.all(
    files.map(async (path) => {
      const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
      const state = { inBlockComment: false, inTemplate: false };
      lines.forEach((line, index) => {
        if (commentCarryingEmDash(line, state) && !banner.test(line)) {
          invalid.push(`${pathFrom(root, path)}:${index + 1}: ${line}`);
        }
      });
    })
  );
  return invalid.sort();
}

async function moduleHeaderFindings(sourceRoot, pathRoot, allowlist) {
  const sourceFiles = (await collectFiles(sourceRoot))
    .filter((path) => productionExtension.test(path) && !testModule.test(path))
    .sort();
  const filesByPath = new Map(sourceFiles.map((path) => [pathFrom(pathRoot, path), path]));
  const nowCovered = [];
  const newlyMissing = [];
  for (const path of allowlist) {
    const absolutePath = filesByPath.get(path);
    if (absolutePath === undefined) {
      nowCovered.push(`${path} no longer names a production source file`);
      continue;
    }
    if (hasModuleHeader(await readFile(absolutePath, "utf8"))) {
      nowCovered.push(`${path} now has a header; remove it from the allowlist`);
    }
  }
  for (const [path, absolutePath] of filesByPath) {
    if (allowlist.has(path)) continue;
    if (!hasModuleHeader(await readFile(absolutePath, "utf8"))) {
      newlyMissing.push(`${path} needs a line-1 module header`);
    }
  }

  return { newlyMissing: newlyMissing.sort(), nowCovered: nowCovered.sort() };
}

// The allowlist may only SHRINK. A size cap alone permits a swap — one listed
// file gains a header while a brand-new headerless module takes its slot — so
// membership is compared against a committed baseline. Removing an entry needs
// no ceremony; adding one requires editing the baseline too, where a reviewer
// sees it. A rename is the same deliberate act.
function assertAllowlistPolicy(entries, baselineEntries) {
  const allowlist = new Set(entries);
  const baseline = new Set(baselineEntries);
  assert.equal(allowlist.size, entries.length, "module-header allowlist contains duplicate paths");
  assert.deepEqual(entries, [...entries].sort(), "module-header allowlist must stay sorted");
  assert.ok(
    entries.length <= baseline.size,
    `module-header allowlist may only shrink from its recorded baseline of ${baseline.size} entries`
  );
  const added = entries.filter((path) => !baseline.has(path));
  assert.deepEqual(
    added,
    [],
    "module-header allowlist gained entries absent from tests/tooling/module-header-baseline.txt; a new module must carry a header"
  );
  return allowlist;
}

function baselineEntriesFor(count) {
  return Array.from({ length: count }, (_, index) => `src/generated/module-${index}.ts`);
}

async function createFixture(t, path, source) {
  const root = await mkdtemp(resolve(tmpdir(), "nexus-code-style-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const absolutePath = resolve(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
  return root;
}

test("section banners use the foldable form at column zero", async () => {
  assert.deepEqual(
    await invalidSectionBanners(repositoryRoot),
    [],
    "section banners must match /* —— Section —— */ at column zero"
  );
});

test("banner candidate coverage uses temporary fixtures", async (t) => {
  const emDashPair = "\u2014\u2014";
  const invalidVariants = [
    ["doc-comment opener", `/** ${emDashPair} Imports ${emDashPair} */\n`],
    ["missing spaces", `/*${emDashPair} Imports ${emDashPair}*/\n`],
    ["line-comment form", `// ${emDashPair} Imports ${emDashPair}\n`],
    ["indented form", `  /* ${emDashPair} Imports ${emDashPair} */\n`],
    ["marker split across a block comment", `/**\n * ${emDashPair} Imports ${emDashPair}\n */\n`],
  ];
  for (const [name, source] of invalidVariants) {
    await t.test(`rejects ${name}`, async (t) => {
      const root = await createFixture(t, "fixture.ts", source);
      assert.equal((await invalidSectionBanners(root)).length, 1);
    });
  }

  await t.test("ignores a banner quoted inside a string literal", async (t) => {
    const root = await createFixture(t, "fixture.ts", `const message = "/* ${emDashPair} Imports ${emDashPair} */";\n`);
    assert.deepEqual(await invalidSectionBanners(root), []);
  });

  await t.test("ignores a banner quoted inside a template literal", async (t) => {
    const root = await createFixture(
      t,
      "fixture.ts",
      `const message = \`/* ${emDashPair} Imports ${emDashPair} */\`;\n`
    );
    assert.deepEqual(await invalidSectionBanners(root), []);
  });

  await t.test("ignores an em-dash pair outside a comment", async (t) => {
    const root = await createFixture(t, "fixture.ts", `const label = "${emDashPair} not a banner ${emDashPair}";\n`);
    assert.deepEqual(await invalidSectionBanners(root), []);
  });

  await t.test("accepts ASCII hyphens as ordinary prose", async (t) => {
    const root = await createFixture(t, "fixture.ts", "/* -- Imports -- */\n");
    assert.deepEqual(await invalidSectionBanners(root), []);
  });

  await t.test("accepts en dashes as ordinary prose", async (t) => {
    const enDashPair = "\u2013\u2013";
    const root = await createFixture(t, "fixture.ts", `/* ${enDashPair} Imports ${enDashPair} */\n`);
    assert.deepEqual(await invalidSectionBanners(root), []);
  });
});

test("banner scan excludes Markdown and .superpowers", async (t) => {
  const emDashPair = "\u2014\u2014";
  await t.test("does not scan Markdown", async (t) => {
    const root = await createFixture(t, "notes.md", `// ${emDashPair} Notes ${emDashPair}\n`);
    assert.deepEqual(await invalidSectionBanners(root), []);
  });
  await t.test("does not scan .superpowers", async (t) => {
    const root = await createFixture(t, ".superpowers/fixture.ts", `// ${emDashPair} Notes ${emDashPair}\n`);
    assert.deepEqual(await invalidSectionBanners(root), []);
  });
});

test("module headers accept compact and expanded line-1 forms", async (t) => {
  const validHeaders = [
    ["compact header", "/** Owns this temporary module. */\nexport {};\n"],
    [
      "expanded header",
      "/**\n * Owns this temporary module.\n *\n * The expanded form records a constraint the code cannot show.\n */\nexport {};\n",
    ],
  ];
  for (const [name, source] of validHeaders) {
    await t.test(name, async (t) => {
      const root = await createFixture(t, "src/fixture.ts", source);
      const findings = await moduleHeaderFindings(resolve(root, "src"), root, new Set());
      assert.deepEqual(findings, { newlyMissing: [], nowCovered: [] });
    });
  }
});

test("module headers cannot be bypassed", async (t) => {
  const invalidHeaders = [
    ["empty doc comment", "src/empty.ts", "/** */\nexport {};\n"],
    ["header on line 2", "src/line-two.ts", "\n/** Owns this temporary module. */\nexport {};\n"],
    ["missing declaration-file header", "src/types.d.ts", "export interface Fixture {}\n"],
  ];
  for (const [name, path, source] of invalidHeaders) {
    await t.test(name, async (t) => {
      const root = await createFixture(t, path, source);
      const findings = await moduleHeaderFindings(resolve(root, "src"), root, new Set());
      assert.equal(findings.newlyMissing.length, 1);
    });
  }
});

test("module-header allowlist cannot swap in a new module at the same size", () => {
  // The bypass this closes: one grandfathered file gains a header and a brand-new
  // headerless module takes its slot, leaving the count unchanged.
  const baseline = ["src/a.ts", "src/b.ts"];
  const swapped = ["src/a.ts", "src/brand-new.ts"];
  assert.throws(
    () => assertAllowlistPolicy(swapped, baseline),
    /gained entries absent from tests\/tooling\/module-header-baseline\.txt/u
  );
  assert.doesNotThrow(() => assertAllowlistPolicy(["src/a.ts"], baseline), "removing an entry must stay free");
});

test("module-header allowlist cannot grow past its recorded baseline", () => {
  const grownAllowlist = Array.from(
    { length: moduleHeaderAllowlistBaseline + 1 },
    (_, index) => `src/fixture-${String(index).padStart(3, "0")}.ts`
  );
  assert.throws(
    () => assertAllowlistPolicy(grownAllowlist, baselineEntriesFor(grownAllowlist.length - 1)),
    /may only shrink from its recorded baseline/u
  );
});

test("every module-header allowlist entry must still lack a header", async (t) => {
  const root = await createFixture(t, "src/covered.ts", "/** Owns this temporary module. */\nexport {};\n");
  const findings = await moduleHeaderFindings(resolve(root, "src"), root, new Set(["src/covered.ts"]));
  assert.deepEqual(findings.nowCovered, ["src/covered.ts now has a header; remove it from the allowlist"]);
});

test("production module headers match the shrinking allowlist", async () => {
  const sourceRoot = resolve(repositoryRoot, "src");
  const allowlistText = await readFile(resolve(testDirectory, "module-header-allowlist.txt"), "utf8");
  const allowlistEntries = allowlistText.split(/\r?\n/u).filter(Boolean);
  const baselineText = await readFile(resolve(testDirectory, "module-header-baseline.txt"), "utf8");
  const baselineEntries = baselineText.split("\n").filter((line) => line.length > 0);
  const allowlist = assertAllowlistPolicy(allowlistEntries, baselineEntries);
  const { newlyMissing, nowCovered } = await moduleHeaderFindings(sourceRoot, repositoryRoot, allowlist);

  assert.deepEqual(nowCovered, [], "every module-header allowlist entry must still lack a header");
  assert.deepEqual(newlyMissing, [], "new production modules must add a header, not grow the allowlist");
});
