import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTaskBoardService } from "#server/task-board";
import {
  AGENT_ONE_TOKEN,
  HUMAN_TOKEN,
  boardFixture,
  databasePath,
  taskRequest,
  workItemRequest,
} from "../helpers.js";

const NOW = "2026-08-21T12:00:00.000Z";

function insertConfirmedPlanAndNode(
  db: DatabaseSync,
  workItemId: string,
  projectId: string,
  suffix: string,
): { planRevisionId: string; nodeId: string } {
  const planRevisionId = `ledger-plan-${suffix}`;
  const nodeId = `ledger-node-${suffix}`;
  db.prepare(`
    INSERT INTO plan_revisions(
      plan_revision_id, work_item_id, revision, objective, assumptions_json,
      acceptance_criteria_json, project_id, skill_digests_json, state,
      created_by, confirmed_by, created_at, confirmed_at
    ) VALUES (?, ?, 1, 'Make ledger evidence queryable.', '[]', '[]', ?, '{}',
      'confirmed', 'human:test', 'human:test', ?, ?)
  `).run(planRevisionId, workItemId, projectId, NOW, NOW);
  db.prepare(`
    INSERT INTO work_nodes(
      node_id, plan_revision_id, project_id, title, objective,
      acceptance_criteria_json, stage_template_json, current_stage, state,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, 'Ledger node', 'Expose durable evidence.', '[]',
      '["verification"]', 'verification', 'active', 1, ?, ?)
  `).run(nodeId, planRevisionId, projectId, NOW, NOW);
  return { planRevisionId, nodeId };
}

function insertFinding(
  db: DatabaseSync,
  nodeId: string,
  suffix: string,
  category: "correctness" | "docs",
  severity: "minor" | "major" | "critical",
  blocking: boolean,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO review_findings(
      finding_id, node_id, stage, round, file, line, category, severity,
      expected, actual, blocking, created_at
    ) VALUES (?, ?, 'verification', 1, NULL, NULL, ?, ?,
      'The expected behavior is preserved.', 'The observed behavior differs.', ?, ?)
  `).run(`ledger-finding-${suffix}`, nodeId, category, severity, blocking ? 1 : 0, createdAt);
}

test("ledger collaborators aggregate findings, filter by project, and order park history", async () => {
  const fixture = await boardFixture(undefined, () => new Date(NOW));
  try {
    assert.deepEqual(fixture.board.findingsLedger(), { categories: [], perProject: [], recent: [] });
    assert.deepEqual(fixture.board.parksLedger(), { open: [], resolved: [], recordsSince: "2026-08-20" });

    const secondProject = fixture.board.createProject({
      name: "Fulfilment reliability",
      description: "Keep order fulfilment dependable.",
    });
    const firstItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Original first work-item request.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "ledger-work-item-one").workItem;
    const secondRequest = "Second work-item request ".repeat(12);
    const secondItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: secondRequest,
      projectTarget: { mode: "explicit", projectId: secondProject.projectId },
    }), "ledger-work-item-two").workItem;
    const activeTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Review ledger observability",
      requiresReview: false,
    }));

    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("UPDATE work_items SET refined_objective=? WHERE work_item_id=?")
        .run("Refined first work-item objective.", firstItem.workItemId);
      db.prepare("DELETE FROM work_item_transitions WHERE work_item_id=?").run(secondItem.workItemId);
      db.prepare(`
        INSERT INTO work_item_transitions(
          work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
        ) VALUES (?, 2, 'queued', 'planning', 'system', 'system:test', ?)
      `).run(firstItem.workItemId, "2026-08-21T13:00:00.000Z");

      const first = insertConfirmedPlanAndNode(db, firstItem.workItemId, fixture.project.projectId, "one");
      const second = insertConfirmedPlanAndNode(db, secondItem.workItemId, secondProject.projectId, "two");
      db.prepare(`
        INSERT INTO stage_attempts(attempt_id, node_id, task_id, stage, attempt, skill_digests_json)
        VALUES ('ledger-attempt-one', ?, ?, 'verification', 3, '{}')
      `).run(first.nodeId, activeTask.taskId);

      insertFinding(db, first.nodeId, "one-a", "correctness", "major", true, "2026-08-21T09:00:00.000Z");
      insertFinding(db, first.nodeId, "one-b", "correctness", "major", true, "2026-08-21T08:00:00.000Z");
      insertFinding(db, first.nodeId, "one-c", "docs", "minor", false, "2026-08-21T10:00:00.000Z");
      insertFinding(db, second.nodeId, "two-a", "correctness", "critical", true, "2026-08-21T13:00:00.000Z");
      insertFinding(db, second.nodeId, "two-b", "docs", "minor", false, "2026-08-21T12:00:00.000Z");
      insertFinding(db, second.nodeId, "two-c", "docs", "minor", false, "2026-08-21T11:00:00.000Z");

      const insertPark = db.prepare(`
        INSERT INTO park_records(
          park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertPark.run(
        "park-open-newer",
        firstItem.workItemId,
        "open_question",
        "Wait for a decision on retry behavior.",
        "2026-08-20T12:00:00.000Z",
        null,
        null,
      );
      insertPark.run(
        "park-open-older",
        secondItem.workItemId,
        "bright_line",
        "Wait for a hazardous-change review.",
        "2026-08-19T12:00:00.000Z",
        null,
        null,
      );
      insertPark.run(
        "park-resolved-older",
        firstItem.workItemId,
        "scope_violation",
        "Return the change to declared scope.",
        "2026-08-18T12:00:00.000Z",
        "2026-08-20T14:00:00.000Z",
        "resumed",
      );
      insertPark.run(
        "park-resolved-newer",
        secondItem.workItemId,
        "planning_run_failed",
        "Retry planning with a healthy manager.",
        "2026-08-20T10:00:00.000Z",
        "2026-08-21T14:00:00.000Z",
        "abandoned",
      );
    } finally {
      db.close();
    }

    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "ledger-active-run",
      messageCursor: null,
    });
    assert.ok(claim);

    const findings = fixture.board.findingsLedger();
    assert.deepEqual(findings.categories, [
      { category: "correctness", severity: "critical", blocking: true, count: 1 },
      { category: "correctness", severity: "major", blocking: true, count: 2 },
      { category: "docs", severity: "minor", blocking: false, count: 3 },
    ]);
    assert.deepEqual(
      [...findings.perProject].sort((left, right) =>
        left.projectId.localeCompare(right.projectId) || left.category.localeCompare(right.category)),
      [
        { projectId: fixture.project.projectId, category: "correctness", count: 2 },
        { projectId: fixture.project.projectId, category: "docs", count: 1 },
        { projectId: secondProject.projectId, category: "correctness", count: 1 },
        { projectId: secondProject.projectId, category: "docs", count: 2 },
      ].sort((left, right) =>
        left.projectId.localeCompare(right.projectId) || left.category.localeCompare(right.category)),
    );
    assert.equal(findings.recent.length, 6);
    assert.deepEqual(findings.recent.slice(0, 3).map((finding) => finding.findingId), [
      "ledger-finding-two-a",
      "ledger-finding-two-b",
      "ledger-finding-two-c",
    ]);
    assert.equal(findings.recent.every((finding) => finding.workItemId.length > 0), true);

    const filtered = fixture.board.findingsLedger(fixture.project.projectId);
    assert.deepEqual(filtered.categories, [
      { category: "correctness", severity: "major", blocking: true, count: 2 },
      { category: "docs", severity: "minor", blocking: false, count: 1 },
    ]);
    assert.deepEqual(filtered.perProject, [
      { projectId: fixture.project.projectId, category: "correctness", count: 2 },
      { projectId: fixture.project.projectId, category: "docs", count: 1 },
    ]);
    assert.equal(filtered.recent.length, 3);
    assert.equal(filtered.recent.every((finding) => finding.workItemId === firstItem.workItemId), true);

    const parks = fixture.board.parksLedger();
    assert.deepEqual(parks.open.map((record) => record.parkRecordId), ["park-open-older", "park-open-newer"]);
    assert.deepEqual(parks.resolved.map((record) => record.parkRecordId), [
      "park-resolved-newer",
      "park-resolved-older",
    ]);
    assert.equal(parks.open[0]?.workItemTitle, secondRequest.slice(0, 220));
    assert.equal(parks.open[1]?.workItemTitle, "Refined first work-item objective.");
    assert.equal(parks.recordsSince, "2026-08-20");

    const listed = fixture.board.listWorkItemsPage().workItems;
    const listedFirst = listed.find((item) => item.workItemId === firstItem.workItemId);
    const listedSecond = listed.find((item) => item.workItemId === secondItem.workItemId);
    assert.ok(listedFirst);
    assert.ok(listedSecond);
    assert.equal(listedFirst.stateSince, "2026-08-21T13:00:00.000Z");
    assert.equal(listedFirst.reviewRound, 3);
    assert.equal(listedFirst.heartbeatAt, claim.run.startedAt);
    assert.deepEqual({
      stateSince: listedSecond.stateSince,
      reviewRound: listedSecond.reviewRound,
      heartbeatAt: listedSecond.heartbeatAt,
    }, { stateSince: null, reviewRound: null, heartbeatAt: null });
    assert.equal("stateSince" in fixture.board.requireWorkItem(firstItem.workItemId), false);
  } finally {
    fixture.board.close();
  }
});

test("campaign 6 exit criterion exposes categorized findings and parks across work items", async () => {
  const fixture = await boardFixture(undefined, () => new Date(NOW));
  try {
    const firstItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Prove correctness findings are queryable.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "ledger-exit-work-item-one").workItem;
    const secondItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Prove documentation findings are queryable.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "ledger-exit-work-item-two").workItem;
    const db = new DatabaseSync(fixture.path);
    try {
      const first = insertConfirmedPlanAndNode(db, firstItem.workItemId, fixture.project.projectId, "exit-one");
      const second = insertConfirmedPlanAndNode(db, secondItem.workItemId, fixture.project.projectId, "exit-two");
      insertFinding(db, first.nodeId, "exit-correctness", "correctness", "major", true, "2026-08-21T10:00:00.000Z");
      insertFinding(db, second.nodeId, "exit-docs", "docs", "minor", false, "2026-08-21T11:00:00.000Z");
      const insertPark = db.prepare(`
        INSERT INTO park_records(
          park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `);
      insertPark.run(
        "park-exit-question",
        firstItem.workItemId,
        "open_question",
        "Wait for the operator to choose the retry policy.",
        "2026-08-21T12:00:00.000Z",
      );
      insertPark.run(
        "park-exit-scope",
        secondItem.workItemId,
        "scope_violation",
        "Return the implementation to its declared scope.",
        "2026-08-21T13:00:00.000Z",
      );
    } finally {
      db.close();
    }

    const findings = fixture.board.findingsLedger();
    assert.deepEqual(findings.categories, [
      { category: "correctness", severity: "major", blocking: true, count: 1 },
      { category: "docs", severity: "minor", blocking: false, count: 1 },
    ]);
    assert.deepEqual(findings.perProject, [
      { projectId: fixture.project.projectId, category: "correctness", count: 1 },
      { projectId: fixture.project.projectId, category: "docs", count: 1 },
    ]);
    assert.deepEqual(findings.recent.map((finding) => ({
      findingId: finding.findingId,
      workItemId: finding.workItemId,
      category: finding.category,
    })), [
      { findingId: "ledger-finding-exit-docs", workItemId: secondItem.workItemId, category: "docs" },
      { findingId: "ledger-finding-exit-correctness", workItemId: firstItem.workItemId, category: "correctness" },
    ]);

    const parks = fixture.board.parksLedger();
    assert.deepEqual(parks.open.map((park) => ({
      parkRecordId: park.parkRecordId,
      workItemId: park.workItemId,
      category: park.category,
      reason: park.reason,
    })), [
      {
        parkRecordId: "park-exit-question",
        workItemId: firstItem.workItemId,
        category: "open_question",
        reason: "Wait for the operator to choose the retry policy.",
      },
      {
        parkRecordId: "park-exit-scope",
        workItemId: secondItem.workItemId,
        category: "scope_violation",
        reason: "Return the implementation to its declared scope.",
      },
    ]);
    assert.deepEqual(parks.resolved, []);
  } finally {
    fixture.board.close();
  }
});

function request(origin: string, path: string, token: string): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

test("ledger HTTP routes are human-only and opt in only to the findings project filter", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    reconcileIntervalSeconds: 0,
  });
  const address = await service.start();
  try {
    assert.equal((await request(address.url, "/v1/ledgers/findings", AGENT_ONE_TOKEN)).status, 401);
    assert.equal((await request(address.url, "/v1/ledgers/parks", AGENT_ONE_TOKEN)).status, 401);

    const findings = await request(address.url, "/v1/ledgers/findings?projectId=project-one", HUMAN_TOKEN);
    assert.equal(findings.status, 200);
    assert.deepEqual(await findings.json(), { categories: [], perProject: [], recent: [] });

    const parks = await request(address.url, "/v1/ledgers/parks", HUMAN_TOKEN);
    assert.equal(parks.status, 200);
    assert.deepEqual(await parks.json(), { open: [], resolved: [], recordsSince: "2026-08-20" });

    for (const path of [
      "/v1/ledgers/findings?projectId=",
      "/v1/ledgers/findings?projectId=project-one&projectId=project-two",
      "/v1/ledgers/findings?after=1",
      "/v1/ledgers/parks?projectId=project-one",
    ]) assert.equal((await request(address.url, path, HUMAN_TOKEN)).status, 400);
  } finally {
    await service.close();
  }
});
