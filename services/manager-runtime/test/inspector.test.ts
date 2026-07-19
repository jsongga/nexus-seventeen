import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FrozenEvidenceFileInspector } from "../src/inspector.js";
import { EVIDENCE_ID, evidence, inspection, reviewTask, tempRoot } from "./helpers.js";

test("reads only the exact frozen evidence bundle without changing it", async () => {
  const root = await tempRoot();
  const directory = join(root, "evidence");
  await mkdir(directory);
  const path = join(directory, `${EVIDENCE_ID}.review.json`);
  const expected = inspection("accepted");
  const bytes = `${JSON.stringify({ version: 1, evidenceId: EVIDENCE_ID, ...expected })}\n`;
  await writeFile(path, bytes, { mode: 0o444 });
  await chmod(path, 0o444);
  const inspector = new FrozenEvidenceFileInspector({ evidenceDirectory: directory });

  const result = await inspector.inspect({ task: reviewTask(), evidence: evidence(), iteration: 1 });

  assert.deepEqual(result, expected);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal((await stat(path)).mode & 0o777, 0o444);
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(inspector)).sort(), ["constructor", "inspect"]);
});

test("refuses symlinked evidence instead of following it", async () => {
  const root = await tempRoot();
  const directory = join(root, "evidence");
  await mkdir(directory);
  const linkedId = "33333333-3333-4333-8333-333333333333";
  const target = join(root, "outside.json");
  await writeFile(target, JSON.stringify({ version: 1, evidenceId: linkedId, ...inspection("accepted") }));
  await symlink(target, join(directory, `${linkedId}.review.json`));
  const inspector = new FrozenEvidenceFileInspector({ evidenceDirectory: directory });

  await assert.rejects(
    inspector.inspect({
      task: reviewTask(),
      evidence: evidence({ evidenceId: linkedId }),
      iteration: 1,
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP",
  );
});
