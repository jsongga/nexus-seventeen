import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItem, WorkItemDependency } from "#shared/task-board-contract";
import { createTaskBoardService } from "#server/task-board";
import {
  AGENT_ONE_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  databasePath,
  workItemRequest,
} from "./helpers.js";

const BASE_SHA = "c".repeat(40);

function request(base: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
}

test("children and dependency routes expose the materialized hierarchy and list projection fields", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path, undefined, { git: () => `${BASE_SHA}\n` });
  const implementer = {
    agentTypeId: "decomposition-http-implementer",
    name: "HTTP decomposition implementer",
    description: "Implements HTTP fixture children.",
    role: "engineer" as const,
    supplementalInstructions: "Implement the declared child.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const reviewer = {
    ...implementer,
    agentTypeId: "decomposition-http-reviewer",
    name: "HTTP decomposition reviewer",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [implementer, reviewer],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: implementer.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: reviewer.agentTypeId },
    }),
  }));
  const parent = fixture.board.createWorkItem(workItemRequest({
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), "decomposition-http-parent").workItem;
  const workflow = fixture.board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId: fixture.project.projectId,
    objective: "Expose a decomposed hierarchy over HTTP.",
    assumptions: [],
    acceptanceCriteria: ["The hierarchy routes return exact persisted relationships."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["coordination"],
    children: [{
      key: "http-first-child",
      objective: "Create the first HTTP child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/http-first"],
      acceptanceCriteria: ["The first child is visible."],
    }, {
      key: "http-second-child",
      objective: "Create the dependent HTTP child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/http-second"],
      acceptanceCriteria: ["The dependent child is visible."],
      dependsOn: ["http-first-child"],
    }],
    skillIds: [],
    nodes: [{
      nodeId: "decomposition-http-parent-node",
      title: "Coordinate HTTP children",
      objective: "Coordinate the HTTP route fixture.",
      acceptanceCriteria: ["The parent coordinates children."],
      dependencyNodeIds: [],
      stageTemplate: ["verification"],
    }],
  });
  const revision = workflow.plans.find((plan) => plan.workItemId === parent.workItemId);
  assert.ok(revision);
  fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  const expectedChildren = fixture.board.listChildren(parent.workItemId);
  const expectedDependencies = fixture.board.dependenciesFor(expectedChildren[1]!.workItemId);
  fixture.board.close();

  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
  });
  const address = await service.start();
  try {
    assert.equal((await request(
      address.url,
      `/v1/work-items/${parent.workItemId}/children`,
      AGENT_ONE_TOKEN,
    )).status, 401);

    const childrenResponse = await request(
      address.url,
      `/v1/work-items/${parent.workItemId}/children`,
      HUMAN_TOKEN,
    );
    assert.equal(childrenResponse.status, 200);
    assert.deepEqual(
      (await childrenResponse.json() as { children: readonly WorkItem[] }).children,
      expectedChildren,
    );

    const dependenciesResponse = await request(
      address.url,
      `/v1/work-items/${expectedChildren[1]!.workItemId}/dependencies`,
      HUMAN_TOKEN,
    );
    assert.equal(dependenciesResponse.status, 200);
    assert.deepEqual(
      (await dependenciesResponse.json() as { dependencies: readonly WorkItemDependency[] }).dependencies,
      expectedDependencies,
    );

    const listResponse = await request(address.url, "/v1/work-items", HUMAN_TOKEN);
    assert.equal(listResponse.status, 200);
    const listedChildren = (await listResponse.json() as { workItems: readonly WorkItem[] }).workItems
      .filter((workItem) => workItem.parentWorkItemId === parent.workItemId)
      .toSorted((left, right) => left.childOrdinal! - right.childOrdinal!);
    assert.deepEqual(listedChildren.map((child) => ({
      parentWorkItemId: child.parentWorkItemId,
      phase: child.phase,
      childOrdinal: child.childOrdinal,
    })), [{ parentWorkItemId: parent.workItemId, phase: null, childOrdinal: 0 }, {
      parentWorkItemId: parent.workItemId,
      phase: null,
      childOrdinal: 1,
    }]);

    const patchedResponse = await request(
      address.url,
      `/v1/work-items/${expectedChildren[0]!.workItemId}`,
      HUMAN_TOKEN,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: expectedChildren[0]!.version, priority: "urgent" }),
      },
    );
    assert.equal(patchedResponse.status, 200);
    const patched = (await patchedResponse.json() as { workItem: WorkItem }).workItem;
    assert.equal(patched.priority, "urgent");
    assert.equal(patched.state, "queued");
    assert.equal(patched.currentStage, null);
    assert.equal(patched.planningTaskId, null);

    assert.equal((await request(
      address.url,
      "/v1/work-items/unknown-work-item/children",
      HUMAN_TOKEN,
    )).status, 404);
    assert.equal((await request(
      address.url,
      "/v1/work-items/unknown-work-item/dependencies",
      HUMAN_TOKEN,
    )).status, 404);
  } finally {
    await service.close();
  }
});
