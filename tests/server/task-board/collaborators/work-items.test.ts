import assert from "node:assert/strict";
import test from "node:test";
import { AutomationCollaborator } from "#server/task-board/collaborators/automation";
import { TaskBoardRuntime } from "#server/task-board/collaborators/runtime";
import { TasksCollaborator } from "#server/task-board/collaborators/tasks";
import { WorkItemsCollaborator } from "#server/task-board/collaborators/work-items";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { config, databasePath } from "../helpers.js";

const CREATED_AT = "2026-08-21T12:00:00.000Z";
const CLOSED_AT = "2026-08-21T12:05:00.000Z";

async function linkedWorkFixture() {
  const path = await databasePath();
  const store = await TaskBoardStore.open(path);
  const runtime = new TaskBoardRuntime(config(path), store);
  const automation = new AutomationCollaborator(runtime);
  const tasks = new TasksCollaborator(runtime);
  const workItems = new WorkItemsCollaborator(runtime, automation, tasks);
  const projectId = "close-work-project";
  const workItemId = "close-work-item";
  const agentId = "close-work-manager";
  const taskIds = ["close-planning-task", "close-design-task", "close-stage-task"] as const;

  store.db.prepare(`
    INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
    VALUES(?,?,?,?,1,?,?)
  `).run(
    projectId,
    "Close linked work",
    "Exercise task-closing unification.",
    "Exercise task-closing unification.",
    CREATED_AT,
    CREATED_AT,
  );
  store.db.prepare(`
    INSERT INTO agents(
      agent_id, project_id, role, area, mission, model, token_hash, last_error, version, created_at
    ) VALUES(?,?,?,?,?,?,?,NULL,1,?)
  `).run(
    agentId,
    projectId,
    "manager",
    "task closure",
    "Own every linked test task.",
    "test-model",
    "close-work-token-hash",
    CREATED_AT,
  );
  store.db.prepare(`
    INSERT INTO work_items(
      work_item_id, original_request, refined_objective, priority,
      project_target_mode, target_project_id, resolved_project_id,
      state, current_stage, created_by, idempotency_key, request_hash,
      version, created_at, updated_at, ended_at, cancelled_reason, archived_at
    ) VALUES (?, 'Close all linked work.', NULL, 'normal', 'explicit', ?, ?,
      'implementing', 'implementation', 'human:test', 'close-work-key', 'close-work-hash',
      1, ?, ?, NULL, NULL, NULL)
  `).run(workItemId, projectId, projectId, CREATED_AT, CREATED_AT);

  const insertTask = store.db.prepare(`
    INSERT INTO tasks(
      task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
      title, objective, acceptance_criteria, workspace_refs_json,
      status, assigned_agent_id, assigned_role, expected_agent_minutes,
      agent_estimate_minutes, estimate_recorded_at, order_key, started_at, ended_at,
      result, version, created_at, updated_at
    ) VALUES (?, ?, NULL, 'work', NULL, 0, ?, 'Close this task.', 'The task is cancelled.', '[]',
      ?, ?, 'manager', 15, NULL, NULL, ?, ?, NULL, NULL, 1, ?, ?)
  `);
  insertTask.run(taskIds[0], projectId, "Planning", "queued", agentId, 0, null, CREATED_AT, CREATED_AT);
  insertTask.run(taskIds[1], projectId, "Design", "blocked", agentId, 1024, CREATED_AT, CREATED_AT, CREATED_AT);
  insertTask.run(taskIds[2], projectId, "Stage", "in_progress", agentId, 2048, CREATED_AT, CREATED_AT, CREATED_AT);
  store.db.prepare("INSERT INTO work_item_planning_tasks VALUES(?,?,?)")
    .run(workItemId, taskIds[0], CREATED_AT);
  store.db.prepare("INSERT INTO work_item_design_tasks VALUES(?,?,?)")
    .run(workItemId, taskIds[1], CREATED_AT);
  store.db.prepare(`
    INSERT INTO plan_revisions(
      plan_revision_id, work_item_id, revision, objective, assumptions_json,
      acceptance_criteria_json, change_shape, tier, declared_scope_json, non_goals_json,
      mechanical_portions_json, blocking_questions_json, criterion_checks_json, rejected_note,
      project_id, skill_digests_json, state, created_by, created_at, confirmed_by, confirmed_at
    ) VALUES (
      'close-plan', ?, 1, 'Close linked stage work.', '[]', '[]', NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, ?, '{}', 'confirmed', 'human:test', ?, 'human:test', ?
    )
  `).run(workItemId, projectId, CREATED_AT, CREATED_AT);
  store.db.prepare(`
    INSERT INTO work_nodes(
      node_id, plan_revision_id, project_id, title, objective, acceptance_criteria_json,
      stage_template_json, current_stage, state, version, created_at, updated_at
    ) VALUES (
      'close-node', 'close-plan', ?, 'Close node', 'Close its stage task.', '[]',
      '["implementation"]', 'implementation', 'active', 1, ?, ?
    )
  `).run(projectId, CREATED_AT, CREATED_AT);
  store.db.prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)")
    .run("close-attempt", "close-node", taskIds[2], "implementation", 1, "{}");

  const insertPhase = store.db.prepare(`
    INSERT INTO task_phases(
      phase_id, project_id, task_id, title, stage, status, parallel_group, order_key,
      started_at, ended_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'Execute', 'execution', 'pending', NULL, 0, NULL, NULL, 1, ?, ?)
  `);
  for (const [index, taskId] of taskIds.entries()) {
    insertPhase.run(`close-phase-${index}`, projectId, taskId, CREATED_AT, CREATED_AT);
    store.db.prepare(`
      INSERT INTO wakeups(
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      ) VALUES (?, ?, ?, 'human_assignment', ?, ?, NULL, 'Close work wakeup.', 'human:test', ?, NULL, NULL)
    `).run(`close-wakeup-${index}`, projectId, agentId, `close-source-${index}`, taskId, CREATED_AT);
  }

  const insertQuestion = store.db.prepare(`
    INSERT INTO questions(
      question_id, project_id, task_id, agent_id, run_id, client_event_id, request_hash,
      question, status, answer, asked_at, answered_at, answered_by, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Can this continue?', 'open', NULL, ?, NULL, NULL, 1)
  `);
  insertQuestion.run(
    "close-planning-question",
    projectId,
    taskIds[0],
    agentId,
    "close-planning-run",
    "close-planning-client-event",
    "close-planning-request-hash",
    CREATED_AT,
  );
  insertQuestion.run(
    "close-stage-question",
    projectId,
    taskIds[2],
    agentId,
    "close-stage-run",
    "close-stage-client-event",
    "close-stage-request-hash",
    CREATED_AT,
  );

  return { runtime, store, taskIds, workItemId, workItems };
}

test("closeWorkItemWorkInTransaction cancels every linked task and is idempotent", async () => {
  const fixture = await linkedWorkFixture();
  const token = `github_pat_${"c".repeat(48)}`;
  const expectedReason = "Stop after receiving [redacted:token]";
  const actor = { type: "system" as const, id: "system:test-closer" };
  try {
    fixture.store.transaction(() => fixture.workItems.closeWorkItemWorkInTransaction(
      fixture.workItemId,
      `Stop after receiving ${token}.`,
      actor,
      CLOSED_AT,
    ));

    assert.deepEqual(fixture.store.db.prepare(`
      SELECT task_id, status, started_at, ended_at, result, version
      FROM tasks WHERE task_id IN (?,?,?) ORDER BY order_key
    `).all(...fixture.taskIds).map((row) => ({ ...row })), fixture.taskIds.map((taskId) => ({
      task_id: taskId,
      status: "cancelled",
      started_at: taskId === fixture.taskIds[0] ? CLOSED_AT : CREATED_AT,
      ended_at: CLOSED_AT,
      result: expectedReason,
      version: 2,
    })));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status, started_at, ended_at, version FROM task_phases ORDER BY order_key, phase_id
    `).all().map((row) => ({ ...row })), fixture.taskIds.map(() => ({
      status: "failed",
      started_at: CLOSED_AT,
      ended_at: CLOSED_AT,
      version: 2,
    })));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status, answer, answered_at, answered_by, version FROM questions ORDER BY question_id
    `).all().map((row) => ({ ...row })), fixture.taskIds.filter((taskId) => taskId !== fixture.taskIds[1]).map(() => ({
      status: "answered",
      answer: `Closed because the work item was cancelled: ${expectedReason}`,
      answered_at: CLOSED_AT,
      answered_by: actor.id,
      version: 2,
    })));
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count FROM task_events WHERE event_type='task_updated'
    `).get()?.count, 3);
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count FROM task_events WHERE event_type='human_question_closed'
    `).get()?.count, 2);
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count FROM task_events WHERE event_type='agent_wakeup_retired'
    `).get()?.count, 3);
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count FROM task_events
      WHERE actor_type=? AND actor_id=? AND event_type IN ('task_updated','human_question_closed')
    `).get(actor.type, actor.id)?.count, 5);
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count FROM task_events
      WHERE event_type='human_question_closed'
        AND json_extract(data_json, '$.reason')='work_item_cancelled'
    `).get()?.count, 2);
    for (const taskId of fixture.taskIds) {
      assert.ok(fixture.store.db.prepare(
        "SELECT 1 FROM task_events WHERE event_id='retired-wakeup:' || ?",
      ).get(`close-wakeup-${fixture.taskIds.indexOf(taskId)}`));
    }
    assert.equal(JSON.parse(String(fixture.store.db.prepare(`
      SELECT data_json FROM task_events WHERE event_type='task_updated' ORDER BY sequence LIMIT 1
    `).get()?.data_json)).result, expectedReason);

    const beforeReplay = {
      events: fixture.store.db.prepare("SELECT COUNT(*) AS count FROM task_events").get()?.count,
      taskVersions: fixture.store.db.prepare("SELECT version FROM tasks ORDER BY order_key").all()
        .map((row) => row.version),
      questionVersions: fixture.store.db.prepare("SELECT version FROM questions ORDER BY question_id").all()
        .map((row) => row.version),
    };
    fixture.store.transaction(() => fixture.workItems.closeWorkItemWorkInTransaction(
      fixture.workItemId,
      `Stop after receiving ${token}.`,
      actor,
      CLOSED_AT,
    ));
    assert.deepEqual({
      events: fixture.store.db.prepare("SELECT COUNT(*) AS count FROM task_events").get()?.count,
      taskVersions: fixture.store.db.prepare("SELECT version FROM tasks ORDER BY order_key").all()
        .map((row) => row.version),
      questionVersions: fixture.store.db.prepare("SELECT version FROM questions ORDER BY question_id").all()
        .map((row) => row.version),
    }, beforeReplay);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});
