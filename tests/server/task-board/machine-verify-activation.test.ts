import assert from "node:assert/strict";
import test from "node:test";
import { AutomationCollaborator } from "#server/task-board/collaborators/automation";
import { ProjectsCollaborator } from "#server/task-board/collaborators/projects";
import { TaskBoardRuntime } from "#server/task-board/collaborators/runtime";
import { TasksCollaborator } from "#server/task-board/collaborators/tasks";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  workItemRequest,
} from "./helpers.js";

test("a non-pipeline machine_verify testing stage blocks before creating or starting an attempt", async () => {
  const fixture = await boardFixture();
  let originalBoardOpen = true;
  let store: TaskBoardStore | undefined;
  let runtime: TaskBoardRuntime | undefined;
  let projects: ProjectsCollaborator | undefined;
  try {
    const workItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Run testing before terminal verification without a pipeline workspace.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "non-pipeline-machine-verify-activation").workItem;
    const proposed = fixture.board.proposeWorkflow({
      workItemId: workItem.workItemId,
      projectId: fixture.project.projectId,
      objective: "Exercise a valid non-pipeline testing stage.",
      assumptions: [],
      acceptanceCriteria: ["Testing never verifies an unrelated branch."],
      skillIds: [],
      nodes: [{
        nodeId: "non-pipeline-machine-verify-node",
        title: "Test before verification",
        objective: "Block machine verification without pipeline identity.",
        acceptanceCriteria: ["No verify attempt or subprocess starts."],
        dependencyNodeIds: [],
        stageTemplate: ["testing", "verification"],
      }],
    });
    const confirmed = fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, {
      expectedState: "proposed",
    });
    const node = confirmed.nodes[0];
    assert.ok(node);
    assert.equal(node.state, "blocked");

    fixture.board.close();
    originalBoardOpen = false;
    const boardConfig = config(fixture.path);
    store = await TaskBoardStore.open(boardConfig.dbPath);
    runtime = new TaskBoardRuntime(boardConfig, store);
    const automation = new AutomationCollaborator(runtime);
    const current = automation.getConfiguration();
    automation.updateConfiguration(automationConfigurationRequest({
      version: current.version,
      agentTypes: current.agentTypes,
      stages: automationStages({ testing: { kind: "machine_verify" } }),
    }));
    store.transaction(() => {
      store?.db.prepare(`
        UPDATE work_nodes
        SET state='ready',version=version+1,updated_at=?
        WHERE node_id=?
      `).run(boardConfig.now().toISOString(), node.nodeId);
    });

    let workspaceFactoryCalls = 0;
    let runnerFactoryCalls = 0;
    let startCalls = 0;
    projects = new ProjectsCollaborator(
      runtime,
      automation,
      new TasksCollaborator(runtime),
      () => "a".repeat(40),
      {
        workspaceManagerFactory: () => {
          workspaceFactoryCalls += 1;
          return {
            async create() { throw new Error("workspace creation must not run"); },
            async remove() { throw new Error("workspace removal must not run"); },
            async retain() { throw new Error("workspace retention must not run"); },
          };
        },
        runnerFactory: () => {
          runnerFactoryCalls += 1;
          return {
            async startFull() {
              startCalls += 1;
              throw new Error("machine verify subprocess must not run");
            },
            async status() { throw new Error("status must not run"); },
            async tail() { throw new Error("tail must not run"); },
          };
        },
      },
    );

    projects.reconcileWorkflows(fixture.project.projectId);

    const blocked = projects.projectWorkflow(fixture.project.projectId).nodes[0];
    assert.ok(blocked);
    assert.equal(blocked.state, "blocked");
    const latestBlock = store.db.prepare(`
      SELECT summary
      FROM project_events
      WHERE node_id=? AND event_type='node_blocked'
      ORDER BY sequence DESC
      LIMIT 1
    `).get(node.nodeId);
    assert.equal(latestBlock?.summary, "machine_verify requires a pipeline plan");
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS count FROM verify_attempts").get()?.count), 0);
    assert.equal(workspaceFactoryCalls, 0);
    assert.equal(runnerFactoryCalls, 0);
    assert.equal(startCalls, 0);
  } finally {
    projects?.close();
    runtime?.close();
    store?.close();
    if (originalBoardOpen) fixture.board.close();
  }
});
