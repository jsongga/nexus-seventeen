/**
 * Proves a file split moved code rather than rewrote it: every top-level
 * declaration in the original must appear exactly once across the new files,
 * byte-identical apart from an `export ` a sibling module now needs.
 *
 *   node scripts/verify-declaration-identity.mjs <original-path> <new-path>...
 *
 * The original is read from HEAD, so run it against a dirty worktree before
 * committing. Written for campaign 12's validate.ts split and reused by 13.
 */
// Every top-level declaration in the original must appear exactly once across
// the new files, with its text unchanged apart from an added `export `.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [originalPath, ...afterPaths] = process.argv.slice(2);

function declarations(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out = new Map();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
    const names = [];
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    } else if (st.name) names.push(st.name.text);
    if (names.length === 0) continue;
    const key = names.join(",");
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ path, body: text.slice(st.getStart(sf), st.end) });
  }
  return out;
}

const original = execFileSync("git", ["show", `HEAD:${originalPath}`], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const before = declarations(originalPath, original);
const after = new Map();
for (const path of afterPaths) {
  for (const [key, entries] of declarations(path, readFileSync(path, "utf8"))) {
    if (!after.has(key)) after.set(key, []);
    after.get(key).push(...entries);
  }
}
const missing = [...before.keys()].filter((k) => !after.has(k));
const added = [...after.keys()].filter((k) => !before.has(k));
const duplicated = [...after].filter(([k, v]) => v.length !== (before.get(k) ?? []).length).map(([k]) => k);
const changed = [];
const promoted = new Set();
for (const [key, entries] of before) {
  const now = after.get(key);
  if (now === undefined || now.length !== entries.length) continue;
  for (let i = 0; i < entries.length; i += 1) {
    if (now[i].body === entries[i].body) continue;
    if (now[i].body === `export ${entries[i].body}`) {
      promoted.add(key);
      continue;
    }
    changed.push(`${key} in ${now[i].path}`);
  }
}
console.log(`declarations before ${[...before.values()].flat().length}  after ${[...after.values()].flat().length}`);
console.log(`missing        : ${missing.join(", ") || "(none)"}`);
console.log(`invented       : ${added.join(", ") || "(none)"}`);
console.log(`count mismatch : ${duplicated.join(", ") || "(none)"}`);
console.log(`text changed   : ${changed.join(", ") || "(none)"}`);
console.log(`export-promoted: ${[...promoted].sort().join(", ") || "(none)"}`);
