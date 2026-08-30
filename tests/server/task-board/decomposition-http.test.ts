import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ChildWorkItem, WorkItem, WorkItemDependency } from "#shared/task-board-contract";
import { createTaskBoardService } from "#server/task-board";
import {
  AGENT_ONE_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  databasePath,
  gateActions,
  workItemRequest,
} from "./helpers.js";

const BASE_SHA = "c".repeat(40);

function request(base: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
}

test("decomposition routes expose hierarchy, parent rejection, and parked-parent recovery", async () => {
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
  fixture.board.updateAutomationConfiguration(
    automationConfigurationRequest({
      agentTypes: [implementer, reviewer],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: implementer.agentTypeId },
        testing: { kind: "machine_verify" },
        verification: { kind: "agent_type", agentTypeId: reviewer.agentTypeId },
      }),
    })
  );
  const parent = fixture.board.createWorkItem(
    workItemRequest({
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    "decomposition-http-parent"
  ).workItem;
  const workflow = fixture.board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId: fixture.project.projectId,
    objective: "Expose a decomposed hierarchy over HTTP.",
    assumptions: [],
    acceptanceCriteria: ["The hierarchy routes return exact persisted relationships."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["coordination"],
    children: [
      {
        key: "http-first-child",
        objective: "Create the first HTTP child.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/http-first"],
        acceptanceCriteria: ["The first child is visible."],
      },
      {
        key: "http-second-child",
        objective: "Create the dependent HTTP child.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/http-second"],
        acceptanceCriteria: ["The dependent child is visible."],
        dependsOn: ["http-first-child"],
      },
    ],
    skillIds: [],
    nodes: [
      {
        nodeId: "decomposition-http-parent-node",
        title: "Coordinate HTTP children",
        objective: "Coordinate the HTTP route fixture.",
        acceptanceCriteria: ["The parent coordinates children."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      },
    ],
  });
  const revision = workflow.plans.find((plan) => plan.workItemId === parent.workItemId);
  assert.ok(revision);
  fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  const seeded = new DatabaseSync(path);
  let parentFinalVersion: number;
  try {
    seeded
      .prepare(
        `
      UPDATE work_nodes
      SET state='completed',current_stage=NULL,version=version+1,updated_at=?
      WHERE plan_revision_id IN (
        SELECT plan.plan_revision_id
        FROM plan_revisions plan
        JOIN work_items child ON child.work_item_id=plan.work_item_id
        WHERE child.parent_work_item_id=? AND plan.state='confirmed'
      )
    `
      )
      .run("2026-08-29T16:00:00.000Z", parent.workItemId);
    seeded
      .prepare(
        `
      UPDATE work_items
      SET state='final_approval',current_stage=NULL,version=version+1,updated_at=?
      WHERE parent_work_item_id=?
    `
      )
      .run("2026-08-29T16:00:00.000Z", parent.workItemId);
    seeded
      .prepare(
        `
      UPDATE work_items
      SET state='final_approval',current_stage=NULL,version=version+1,updated_at=?
      WHERE work_item_id=?
    `
      )
      .run("2026-08-29T16:00:00.000Z", parent.workItemId);
    parentFinalVersion = Number(
      seeded.prepare("SELECT version FROM work_items WHERE work_item_id=?").get(parent.workItemId)?.version
    );
  } finally {
    seeded.close();
  }
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
    assert.equal(
      (await request(address.url, `/v1/work-items/${parent.workItemId}/children`, AGENT_ONE_TOKEN)).status,
      401
    );

    const childrenResponse = await request(address.url, `/v1/work-items/${parent.workItemId}/children`, HUMAN_TOKEN);
    assert.equal(childrenResponse.status, 200);
    assert.deepEqual(
      ((await childrenResponse.json()) as { children: readonly ChildWorkItem[] }).children,
      expectedChildren
    );

    const unattestedChild = expectedChildren[0]!;
    assert.equal(
      (
        await request(address.url, `/v1/work-items/${unattestedChild.workItemId}/attest-deploy`, AGENT_ONE_TOKEN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401
    );
    assert.equal(
      (
        await request(address.url, `/v1/work-items/${unattestedChild.workItemId}/attest-deploy`, HUMAN_TOKEN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      409
    );

    const dependenciesResponse = await request(
      address.url,
      `/v1/work-items/${expectedChildren[1]!.workItemId}/dependencies`,
      HUMAN_TOKEN
    );
    assert.equal(dependenciesResponse.status, 200);
    assert.deepEqual(
      ((await dependenciesResponse.json()) as { dependencies: readonly WorkItemDependency[] }).dependencies,
      expectedDependencies
    );

    const listResponse = await request(address.url, "/v1/work-items", HUMAN_TOKEN);
    assert.equal(listResponse.status, 200);
    const listedChildren = ((await listResponse.json()) as { workItems: readonly WorkItem[] }).workItems
      .filter((workItem) => workItem.parentWorkItemId === parent.workItemId)
      .toSorted((left, right) => left.childOrdinal! - right.childOrdinal!);
    assert.deepEqual(
      listedChildren.map((child) => ({
        parentWorkItemId: child.parentWorkItemId,
        phase: child.phase,
        childOrdinal: child.childOrdinal,
      })),
      [
        { parentWorkItemId: parent.workItemId, phase: null, childOrdinal: 0 },
        {
          parentWorkItemId: parent.workItemId,
          phase: null,
          childOrdinal: 1,
        },
      ]
    );

    const patchedResponse = await request(
      address.url,
      `/v1/work-items/${expectedChildren[0]!.workItemId}`,
      HUMAN_TOKEN,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: expectedChildren[0]!.version, priority: "urgent" }),
      }
    );
    assert.equal(patchedResponse.status, 200);
    const patched = ((await patchedResponse.json()) as { workItem: WorkItem }).workItem;
    assert.equal(patched.priority, "urgent");
    assert.equal(patched.state, "final_approval");
    assert.equal(patched.currentStage, null);
    assert.equal(patched.planningTaskId, null);

    const childrenBeforeRejectionResponse = await request(
      address.url,
      `/v1/work-items/${parent.workItemId}/children`,
      HUMAN_TOKEN
    );
    const childrenBeforeRejection = (
      (await childrenBeforeRejectionResponse.json()) as {
        children: readonly ChildWorkItem[];
      }
    ).children;
    assert.equal(
      (
        await request(address.url, `/v1/work-items/${parent.workItemId}/reject-final`, AGENT_ONE_TOKEN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: parentFinalVersion, note: "The parent needs more coordination." }),
        })
      ).status,
      401
    );
    const parentRejection = await request(
      address.url,
      `/v1/work-items/${parent.workItemId}/reject-final`,
      HUMAN_TOKEN,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: parentFinalVersion, note: "The parent needs more coordination." }),
      }
    );
    assert.equal(parentRejection.status, 200);
    assert.equal(((await parentRejection.json()) as { workItem: WorkItem }).workItem.state, "coordinating");
    const childrenAfterRejectionResponse = await request(
      address.url,
      `/v1/work-items/${parent.workItemId}/children`,
      HUMAN_TOKEN
    );
    const childrenAfterRejection = (
      (await childrenAfterRejectionResponse.json()) as {
        children: readonly ChildWorkItem[];
      }
    ).children;
    assert.deepEqual(
      childrenAfterRejection.map((child) => child.workItemId),
      childrenBeforeRejection.map((child) => child.workItemId)
    );
    assert.deepEqual(
      childrenAfterRejection.map((child) => child.state),
      ["fixing", "fixing"]
    );
    for (const child of childrenAfterRejection) {
      const childRejectionAction = gateActions(path, child.workItemId).at(-1);
      assert.equal(childRejectionAction?.gate, "final_reject");
      assert.equal(childRejectionAction?.actorId, "human:alice");
      assert.equal(childRejectionAction?.note, "The parent needs more coordination.");
    }
    const rejectionAction = gateActions(path, parent.workItemId).at(-1);
    assert.equal(rejectionAction?.gate, "final_reject");
    assert.equal(rejectionAction?.actorId, "human:alice");
    assert.equal(rejectionAction?.note, "The parent needs more coordination.");

    const childToCancel = childrenAfterRejection[1]!;
    const cancellation = await request(address.url, `/v1/work-items/${childToCancel.workItemId}`, HUMAN_TOKEN, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "cancel",
        version: childToCancel.version,
        reason: "Park the parent for HTTP recovery coverage.",
      }),
    });
    assert.equal(cancellation.status, 200);
    const parkedParentResponse = await request(address.url, `/v1/work-items/${parent.workItemId}`, HUMAN_TOKEN);
    assert.equal(((await parkedParentResponse.json()) as { workItem: WorkItem }).workItem.state, "parked");
    assert.equal(
      (await request(address.url, `/v1/work-items/${parent.workItemId}/resume`, AGENT_ONE_TOKEN, { method: "POST" }))
        .status,
      401
    );
    assert.equal(
      (await request(address.url, `/v1/work-items/${childToCancel.workItemId}/resume`, HUMAN_TOKEN, { method: "POST" }))
        .status,
      409
    );
    const resumedParent = await request(address.url, `/v1/work-items/${parent.workItemId}/resume`, HUMAN_TOKEN, {
      method: "POST",
    });
    assert.equal(resumedParent.status, 200);
    assert.equal(((await resumedParent.json()) as { workItem: WorkItem }).workItem.state, "coordinating");
    assert.equal(
      (await request(address.url, `/v1/work-items/${parent.workItemId}/resume`, HUMAN_TOKEN, { method: "POST" }))
        .status,
      409
    );

    assert.equal((await request(address.url, "/v1/work-items/unknown-work-item/children", HUMAN_TOKEN)).status, 404);
    assert.equal(
      (await request(address.url, "/v1/work-items/unknown-work-item/dependencies", HUMAN_TOKEN)).status,
      404
    );
  } finally {
    await service.close();
  }
});
