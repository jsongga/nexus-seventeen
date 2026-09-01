import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const taskBoardRoot = resolve(repositoryRoot, "src/server/task-board");
const contractValidateRoot = resolve(repositoryRoot, "src/shared/task-board-contract/validate");
const moduleExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

async function collectModules(directory) {
  const modules = [];
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) modules.push(...(await collectModules(path)));
      else if (entry.isFile() && moduleExtensions.has(extname(path))) modules.push(path);
    })
  );
  return modules.sort();
}

function moduleSpecifiers(path, source) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const visit = (node) => {
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      // `import(specifier, { with: … })` is the two-argument form; the edge is
      // in the first argument either way.
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifier = node.argument.literal.text;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifier = node.moduleReference.expression.text;
    } else if (
      // The walker scans .cjs/.cts modules and resolves .cjs onto .cts, so it
      // must read CommonJS's own import form rather than claiming coverage it
      // does not have. Only a literal argument is knowable statically.
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    // A subpath import is not a relative one, but `#server/task-board/*` names
    // the same files: taking only relative specifiers would leave the rule
    // trivially evadable by the repository's own idiomatic import style.
    if (specifier !== undefined && (specifier.startsWith(".") || specifier.startsWith("#"))) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/**
 * Maps the `imports` map's emitted targets back onto their sources: the map
 * points at build output, and the layer a module belongs to is a fact about the
 * source tree.
 */
async function readSubpathImports(packageRoot, emitDirectory, sourceDirectory) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return Object.entries(manifest.imports ?? {}).map(([pattern, target]) => ({
    pattern,
    target: String(target).replace(new RegExp(`^\\./${emitDirectory}/`, "u"), `./${sourceDirectory}/`),
  }));
}

function applySubpathImport(subpathImports, packageRoot, specifier) {
  for (const { pattern, target } of subpathImports) {
    if (!pattern.includes("*")) {
      if (pattern === specifier) return resolve(packageRoot, target);
      continue;
    }
    const [prefix, suffix] = pattern.split("*");
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
      return resolve(packageRoot, target.replace("*", middle));
    }
  }
  return null;
}

function resolutionCandidates(target) {
  const extension = extname(target);
  const swap = (dropped, replacements) => [
    ...replacements.map((suffix) => target.slice(0, -dropped.length) + suffix),
    target,
  ];
  // A `.js` specifier may name a `.ts`, `.tsx`, `.mts`, `.cts` or `.d.ts` source.
  if (extension === ".js") return swap(".js", [".ts", ".tsx", ".mts", ".cts", ".d.ts"]);
  if (extension === ".jsx") return swap(".jsx", [".tsx", ".d.ts"]);
  if (extension === ".mjs") return swap(".mjs", [".mts", ".d.mts"]);
  if (extension === ".cjs") return swap(".cjs", [".cts", ".d.cts"]);
  const suffixes = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
  return [
    target,
    // A dotted basename (`./a.b` for `a.b.ts`) has a non-empty extension but is
    // still extensionless as far as module resolution is concerned.
    ...suffixes.map((suffix) => target + suffix),
    ...suffixes.map((suffix) => resolve(target, `index${suffix}`)),
  ];
}

async function resolveSpecifier(importer, specifier, context) {
  // A query or hash suffix is not part of the path on disk. The first character
  // is never a suffix — a subpath import opens with `#`.
  const bare = specifier.slice(0, 1) + specifier.slice(1).replace(/[?#].*$/u, "");
  const target = bare.startsWith(".")
    ? resolve(dirname(importer), bare)
    : applySubpathImport(context.subpathImports, context.packageRoot, bare);
  if (target === null) return null;
  for (const candidate of resolutionCandidates(target)) {
    try {
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR" && error?.code !== "ENAMETOOLONG") throw error;
    }
  }
  return null;
}

function pathFrom(root, path) {
  return relative(root, path).split(sep).join("/");
}

function within(root, path) {
  const pathWithinRoot = relative(root, path);
  return pathWithinRoot !== "" && !isAbsolute(pathWithinRoot) && !pathWithinRoot.startsWith(`..${sep}`);
}

function pathLayer(root, path) {
  if (!within(root, path)) return null;
  const [first, second] = relative(root, path).split(sep);
  return second === undefined ? "root" : first;
}

/**
 * Reports every module under `<root>/persistence` that reaches
 * `<root>/collaborators`, directly or through any chain of source modules —
 * including modules outside the root, which is where a laundering re-export
 * would naturally live.
 */
/**
 * Reports an import cycle for each back edge reachable from the modules directly
 * under `root` — enough to prove none exists, which is what the callers assert.
 * A façade split into modules that import each other in a loop has moved the
 * tangle rather than removed it, and a loop that leaves the directory and comes
 * back is still a loop, so the walk follows edges out of `root` too.
 */
export async function findModuleCycles(root, options = {}) {
  const packageRoot = await realpath(options.packageRoot ?? repositoryRoot);
  const emitDirectory = options.emitDirectory ?? "build";
  const sourceDirectory = options.sourceDirectory ?? "src";
  const context = {
    packageRoot,
    subpathImports: await readSubpathImports(packageRoot, emitDirectory, sourceDirectory),
  };
  const searchRoot = await realpath(options.searchRoot ?? resolve(packageRoot, sourceDirectory));
  const resolvedRoot = await realpath(root);
  const modules = new Set(await collectModules(resolvedRoot));

  // Parsed on demand and bounded by `searchRoot`, so a loop that leaves the
  // directory and returns is followed rather than dropped at the boundary.
  const edges = new Map();
  const edgesFor = async (path) => {
    const cached = edges.get(path);
    if (cached !== undefined) return cached;
    const targets = [];
    edges.set(path, targets);
    for (const specifier of moduleSpecifiers(path, await readFile(path, "utf8"))) {
      const target = await resolveSpecifier(path, specifier, context);
      if (target !== null && within(searchRoot, target)) targets.push(target);
    }
    return targets;
  };

  const cycles = [];
  const state = new Map();
  const stack = [];
  const walk = async (path) => {
    state.set(path, "open");
    stack.push(path);
    for (const target of await edgesFor(path)) {
      if (state.get(target) === "open") {
        const loop = [...stack.slice(stack.indexOf(target)), target];
        // A cycle living entirely outside the directory under review is real,
        // but it is not this check's business.
        if (loop.some((p) => modules.has(p))) cycles.push(loop.map((p) => pathFrom(resolvedRoot, p)).join(" -> "));
      } else if (state.get(target) === undefined) await walk(target);
    }
    stack.pop();
    state.set(path, "closed");
  };
  for (const modulePath of modules) if (state.get(modulePath) === undefined) await walk(modulePath);
  return { moduleCount: modules.size, cycles: [...new Set(cycles)].sort() };
}

export async function checkTaskBoardLayerDirection(root, options = {}) {
  const packageRoot = await realpath(options.packageRoot ?? repositoryRoot);
  const emitDirectory = options.emitDirectory ?? "build";
  const sourceDirectory = options.sourceDirectory ?? "src";
  const searchRoot = await realpath(options.searchRoot ?? resolve(packageRoot, sourceDirectory));
  const context = {
    packageRoot,
    subpathImports: await readSubpathImports(packageRoot, emitDirectory, sourceDirectory),
  };

  const resolvedRoot = await realpath(root);
  const graph = new Map();
  const unresolved = [];
  let edgeCount = 0;
  let persistenceToCollaboratorsEdgeCount = 0;

  // Parsed on demand so the transitive walk can leave the task-board root and
  // keep going; bounded by `searchRoot` so it never wanders into node_modules.
  const edgesFor = async (path) => {
    const cached = graph.get(path);
    if (cached !== undefined) return cached;
    const edges = [];
    graph.set(path, edges);
    const source = await readFile(path, "utf8");
    for (const specifier of moduleSpecifiers(path, source)) {
      const target = await resolveSpecifier(path, specifier, context);
      if (target === null) {
        unresolved.push({ file: pathFrom(searchRoot, path), specifier });
        continue;
      }
      edges.push({ specifier, target });
    }
    return edges;
  };

  for (const modulePath of await collectModules(resolvedRoot)) {
    const importer = await realpath(modulePath);
    for (const edge of await edgesFor(importer)) {
      const importerLayer = pathLayer(resolvedRoot, importer);
      const targetLayer = pathLayer(resolvedRoot, edge.target);
      if (importerLayer !== null && targetLayer !== null && importerLayer !== targetLayer) edgeCount += 1;
      if (importerLayer === "persistence" && targetLayer === "collaborators") persistenceToCollaboratorsEdgeCount += 1;
    }
  }

  const collaboratorReachedFrom = async (path, visited) => {
    if (pathLayer(resolvedRoot, path) === "collaborators") return path;
    if (visited.has(path) || !within(searchRoot, path)) return null;
    visited.add(path);
    for (const edge of await edgesFor(path)) {
      const collaborator = await collaboratorReachedFrom(edge.target, visited);
      if (collaborator !== null) return collaborator;
    }
    return null;
  };

  const violations = [];
  for (const [importer, edges] of [...graph]) {
    if (pathLayer(resolvedRoot, importer) !== "persistence") continue;
    for (const edge of edges) {
      const collaborator = await collaboratorReachedFrom(edge.target, new Set());
      if (collaborator === null) continue;
      violations.push({
        file: pathFrom(resolvedRoot, importer),
        specifier: edge.specifier,
        collaborator: pathFrom(resolvedRoot, collaborator),
      });
    }
  }

  const key = (v) => `${v.file}\0${v.specifier}\0${v.collaborator ?? ""}`;
  return {
    edgeCount,
    persistenceToCollaboratorsEdgeCount,
    unresolved: unresolved.sort((a, b) => key(a).localeCompare(key(b))),
    violations: violations.sort((a, b) => key(a).localeCompare(key(b))),
  };
}

function assertLayerDirection(result) {
  const details = result.violations
    .map(
      ({ file, specifier, collaborator }) => `${file} imports ${JSON.stringify(specifier)} (reaches ${collaborator})`
    )
    .join("\n");
  assert.deepEqual(
    result.violations,
    [],
    `persistence modules must not import collaborators${details === "" ? "" : `:\n${details}`}`
  );
}

async function createFixture(t, files) {
  const root = await mkdtemp(resolve(tmpdir(), "nexus-layer-direction-"));
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

// The fixture mirrors the repository's own shape: a package.json whose imports
// map points at build output, and sources under src/.
function fixtureOptions(root) {
  return { packageRoot: root, emitDirectory: "build", sourceDirectory: "src" };
}

const FIXTURE_MANIFEST = JSON.stringify({ imports: { "#app/*": "./build/*.js" } });

test("task-board persistence does not import collaborators", async () => {
  const result = await checkTaskBoardLayerDirection(taskBoardRoot);
  // A walker with a broken glob would otherwise pass forever by examining
  // nothing. The real figure is ~104; the floor only has to exclude collapse.
  assert.ok(result.edgeCount > 50, `layer checker examined only ${result.edgeCount} cross-layer edges`);
  assert.deepEqual(result.unresolved, [], "every specifier under the task-board tree must resolve to a real file");
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 0);
  assertLayerDirection(result);
});

test("no layer directory is nested inside another layer", async () => {
  const nested = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(directory, entry.name);
      // Depth 1 is the layer itself; the same name deeper is a way to file
      // collaborator code inside persistence without tripping the rule.
      if (directory !== taskBoardRoot && (entry.name === "collaborators" || entry.name === "persistence")) {
        nested.push(pathFrom(taskBoardRoot, path));
      }
      await walk(path);
    }
  };
  await walk(taskBoardRoot);
  assert.deepEqual(nested, [], "a layer directory nested inside another layer defeats the direction rule");
});

test("the contract's validation modules import each other acyclically", async () => {
  const result = await findModuleCycles(contractValidateRoot);
  assert.ok(result.moduleCount >= 6, `expected the split validation modules, found ${result.moduleCount}`);
  assert.deepEqual(result.cycles, [], "validate/ modules must not import each other in a loop");
});

test("the cycle finder reports a planted loop", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/a.ts": 'export { b } from "./b.js";\n',
    "src/b.ts": 'export { c } from "./c.js";\nexport const b = 1;\n',
    "src/c.ts": 'export { b } from "./a.js";\nexport const c = 1;\n',
    "src/loner.ts": "export const loner = 1;\n",
  });
  const result = await findModuleCycles(resolve(root, "src"), fixtureOptions(root));
  assert.equal(result.moduleCount, 4);
  assert.deepEqual(result.cycles, ["a.ts -> b.ts -> c.ts -> a.ts"]);
});

test("the cycle finder follows a loop that leaves the directory and returns", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/inner/a.ts": 'export { b } from "./b.js";\n',
    "src/inner/b.ts": 'export { a } from "../outside.js";\nexport const b = 1;\n',
    "src/outside.ts": 'export { a } from "./inner/a.js";\nexport const a = 1;\n',
  });
  const result = await findModuleCycles(resolve(root, "src/inner"), fixtureOptions(root));
  assert.equal(result.moduleCount, 2);
  assert.deepEqual(result.cycles, ["a.ts -> b.ts -> ../outside.ts -> a.ts"]);
});

test("layer checker reports every planted violation by file and specifier", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/collaborators/y.ts": "export const y = 1;\n",
    "src/persistence/x.ts": 'import { y } from "../collaborators/y.js";\nexport { y };\n',
    "src/persistence/z.ts": 'export { y } from "../collaborators/y.js";\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  assert.deepEqual(
    result.violations.map(({ file, specifier }) => ({ file, specifier })),
    [
      { file: "persistence/x.ts", specifier: "../collaborators/y.js" },
      { file: "persistence/z.ts", specifier: "../collaborators/y.js" },
    ]
  );
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 2);
  assert.throws(
    () => assertLayerDirection(result),
    (error) => {
      assert.match(error.message, /persistence\/x\.ts imports "\.\.\/collaborators\/y\.js"/u);
      assert.match(error.message, /persistence\/z\.ts imports "\.\.\/collaborators\/y\.js"/u);
      return true;
    }
  );
});

test("layer checker accepts collaborators importing persistence", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/collaborators/x.ts":
      '// import { forbidden } from "../collaborators/comment-only.js";\nimport { y } from "../persistence/y.js";\nexport { y };\n',
    "src/persistence/y.ts": "export const y = 1;\n",
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  assert.equal(result.edgeCount, 1);
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 0);
  assertLayerDirection(result);
});

test("layer checker resolves extensionless files, index files, and re-export paths", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/bridge.ts": 'export { y } from "./collaborators";\n',
    "src/collaborators/index.ts": 'export { y } from "./y.js";\n',
    "src/collaborators/y.ts": "export const y = 1;\n",
    "src/persistence/x.ts": 'import { y } from "../bridge";\nexport { y };\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 0, "the planted back-edge is laundered through root");
  assert.deepEqual(result.violations, [
    { file: "persistence/x.ts", specifier: "../bridge", collaborator: "collaborators/index.ts" },
  ]);
});

test("a subpath import is a back-edge like any other", async (t) => {
  // The repository imports its own modules through `#server/task-board/*`, so a
  // checker that only followed relative specifiers could be evaded in the
  // repository's own idiomatic style.
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/collaborators/y.ts": "export const y = 1;\n",
    "src/persistence/x.ts": 'import { y } from "#app/collaborators/y";\nexport { y };\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 1);
  assert.deepEqual(result.violations, [
    { file: "persistence/x.ts", specifier: "#app/collaborators/y", collaborator: "collaborators/y.ts" },
  ]);
});

test("laundering through a module outside the layered tree is still a back-edge", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/shared/launder.ts": 'export { y } from "../board/collaborators/y.js";\n',
    "src/board/collaborators/y.ts": "export const y = 1;\n",
    "src/board/persistence/x.ts": 'import { y } from "../../shared/launder.js";\nexport { y };\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src/board"), fixtureOptions(root));
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 0, "the back-edge leaves the tree before returning");
  assert.deepEqual(result.violations, [
    { file: "persistence/x.ts", specifier: "../../shared/launder.js", collaborator: "collaborators/y.ts" },
  ]);
});

test("an unresolvable specifier is reported, not thrown", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/persistence/x.ts": 'import { y } from "./gone.js";\nexport { y };\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  // A deleted module must not turn the layering test into a crash that hides
  // whatever it was actually asked to check.
  assert.deepEqual(result.unresolved, [{ file: "persistence/x.ts", specifier: "./gone.js" }]);
  assert.deepEqual(result.violations, []);
});

test("a dynamic import carrying options is still an edge", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/collaborators/y.ts": "export const y = 1;\n",
    "src/persistence/x.ts": 'export const load = () => import("../collaborators/y.js", { with: { type: "json" } });\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 1);
  assert.deepEqual(result.violations, [
    { file: "persistence/x.ts", specifier: "../collaborators/y.js", collaborator: "collaborators/y.ts" },
  ]);
});

test("a literal require is an edge like any other", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/collaborators/y.cts": "export const y = 1;\n",
    "src/persistence/x.cts": 'const { y } = require("../collaborators/y.cjs");\nmodule.exports = { y };\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  assert.equal(result.persistenceToCollaboratorsEdgeCount, 1);
  assert.deepEqual(result.violations, [
    { file: "persistence/x.cts", specifier: "../collaborators/y.cjs", collaborator: "collaborators/y.cts" },
  ]);
});

test("declaration files, dotted basenames and query suffixes resolve", async (t) => {
  const root = await createFixture(t, {
    "package.json": FIXTURE_MANIFEST,
    "src/collaborators/ambient.d.ts": "export declare const y: number;\n",
    "src/collaborators/a.b.ts": "export const b = 1;\n",
    "src/collaborators/q.ts": "export const q = 1;\n",
    "src/persistence/x.ts":
      'import type { y } from "../collaborators/ambient.js";\nimport { b } from "../collaborators/a.b";\nimport { q } from "../collaborators/q.js?raw";\nexport { y, b, q };\n',
  });
  const result = await checkTaskBoardLayerDirection(resolve(root, "src"), fixtureOptions(root));
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(
    result.violations.map(({ specifier }) => specifier),
    ["../collaborators/a.b", "../collaborators/ambient.js", "../collaborators/q.js?raw"]
  );
});
