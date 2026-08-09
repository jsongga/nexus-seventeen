import { writeFile } from 'node:fs/promises';
import { RESULT_SCHEMA } from '../build/server/agents/task-worker/contained-cli-launcher.js';

const output = new URL('../build/server/agents/task-worker/agent-result.schema.json', import.meta.url);
await writeFile(output, `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`, 'utf8');
