import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import test from "node:test";

const ignoredDirectories = new Set([".git", ".test-dist", "build", "dist", "node_modules", ".superpowers"]);
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".json", ".mjs", ".sh", ".ts", ".tsx", ".yaml", ".yml"]);
const contractPath = "src/shared/task-board-contract/index.ts";
const identifierCharacterClass = ["[A-Za-z0-9", "._:@/-]"].join("");

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await sourceFiles(join(directory, entry.name)));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

test("only the shared contract defines the canonical identifier character class", async () => {
  const root = process.cwd();
  const definitions: string[] = [];
  for (const path of await sourceFiles(root)) {
    if ((await readFile(path, "utf8")).includes(identifierCharacterClass)) {
      definitions.push(relative(root, path));
    }
  }
  assert.deepEqual(definitions.sort(), [contractPath]);
});
