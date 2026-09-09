/** Enforces shrinking line-count ceilings for production source files. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const baselinePath = resolve(testDirectory, "file-size-baseline.txt");
const testModule = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function pathFrom(root, path) {
  return relative(root, path).split(sep).join("/");
}

function parseBaseline(source) {
  const entries = source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = /^(src\/[^\t]+)\t(0|[1-9]\d*)$/u.exec(line);
      assert.ok(match, `invalid file-size baseline entry: ${line}`);
      const [, path, ceiling] = match;
      assert.equal(pathFrom(repositoryRoot, resolve(repositoryRoot, path)), path, `unsafe baseline path: ${path}`);
      assert.equal(testModule.test(path), false, `test modules must not be in the file-size baseline: ${path}`);
      return { path, ceiling: Number(ceiling) };
    });
  const paths = entries.map(({ path }) => path);
  assert.equal(new Set(paths).size, paths.length, "file-size baseline contains duplicate paths");
  assert.deepEqual(paths, [...paths].sort(), "file-size baseline must stay sorted");
  return entries;
}

function lineCount(source) {
  if (source.length === 0) return 0;
  const lineBreaks = source.match(/\r\n|[\n\r]/gu)?.length ?? 0;
  return lineBreaks + (/(?:\r\n|[\n\r])$/u.test(source) ? 0 : 1);
}

async function fileSizeFindings(root, baseline) {
  const grown = [];
  const stale = [];
  for (const { path, ceiling } of baseline) {
    let source;
    try {
      source = await readFile(resolve(root, path), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      stale.push(`${path} no longer exists; remove it from tests/tooling/file-size-baseline.txt`);
      continue;
    }
    const actual = lineCount(source);
    if (actual > ceiling) grown.push(`${path} grew from ${ceiling} to ${actual} lines`);
    if (actual < ceiling) {
      stale.push(`${path} shrank from ${ceiling} to ${actual} lines; update tests/tooling/file-size-baseline.txt`);
    }
  }
  return { grown: grown.sort(), stale: stale.sort() };
}

async function createFixture(t, files) {
  const root = await mkdtemp(resolve(tmpdir(), "nexus-file-size-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      const absolutePath = resolve(root, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, source, "utf8");
    })
  );
  return root;
}

test("file-size findings distinguish growth from a stale baseline", async (t) => {
  const root = await createFixture(t, {
    "src/grew.ts": "first\nsecond\n",
    "src/new.ts": "new files are unconstrained\n",
    "src/shrank.ts": "only one\n",
  });
  const baseline = [
    { path: "src/grew.ts", ceiling: 1 },
    { path: "src/missing.ts", ceiling: 1 },
    { path: "src/shrank.ts", ceiling: 2 },
  ];

  assert.deepEqual(await fileSizeFindings(root, baseline), {
    grown: ["src/grew.ts grew from 1 to 2 lines"],
    stale: [
      "src/missing.ts no longer exists; remove it from tests/tooling/file-size-baseline.txt",
      "src/shrank.ts shrank from 2 to 1 lines; update tests/tooling/file-size-baseline.txt",
    ],
  });
});

test("production source files match the shrinking line-count baseline", async () => {
  const baseline = parseBaseline(await readFile(baselinePath, "utf8"));
  const { grown, stale } = await fileSizeFindings(repositoryRoot, baseline);

  assert.deepEqual(grown, [], "tracked production source files may not grow past their recorded line counts");
  assert.deepEqual(
    stale,
    [],
    "the file-size baseline is stale after a shrink; update tests/tooling/file-size-baseline.txt"
  );
});
