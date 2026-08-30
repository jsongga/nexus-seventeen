import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTaskBoardService } from "#server/task-board";
import { AGENT_ONE_TOKEN, HUMAN_TOKEN, databasePath } from "./helpers.js";

const NOW = "2026-08-21T16:00:00.000Z";

function request(
  origin: string,
  path: string,
  method: "GET" | "POST",
  token: string,
  body?: unknown
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function seedNotifications(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(`
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, 'park_aged', NULL, NULL, NULL, ?, ?, ?, 1)
    `);
    for (let sequence = 1; sequence <= 154; sequence += 1) {
      const createdAt = new Date(Date.parse("2026-08-20T00:00:00.000Z") + sequence * 1_000).toISOString();
      insert.run(
        `notification-${sequence}`,
        sequence,
        `Seeded notification ${sequence}`,
        createdAt,
        sequence <= 52 ? createdAt : null
      );
    }
  } finally {
    db.close();
  }
}

test("human notification endpoints bound lists and mark rows read with CAS", async () => {
  const path = await databasePath();
  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    reconcileIntervalSeconds: 0,
    now: () => new Date(NOW),
  });
  seedNotifications(path);
  const address = await service.start();
  try {
    assert.equal((await request(address.url, "/v1/notifications", "GET", AGENT_ONE_TOKEN)).status, 401);
    assert.equal((await request(address.url, "/v1/notifications?after=1", "GET", HUMAN_TOKEN)).status, 400);

    const listedResponse = await request(address.url, "/v1/notifications", "GET", HUMAN_TOKEN);
    assert.equal(listedResponse.status, 200);
    const listed = (await listedResponse.json()) as {
      unread: Array<{ notificationId: string; sequence: number; readAt: string | null; version: number }>;
      recentRead: Array<{ notificationId: string; sequence: number; readAt: string | null; version: number }>;
    };
    assert.equal(listed.unread.length, 100);
    assert.equal(listed.unread[0]?.sequence, 154);
    assert.equal(listed.unread.at(-1)?.sequence, 55);
    assert.equal(
      listed.unread.every((notification) => notification.readAt === null),
      true
    );
    assert.equal(listed.recentRead.length, 50);
    assert.equal(listed.recentRead[0]?.sequence, 52);
    assert.equal(listed.recentRead.at(-1)?.sequence, 3);
    assert.equal(
      listed.recentRead.every((notification) => notification.readAt !== null),
      true
    );

    const markedResponse = await request(address.url, "/v1/notifications/notification-154/read", "POST", HUMAN_TOKEN, {
      version: 1,
    });
    assert.equal(markedResponse.status, 200);
    const marked = (
      (await markedResponse.json()) as {
        notification: { notificationId: string; readAt: string | null; version: number };
      }
    ).notification;
    assert.equal(marked.notificationId, "notification-154");
    assert.equal(marked.readAt, NOW);
    assert.equal(marked.version, 2);

    const stale = await request(address.url, "/v1/notifications/notification-154/read", "POST", HUMAN_TOKEN, {
      version: 1,
    });
    assert.equal(stale.status, 409);

    const unknown = await request(address.url, "/v1/notifications/notification-unknown/read", "POST", HUMAN_TOKEN, {
      version: 1,
    });
    assert.equal(unknown.status, 404);
    assert.equal(
      ((await unknown.json()) as { error: { code: string } }).error.code,
      "TASK_BOARD_NOTIFICATION_NOT_FOUND"
    );
    assert.equal(
      (
        await request(address.url, "/v1/notifications/notification-153/read", "POST", HUMAN_TOKEN, {
          version: 1,
          extra: true,
        })
      ).status,
      400
    );

    const relisted = await request(address.url, "/v1/notifications", "GET", HUMAN_TOKEN);
    const relistedBody = (await relisted.json()) as {
      recentRead: Array<{ notificationId: string; readAt: string | null }>;
    };
    assert.equal(relistedBody.recentRead[0]?.notificationId, "notification-154");
    assert.equal(relistedBody.recentRead[0]?.readAt, NOW);
  } finally {
    await service.close();
  }
});
