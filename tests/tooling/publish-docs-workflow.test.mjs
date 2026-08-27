import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../..');
const workflowPath = resolve(repositoryRoot, '.github/workflows/publish-docs.yml');

test('docs publishing stays guarded and receives its token from GitHub secrets', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.ok(workflow.includes("if: ${{ vars.DOCS_PUBLISH_ENABLED == 'true' }}"));
  assert.ok(workflow.includes('  group: docs-publish'));
  assert.ok(workflow.includes('  cancel-in-progress: true'));
  assert.ok(
    workflow.includes(
      'STEWARD_OUTLINE_API_TOKEN: ${{ secrets.STEWARD_OUTLINE_API_TOKEN }}',
    ),
  );
});
