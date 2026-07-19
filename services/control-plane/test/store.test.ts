import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { JsonlEventStore, type EventDraft } from '../src/store.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function tempStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'steward-store-'));
  cleanup.push(directory);
  return join(directory, 'events.jsonl');
}

const firstEvent: EventDraft = {
  eventId: 'evt-1',
  idempotencyKey: 'idem-1',
  kind: 'lane.registered',
  laneId: 'lane-1',
  actor: 'supervisor',
  data: { epoch: 1, supervisorId: 'runtime-a' },
};

test('committed records survive restart with contiguous server sequence', async () => {
  const path = await tempStorePath();
  const timestamps = [new Date('2026-07-18T20:00:00.000Z'), new Date('2026-07-18T20:00:01.000Z')];
  const store = await JsonlEventStore.open({
    path,
    workspaceId: 'workspace-alpha',
    now: () => timestamps.shift() ?? new Date('2026-07-18T20:00:02.000Z'),
  });
  const secondEvent: EventDraft = {
    eventId: 'evt-2',
    kind: 'lane.lease_renewed',
    laneId: 'lane-1',
    actor: 'supervisor',
    data: { epoch: 1 },
  };
  await store.append([firstEvent, secondEvent]);
  await store.close();

  const reopened = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  assert.deepEqual(
    reopened.records.map((event) => [event.workspaceSequence, event.eventId, event.occurredAt]),
    [
      [1, 'evt-1', '2026-07-18T20:00:00.000Z'],
      [2, 'evt-2', '2026-07-18T20:00:01.000Z'],
    ],
  );
  await reopened.close();
});

test('startup rolls back a newline-complete prefix of an atomic batch', async () => {
  const path = await tempStorePath();
  const store = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  const secondEvent: EventDraft = {
    eventId: 'evt-2',
    kind: 'lane.lease_renewed',
    laneId: 'lane-1',
    actor: 'supervisor',
    data: { epoch: 1 },
  };
  await store.append([firstEvent, secondEvent]);
  await store.close();

  const completeLines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  assert.equal(completeLines.length, 2);
  const firstLine = completeLines[0];
  assert.ok(firstLine);
  assert.equal((JSON.parse(firstLine) as { batchSize?: unknown }).batchSize, 2);
  await writeFile(path, `${firstLine}\n`);

  const recovered = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  assert.deepEqual(recovered.records, []);
  assert.equal(await readFile(path, 'utf8'), '');

  const [next] = await recovered.append([
    {
      eventId: 'evt-after-recovery',
      kind: 'workspace.paused',
      actor: 'human',
      data: { reason: 'safe follow-up' },
    },
  ]);
  assert.equal(next?.event.workspaceSequence, 1);
  await recovered.close();

  const reopened = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  assert.deepEqual(
    reopened.records.map((event) => [event.workspaceSequence, event.eventId]),
    [[1, 'evt-after-recovery']],
  );
  await reopened.close();
});

test(
  'store creates and tightens the event file to owner-only access',
  { skip: process.platform === 'win32' },
  async () => {
    const path = await tempStorePath();
    await writeFile(path, '');
    await chmod(path, 0o666);

    const store = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await store.close();
  },
);

test(
  'store does not change permissions on a caller-owned parent directory',
  { skip: process.platform === 'win32' },
  async () => {
    const path = await tempStorePath();
    const directory = dirname(path);
    await chmod(directory, 0o755);

    const store = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await store.close();
  },
);

test('an exclusive writer lock prevents two control planes from corrupting one store', async () => {
  const path = await tempStorePath();
  const first = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  await assert.rejects(
    JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === 'STORE_ALREADY_LOCKED',
  );
  await first.close();

  const afterRelease = await JsonlEventStore.open({
    path,
    workspaceId: 'workspace-alpha',
  });
  await afterRelease.close();
});

test('identical retries deduplicate and conflicting identifier reuse is rejected', async () => {
  const path = await tempStorePath();
  const store = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  const [created] = await store.append([firstEvent]);
  const [retried] = await store.append([{ ...firstEvent }]);

  assert.equal(created?.duplicate, false);
  assert.equal(retried?.duplicate, true);
  assert.equal(retried?.event.workspaceSequence, 1);
  assert.equal(store.records.length, 1);

  await assert.rejects(
    store.append([{ ...firstEvent, data: { epoch: 2, supervisorId: 'runtime-a' } }]),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === 'IDEMPOTENCY_CONFLICT',
  );
  await store.close();
});

test('startup truncates only an incomplete final line and continues safely', async () => {
  const path = await tempStorePath();
  const store = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  await store.append([firstEvent]);
  await store.close();
  await appendFile(path, '{"schemaVersion":1,"workspaceId":"workspace-alpha"');

  const reopened = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  assert.equal(reopened.records.length, 1);
  await reopened.append([
    {
      eventId: 'evt-2',
      kind: 'lane.lease_renewed',
      laneId: 'lane-1',
      actor: 'supervisor',
      data: { epoch: 1 },
    },
  ]);
  await reopened.close();

  const text = await readFile(path, 'utf8');
  assert.equal(text.trimEnd().split('\n').length, 2);
});

test('startup rejects corruption before the final line', async () => {
  const path = await tempStorePath();
  const store = await JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' });
  await store.append([firstEvent]);
  await store.close();
  const valid = await readFile(path, 'utf8');
  await writeFile(path, `${valid}{not-json}\n{"also":"ignored"`);

  await assert.rejects(
    JsonlEventStore.open({ path, workspaceId: 'workspace-alpha' }),
    /STORE_CORRUPT: invalid JSON at line 2/,
  );
});
