import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DeclaredChild, WorkItem, WorkItemDependency } from "#shared/task-board-contract";
import {
  ContractValidationError,
  parseWorkflowPlanDraft,
  validateWorkflowPlanChildren,
} from "#shared/task-board-contract/validate";
import { TaskBoardError } from "#server/task-board";
import type { TaskBoard } from "#server/task-board/board";
import { automationConfigurationRequest, automationStages, boardFixture, workItemRequest } from "./helpers.js";

const PROVIDER_SHA = "a".repeat(40);
const CONSUMER_SHA = "b".repeat(40);

const DECOMPOSITION_IMPLEMENTER = {
  agentTypeId: "decomposition-implementer",
  name: "Decomposition implementer",
  description: "Implements independently mergeable child plans.",
  role: "engineer" as const,
  supplementalInstructions: "Implement only the declared child scope.",
  skillIds: [],
  evaluatorProfile: "tests" as const,
  enabled: true,
};
const DECOMPOSITION_REVIEWER = {
  ...DECOMPOSITION_IMPLEMENTER,
  agentTypeId: "decomposition-reviewer",
  name: "Decomposition reviewer",
  role: "verifier" as const,
};

function configureChildPipeline(board: TaskBoard): void {
  const current = board.getAutomationConfiguration();
  board.updateAutomationConfiguration(
    automationConfigurationRequest({
      version: current.version,
      agentTypes: [DECOMPOSITION_IMPLEMENTER, DECOMPOSITION_REVIEWER],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: DECOMPOSITION_IMPLEMENTER.agentTypeId },
        testing: { kind: "machine_verify" },
        verification: { kind: "agent_type", agentTypeId: DECOMPOSITION_REVIEWER.agentTypeId },
      }),
    })
  );
}

function proposeDecomposedPlan(
  board: TaskBoard,
  projectId: string,
  children: readonly DeclaredChild[],
  changeShape: "feature" | "blast_radius",
  idempotencyKey: string
) {
  configureChildPipeline(board);
  const parent = board.createWorkItem(
    workItemRequest({
      originalRequest: `Coordinate ${idempotencyKey}.`,
      priority: "high",
      projectTarget: { mode: "explicit", projectId },
    }),
    idempotencyKey
  ).workItem;
  const workflow = board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId,
    objective: `Coordinate the declared children for ${idempotencyKey}.`,
    assumptions: ["Each declaration is independently mergeable."],
    acceptanceCriteria: ["Every declared child reaches its approved outcome."],
    changeShape,
    tier: "standard",
    declaredScope: ["coordination"],
    nonGoals: ["Do not implement child work on the parent."],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [
      {
        criterion: "Every declared child reaches its approved outcome.",
        check: "npm run provider-only-check",
      },
    ],
    children,
    skillIds: [],
    nodes: [
      {
        nodeId: `parent-${changeShape}`,
        title: "Coordinate declared work",
        objective: "Track the declared child outcomes.",
        acceptanceCriteria: ["The child work is coordinated."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      },
    ],
  });
  const revision = workflow.plans.find((plan) => plan.workItemId === parent.workItemId);
  assert.ok(revision);
  return { parent, revision };
}

function childPlan(board: TaskBoard, child: WorkItem) {
  assert.ok(child.resolvedProjectId);
  const workflow = board.projectWorkflow(child.resolvedProjectId);
  const plan = workflow.plans.find((candidate) => candidate.workItemId === child.workItemId);
  assert.ok(plan);
  const nodes = workflow.nodes.filter((candidate) => candidate.planRevisionId === plan.planRevisionId);
  assert.equal(nodes.length, 1);
  return { plan, node: nodes[0]! };
}

function validateMaterializedChildPlan(board: TaskBoard, child: WorkItem): void {
  const { plan, node } = childPlan(board, child);
  const parsed = parseWorkflowPlanDraft({
    objective: plan.objective,
    assumptions: plan.assumptions,
    acceptanceCriteria: plan.acceptanceCriteria,
    ...(plan.changeShape === null ? {} : { changeShape: plan.changeShape }),
    ...(plan.tier === null ? {} : { tier: plan.tier }),
    ...(plan.declaredScope === null ? {} : { declaredScope: plan.declaredScope }),
    ...(plan.nonGoals === null ? {} : { nonGoals: plan.nonGoals }),
    ...(plan.mechanicalPortions === null ? {} : { mechanicalPortions: plan.mechanicalPortions }),
    ...(plan.blockingQuestions === null ? {} : { blockingQuestions: plan.blockingQuestions }),
    ...(plan.criterionChecks === null ? {} : { criterionChecks: plan.criterionChecks }),
    nodes: [
      {
        nodeId: node.nodeId,
        title: node.title,
        objective: node.objective,
        acceptanceCriteria: node.acceptanceCriteria,
        dependencyNodeIds: node.dependencyNodeIds,
        stageTemplate: node.stageTemplate,
      },
    ],
  });
  assert.ok(child.resolvedProjectId);
  validateWorkflowPlanChildren(parsed, child.resolvedProjectId);
}

test("a materialized child cannot confirm a plan that declares another decomposition level", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  const { revision, parent } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "child",
        objective: "Materialize the only allowed decomposition level.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/child"],
        acceptanceCriteria: ["The child owns a leaf plan."],
      },
    ],
    "feature",
    "nested-decomposition-rejected"
  );
  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const [child] = fixture.board.listChildren(parent.workItemId);
    assert.ok(child);
    const { plan } = childPlan(fixture.board, child);
    const nestedChildren: readonly DeclaredChild[] = [
      {
        key: "grandchild",
        objective: "Attempt an unsupported nested split.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/grandchild"],
        acceptanceCriteria: ["Nested decomposition is rejected."],
      },
    ];
    const nestedPlan = parseWorkflowPlanDraft({
      objective: plan.objective,
      assumptions: plan.assumptions,
      acceptanceCriteria: plan.acceptanceCriteria,
      changeShape: "feature",
      tier: "standard",
      declaredScope: plan.declaredScope,
      children: nestedChildren,
      nodes: [
        {
          nodeId: "nested-child-plan",
          title: "Nested child plan",
          objective: "Attempt the unsupported split.",
          acceptanceCriteria: ["The plan remains unconfirmed."],
          dependencyNodeIds: [],
          stageTemplate: ["implementation", "testing", "verification"],
        },
      ],
    });
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(
        `
        UPDATE plan_revisions
        SET state='proposed',confirmed_by=NULL,confirmed_at=NULL,children=?
        WHERE plan_revision_id=?
      `
      ).run(JSON.stringify(nestedChildren), plan.planRevisionId);
    } finally {
      db.close();
    }

    assert.throws(
      () => fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "WORKFLOW_INVALID" &&
        error.message === "workflowPlan.children is invalid for a child work item"
    );
    assert.throws(
      () =>
        (
          validateWorkflowPlanChildren as (
            candidate: typeof nestedPlan,
            projectId: string,
            parentWorkItemId: string
          ) => void
        )(nestedPlan, fixture.project.projectId, parent.workItemId),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.message === "workflowPlan.children is invalid for a child work item"
    );
    const unchanged = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        unchanged.prepare("SELECT state FROM plan_revisions WHERE plan_revision_id=?").get(plan.planRevisionId)?.state,
        "proposed"
      );
      assert.equal(
        unchanged.prepare("SELECT COUNT(*) AS count FROM work_items WHERE parent_work_item_id=?").get(child.workItemId)
          ?.count,
        0
      );
    } finally {
      unchanged.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("confirming a feature split creates independently claimable children with merge-order dependencies", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  const children: readonly DeclaredChild[] = [
    {
      key: "provider-contract",
      objective: "Publish the provider contract.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/provider"],
      acceptanceCriteria: ["The provider contract is published."],
    },
    {
      key: "consumer-adoption",
      objective: "Adopt the published contract.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/consumer"],
      acceptanceCriteria: ["The consumer uses the published contract."],
      dependsOn: ["provider-contract"],
    },
  ];
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    children,
    "feature",
    "feature-split-confirm"
  );

  try {
    const confirmation = fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    assert.deepEqual(
      confirmation.nodes
        .filter((node) => node.planRevisionId === revision.planRevisionId)
        .map((node) => ({ state: node.state, currentStage: node.currentStage })),
      [
        {
          state: "pending",
          currentStage: null,
        },
      ]
    );

    const coordinating = fixture.board.requireWorkItem(parent.workItemId);
    assert.equal(coordinating.state, "coordinating");
    assert.equal(coordinating.currentStage, null);
    assert.equal(coordinating.pipelineBranch, null);
    assert.equal(coordinating.baseSha, null);
    assert.deepEqual(
      fixture.board.workItemAudit(parent.workItemId).gateActions.map((action) => ({
        gate: action.gate,
        actorId: action.actorId,
        planRevisionId: action.planRevisionId,
        refId: action.refId,
      })),
      [
        {
          gate: "plan_confirm",
          actorId: "human:alice",
          planRevisionId: revision.planRevisionId,
          refId: "1",
        },
      ]
    );

    const materialized = fixture.board.listChildren(parent.workItemId);
    assert.equal(materialized.length, 2);
    const storedChildren = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.deepEqual(
        storedChildren
          .prepare("SELECT repository_id FROM work_items WHERE parent_work_item_id=? ORDER BY child_ordinal")
          .all(parent.workItemId)
          .map((row) => row.repository_id),
        [null, null]
      );
    } finally {
      storedChildren.close();
    }
    assert.deepEqual(
      materialized.map((child) => ({
        originalRequest: child.originalRequest,
        refinedObjective: child.refinedObjective,
        priority: child.priority,
        taskType: child.taskType,
        projectTarget: child.projectTarget,
        resolvedProjectId: child.resolvedProjectId,
        parentWorkItemId: child.parentWorkItemId,
        phase: child.phase,
        childOrdinal: child.childOrdinal,
        pipelineBranch: child.pipelineBranch,
        baseSha: child.baseSha,
        state: child.state,
        currentStage: child.currentStage,
      })),
      children.map((child, ordinal) => ({
        originalRequest: parent.originalRequest,
        refinedObjective: child.objective,
        priority: "high",
        taskType: "standard",
        projectTarget: { mode: "explicit", projectId: child.projectId },
        resolvedProjectId: child.projectId,
        parentWorkItemId: parent.workItemId,
        phase: null,
        childOrdinal: ordinal,
        pipelineBranch: `task/${materialized[ordinal]!.workItemId}`,
        baseSha: PROVIDER_SHA,
        state: "implementing",
        currentStage: "implementation",
      }))
    );

    for (const [ordinal, child] of materialized.entries()) {
      const declaration = children[ordinal]!;
      const { plan, node } = childPlan(fixture.board, child);
      assert.deepEqual(
        {
          revision: plan.revision,
          objective: plan.objective,
          acceptanceCriteria: plan.acceptanceCriteria,
          changeShape: plan.changeShape,
          tier: plan.tier,
          declaredScope: plan.declaredScope,
          criterionChecks: plan.criterionChecks,
          children: plan.children,
          state: plan.state,
          confirmedBy: plan.confirmedBy,
        },
        {
          revision: 1,
          objective: declaration.objective,
          acceptanceCriteria: declaration.acceptanceCriteria,
          changeShape: "feature",
          tier: "standard",
          declaredScope: declaration.declaredScope,
          criterionChecks: [],
          children: null,
          state: "confirmed",
          confirmedBy: "human:alice",
        }
      );
      assert.deepEqual(
        {
          objective: node.objective,
          acceptanceCriteria: node.acceptanceCriteria,
          dependencyNodeIds: node.dependencyNodeIds,
          stageTemplate: node.stageTemplate,
          state: node.state,
          currentStage: node.currentStage,
        },
        {
          objective: declaration.objective,
          acceptanceCriteria: declaration.acceptanceCriteria,
          dependencyNodeIds: [],
          stageTemplate: ["implementation", "testing", "verification"],
          state: "active",
          currentStage: "implementation",
        }
      );
      assert.deepEqual(
        fixture.board.workItemAudit(child.workItemId).gateActions.map((action) => ({
          gate: action.gate,
          actorId: action.actorId,
          planRevisionId: action.planRevisionId,
          refId: action.refId,
        })),
        [
          {
            gate: "plan_confirm",
            actorId: "human:alice",
            planRevisionId: plan.planRevisionId,
            refId: parent.workItemId,
          },
        ]
      );
    }

    const expectedDependency: WorkItemDependency = {
      workItemId: materialized[1]!.workItemId,
      dependsOnWorkItemId: materialized[0]!.workItemId,
    };
    assert.deepEqual(fixture.board.dependenciesFor(materialized[0]!.workItemId), []);
    assert.deepEqual(fixture.board.dependenciesFor(materialized[1]!.workItemId), [expectedDependency]);

    const listProjection = fixture.board
      .listWorkItems()
      .filter((item) => item.parentWorkItemId === parent.workItemId)
      .toSorted((left, right) => left.childOrdinal! - right.childOrdinal!);
    assert.deepEqual(
      listProjection.map((item) => ({
        parentWorkItemId: item.parentWorkItemId,
        phase: item.phase,
        childOrdinal: item.childOrdinal,
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
  } finally {
    fixture.board.close();
  }
});

test("children in one project use their declared repositories and repository HEADs", async () => {
  const primaryPath = "/repos/catalog-api";
  const secondaryPath = "/repos/catalog-worker";
  const gitCalls: string[][] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git: (arguments_) => {
      gitCalls.push([...arguments_]);
      const repositoryIndex = arguments_.indexOf("-C");
      return `${arguments_[repositoryIndex + 1] === secondaryPath ? CONSUMER_SHA : PROVIDER_SHA}\n`;
    },
  });
  const project = fixture.board.createProject({
    name: "Catalog",
    description: "Owns two independently deployable repositories.",
    repoPath: primaryPath,
  });
  const secondaryRepositoryId = "repository-catalog-worker";
  const repositoryDb = new DatabaseSync(fixture.path);
  let primaryRepositoryId: string;
  try {
    primaryRepositoryId = String(
      repositoryDb
        .prepare("SELECT repository_id FROM repositories WHERE project_id=? AND is_primary=1")
        .get(project.projectId)?.repository_id
    );
    repositoryDb
      .prepare(
        `
      INSERT INTO repositories(
        repository_id,project_id,name,path,is_primary,version,created_at,updated_at
      ) VALUES (?,?,?, ?,0,1,?,?)
    `
      )
      .run(
        secondaryRepositoryId,
        project.projectId,
        "Catalog worker",
        secondaryPath,
        "2026-09-07T12:00:00.000Z",
        "2026-09-07T12:00:00.000Z"
      );
  } finally {
    repositoryDb.close();
  }
  const children: readonly DeclaredChild[] = [
    {
      key: "catalog-api",
      objective: "Change the catalog API.",
      projectId: project.projectId,
      repositoryId: primaryRepositoryId,
      declaredScope: ["src/api"],
      acceptanceCriteria: ["The API change is independently mergeable."],
    },
    {
      key: "catalog-worker",
      objective: "Change the catalog worker.",
      projectId: project.projectId,
      repositoryId: secondaryRepositoryId,
      declaredScope: ["src/worker"],
      acceptanceCriteria: ["The worker change is independently mergeable."],
    },
  ];
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    project.projectId,
    children,
    "feature",
    "same-project-multiple-repositories"
  );

  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const materialized = fixture.board.listChildren(parent.workItemId);
    assert.equal(materialized[0]?.baseSha, PROVIDER_SHA);
    assert.equal(materialized[1]?.baseSha, CONSUMER_SHA);
    assert.notEqual(materialized[0]?.baseSha, materialized[1]?.baseSha);
    const stored = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.deepEqual(
        stored
          .prepare(
            `
          SELECT repository_id,base_sha
          FROM work_items
          WHERE parent_work_item_id=?
          ORDER BY child_ordinal
        `
          )
          .all(parent.workItemId)
          .map((row) => ({ ...row })),
        [
          { repository_id: primaryRepositoryId, base_sha: PROVIDER_SHA },
          { repository_id: secondaryRepositoryId, base_sha: CONSUMER_SHA },
        ]
      );
    } finally {
      stored.close();
    }
    assert.deepEqual(gitCalls.map((arguments_) => arguments_[arguments_.indexOf("-C") + 1]).toSorted(), [
      primaryPath,
      secondaryPath,
    ]);
  } finally {
    fixture.board.close();
  }
});

test("confirmation rejects a child repository owned by another project", async () => {
  let gitCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git: () => {
      gitCalls += 1;
      return `${PROVIDER_SHA}\n`;
    },
  });
  const otherProject = fixture.board.createProject({
    name: "Foreign repository owner",
    description: "Owns a repository the child must not target.",
    repoPath: "/repos/foreign-owner",
  });
  const repositoryDb = new DatabaseSync(fixture.path, { readOnly: true });
  let foreignRepositoryId: string;
  try {
    foreignRepositoryId = String(
      repositoryDb
        .prepare("SELECT repository_id FROM repositories WHERE project_id=? AND is_primary=1")
        .get(otherProject.projectId)?.repository_id
    );
  } finally {
    repositoryDb.close();
  }
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "foreign-target",
        objective: "Attempt to use another project's repository.",
        projectId: fixture.project.projectId,
        repositoryId: foreignRepositoryId,
        declaredScope: ["src/foreign-target"],
        acceptanceCriteria: ["Cross-project repository targeting is rejected."],
      },
    ],
    "feature",
    "cross-project-repository-rejected"
  );

  try {
    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "WORKFLOW_INVALID" &&
        error.message ===
          `workflowPlan child foreign-target repositoryId does not belong to project ${fixture.project.projectId}`
    );
    assert.equal(gitCalls, 0);
    assert.equal(fixture.board.listChildren(parent.workItemId).length, 0);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "plan_approval");
  } finally {
    fixture.board.close();
  }
});

test("pre-confirmed children stay out of intake planning after updates and manager registration", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "locked-child",
        objective: "Keep the declared repository identity.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/locked-child"],
        acceptanceCriteria: ["The child remains attached to its declared project."],
      },
    ],
    "feature",
    "preconfirmed-child-intake-lock"
  );

  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const [child] = fixture.board.listChildren(parent.workItemId);
    assert.ok(child);

    const updated = fixture.board.updateWorkItem(child.workItemId, {
      version: child.version,
      priority: "urgent",
    });
    assert.equal(updated.priority, "urgent");
    assert.equal(fixture.board.startWorkItemPlanning(child.workItemId), null);

    fixture.board.createAgent(fixture.project.projectId, {
      agentId: "post-decomposition-manager",
      role: "manager",
      area: "decomposition follow-up",
      mission: "Register after children already have approved plans.",
      model: "claude-haiku",
      token: "post-decomposition-manager-token-0123456789",
    });

    const stillPreconfirmed = fixture.board.requireWorkItem(child.workItemId);
    assert.equal(stillPreconfirmed.state, "implementing");
    assert.equal(stillPreconfirmed.currentStage, "implementation");
    assert.equal(stillPreconfirmed.planningTaskId, null);
  } finally {
    fixture.board.close();
  }
});

test("pre-confirmed children cannot be retargeted while queued", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  const other = fixture.board.createProject({
    name: "Retarget destination",
    description: "Must never receive a pre-confirmed child.",
    repoPath: "/repos/retarget-destination",
  });
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "target-locked-child",
        objective: "Keep the declared repository identity.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/target-locked-child"],
        acceptanceCriteria: ["The child remains attached to its declared project."],
      },
    ],
    "feature",
    "preconfirmed-child-target-lock"
  );

  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const [child] = fixture.board.listChildren(parent.workItemId);
    assert.ok(child);
    assert.throws(
      () =>
        fixture.board.updateWorkItem(child.workItemId, {
          version: child.version,
          projectTarget: { mode: "explicit", projectId: other.projectId },
        }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "WORK_ITEM_TARGET_LOCKED"
    );
  } finally {
    fixture.board.close();
  }
});

test("confirming a phased blast-radius plan preserves project, phase, ordinal, dependency, and repository identity", async () => {
  const gitCalls: string[][] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git: (arguments_) => {
      gitCalls.push([...arguments_]);
      const repositoryIndex = arguments_.indexOf("-C");
      const repository = repositoryIndex < 0 ? null : arguments_[repositoryIndex + 1];
      return `${repository === "/repos/consumer" ? CONSUMER_SHA : PROVIDER_SHA}\n`;
    },
  });
  const consumer = fixture.board.createProject({
    name: "Consumer",
    description: "Consumes the provider interface.",
    repoPath: "/repos/consumer",
  });
  const provider = fixture.board.createProject({
    name: "Provider",
    description: "Owns the provider interface.",
    repoPath: "/repos/provider",
  });
  const children: readonly DeclaredChild[] = [
    {
      key: "expand-interface",
      objective: "Expand the provider interface.",
      projectId: provider.projectId,
      declaredScope: ["docs/interface.md"],
      acceptanceCriteria: ["The additive interface is published."],
      phase: "expand",
      splitBy: "phase",
    },
    {
      key: "migrate-consumer",
      objective: "Migrate the consumer to the expanded interface.",
      projectId: consumer.projectId,
      declaredScope: ["src/client"],
      acceptanceCriteria: ["The consumer uses the expanded interface."],
      phase: "migrate",
      dependsOn: ["expand-interface"],
      splitBy: "consumer",
    },
    {
      key: "contract-interface",
      objective: "Remove the legacy provider interface.",
      projectId: provider.projectId,
      declaredScope: ["docs/interface.md"],
      acceptanceCriteria: ["The legacy interface is removed."],
      phase: "contract",
      dependsOn: ["migrate-consumer"],
      splitBy: "phase",
    },
  ];
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    provider.projectId,
    children,
    "blast_radius",
    "phased-blast-radius-confirm"
  );

  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const materialized = fixture.board.listChildren(parent.workItemId);
    assert.deepEqual(
      materialized.map((child) => ({
        projectId: child.resolvedProjectId,
        phase: child.phase,
        ordinal: child.childOrdinal,
        branch: child.pipelineBranch,
        baseSha: child.baseSha,
      })),
      children.map((child, ordinal) => ({
        projectId: child.projectId,
        phase: child.phase,
        ordinal,
        branch: `task/${materialized[ordinal]!.workItemId}`,
        baseSha: child.projectId === consumer.projectId ? CONSUMER_SHA : PROVIDER_SHA,
      }))
    );
    assert.deepEqual(
      materialized.map((child) => fixture.board.dependenciesFor(child.workItemId)),
      [
        [],
        [
          {
            workItemId: materialized[1]!.workItemId,
            dependsOnWorkItemId: materialized[0]!.workItemId,
          },
        ],
        [
          {
            workItemId: materialized[2]!.workItemId,
            dependsOnWorkItemId: materialized[1]!.workItemId,
          },
        ],
      ]
    );
    for (const child of materialized) {
      const { plan } = childPlan(fixture.board, child);
      assert.equal(plan.changeShape, "feature");
      assert.equal(plan.tier, "standard");
      assert.deepEqual(plan.criterionChecks, []);
      assert.doesNotThrow(() => validateMaterializedChildPlan(fixture.board, child));
    }
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "coordinating");
    assert.deepEqual(gitCalls.map((arguments_) => arguments_[arguments_.indexOf("-C") + 1]).sort(), [
      "/repos/consumer",
      "/repos/provider",
      "/repos/provider",
    ]);

    const expand = materialized[0]!;
    const expandNode = childPlan(fixture.board, expand).node;
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("UPDATE work_items SET state='implementing',current_stage='implementation' WHERE work_item_id=?").run(
        expand.workItemId
      );
      db.prepare("UPDATE work_nodes SET state='ready',current_stage='implementation' WHERE node_id=?").run(
        expandNode.nodeId
      );
    } finally {
      db.close();
    }
    fixture.board.reconcileWorkflows(provider.projectId);
    const implementationTask = fixture.board
      .snapshot(provider.projectId)
      .tasks.find((task) => task.title === `implementation: ${expandNode.title}`);
    assert.ok(implementationTask?.assignedAgentId);
    const claim = fixture.board.claimRun(implementationTask.assignedAgentId, {
      claimId: "claim-normalized-blast-radius-child",
      messageCursor: null,
    });
    assert.ok(claim?.context.workflow?.pipeline);
    assert.equal(claim.context.workflow.pipeline.changeShape, "feature");
    assert.equal(claim.context.workflow.pipeline.tier, "standard");
  } finally {
    fixture.board.close();
  }
});

test("children default nullable parent metadata, cap titles, and claim with a complete leaf pipeline record", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  configureChildPipeline(fixture.board);
  const objective = `Implement a bounded child title ${"x".repeat(300)}`;
  const parent = fixture.board.createWorkItem(
    workItemRequest({
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    "defaulted-child-plan-record"
  ).workItem;
  const workflow = fixture.board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId: fixture.project.projectId,
    objective: "Coordinate a child from a parent without an explicit tier.",
    assumptions: [],
    acceptanceCriteria: ["The child has a valid pipeline record."],
    changeShape: "feature",
    declaredScope: ["coordination"],
    criterionChecks: [{ criterion: "The child has a valid pipeline record.", check: "npm run parent-check" }],
    children: [
      {
        key: "defaulted-child",
        objective,
        projectId: fixture.project.projectId,
        declaredScope: ["src/defaulted-child"],
        acceptanceCriteria: ["The child can be claimed without database corruption."],
      },
    ],
    skillIds: [],
    nodes: [
      {
        nodeId: "defaulted-parent-node",
        title: "Coordinate the defaulted child",
        objective: "Coordinate only.",
        acceptanceCriteria: ["The child is materialized."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      },
    ],
  });
  const revision = workflow.plans.find((plan) => plan.workItemId === parent.workItemId);
  assert.ok(revision);

  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const [child] = fixture.board.listChildren(parent.workItemId);
    assert.ok(child);
    const { plan, node } = childPlan(fixture.board, child);
    assert.equal(plan.changeShape, "feature");
    assert.equal(plan.tier, "standard");
    assert.deepEqual(plan.criterionChecks, []);
    assert.equal(node.title.length, 256);
    assert.doesNotThrow(() => validateMaterializedChildPlan(fixture.board, child));

    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("UPDATE work_items SET state='implementing',current_stage='implementation' WHERE work_item_id=?").run(
        child.workItemId
      );
      db.prepare("UPDATE work_nodes SET state='ready',current_stage='implementation' WHERE node_id=?").run(node.nodeId);
    } finally {
      db.close();
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-defaulted-materialized-child",
      messageCursor: null,
    });
    assert.ok(claim?.context.workflow?.pipeline);
    assert.equal(claim.context.workflow.pipeline.changeShape, "feature");
    assert.equal(claim.context.workflow.pipeline.tier, "standard");
  } finally {
    fixture.board.close();
  }
});

test("confirm revalidates the persisted declaration against the resolved parent and rolls back every write", async () => {
  let gitCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git: () => {
      gitCalls += 1;
      return `${PROVIDER_SHA}\n`;
    },
  });
  const other = fixture.board.createProject({
    name: "Other",
    description: "A second valid project used to expose the provider mismatch.",
    repoPath: "/repos/other",
  });
  const invalid: readonly DeclaredChild[] = [
    {
      key: "expand-wrong-provider",
      objective: "Expand in the wrong provider.",
      projectId: other.projectId,
      declaredScope: ["docs/interface.md"],
      acceptanceCriteria: ["The additive interface is published."],
      phase: "expand",
      splitBy: "phase",
    },
    {
      key: "migrate-parent",
      objective: "Migrate the actual parent project as if it were a consumer.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/client"],
      acceptanceCriteria: ["The actual parent consumes the interface."],
      phase: "migrate",
      dependsOn: ["expand-wrong-provider"],
      splitBy: "consumer",
    },
    {
      key: "contract-wrong-provider",
      objective: "Contract in the wrong provider.",
      projectId: other.projectId,
      declaredScope: ["docs/interface.md"],
      acceptanceCriteria: ["The legacy interface is removed."],
      phase: "contract",
      dependsOn: ["migrate-parent"],
      splitBy: "phase",
    },
  ];
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    invalid,
    "blast_radius",
    "invalid-resolved-parent-confirm"
  );

  try {
    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "WORKFLOW_INVALID" &&
        error.message === "expand and contract children must use the parent project"
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT state FROM plan_revisions WHERE plan_revision_id=?").get(revision.planRevisionId)?.state,
        "proposed"
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE parent_work_item_id=?").get(parent.workItemId)
          ?.count,
        0
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_item_dependencies").get()?.count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM gate_actions").get()?.count, 0);
    } finally {
      db.close();
    }
    const unchanged = fixture.board.requireWorkItem(parent.workItemId);
    assert.equal(unchanged.state, "plan_approval");
    assert.equal(unchanged.pipelineBranch, null);
    assert.equal(unchanged.baseSha, null);
    assert.equal(gitCalls, 0);
  } finally {
    fixture.board.close();
  }
});

test("confirm reports an invalid project repository path with a project-naming 409", async () => {
  const fixture = await boardFixture(undefined, undefined, {
    git: (arguments_) => {
      if (arguments_.includes("/not/a/git/repository")) throw new Error("fatal: cannot change directory");
      return `${PROVIDER_SHA}\n`;
    },
  });
  const invalidProject = fixture.board.createProject({
    name: "Invalid repository project",
    description: "Its compatibility fallback must never leak into a raw Git error.",
    repoPath: "/not/a/git/repository",
  });
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "invalid-repository-child",
        objective: "Reject this child before materialization.",
        projectId: invalidProject.projectId,
        declaredScope: ["src/invalid-repository"],
        acceptanceCriteria: ["The repository failure is typed."],
      },
    ],
    "feature",
    "invalid-project-repository-path"
  );

  try {
    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "PROJECT_REPO_PATH_INVALID" &&
        error.message === "Project Invalid repository project does not have a valid Git repository path"
    );
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "plan_approval");
    assert.equal(fixture.board.listChildren(parent.workItemId).length, 0);
  } finally {
    fixture.board.close();
  }
});

test("confirm revalidates persisted Expand and Contract interface publication scope", async () => {
  let gitCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git: () => {
      gitCalls += 1;
      return `${PROVIDER_SHA}\n`;
    },
  });
  const consumer = fixture.board.createProject({
    name: "Scope revalidation consumer",
    description: "Consumes a provider interface only after publication scope is valid.",
    repoPath: "/repos/scope-revalidation-consumer",
  });
  const valid: readonly DeclaredChild[] = [
    {
      key: "expand",
      objective: "Publish the additive provider interface.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/provider", "docs/interface.md"],
      acceptanceCriteria: ["The additive interface is published."],
      phase: "expand",
      splitBy: "phase",
    },
    {
      key: "migrate",
      objective: "Migrate the consumer.",
      projectId: consumer.projectId,
      declaredScope: ["src/consumer"],
      acceptanceCriteria: ["The consumer uses the additive interface."],
      phase: "migrate",
      dependsOn: ["expand"],
      splitBy: "consumer",
    },
    {
      key: "contract",
      objective: "Remove the legacy provider interface.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/provider", "docs/interface.md"],
      acceptanceCriteria: ["The legacy interface is removed."],
      phase: "contract",
      dependsOn: ["migrate"],
      splitBy: "phase",
    },
  ];
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    valid,
    "blast_radius",
    "persisted-interface-scope-revalidation"
  );

  try {
    const invalid = valid.map((child) =>
      child.phase === "contract" ? { ...child, declaredScope: ["src/provider"] } : child
    );
    const db = new DatabaseSync(fixture.path);
    try {
      assert.equal(
        Number(
          db
            .prepare(
              `
        UPDATE plan_revisions SET children=? WHERE plan_revision_id=? AND state='proposed'
      `
            )
            .run(JSON.stringify(invalid), revision.planRevisionId).changes
        ),
        1
      );
    } finally {
      db.close();
    }

    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "WORKFLOW_INVALID" &&
        /contract.*docs\/interface\.md/u.test(error.message)
    );
    assert.equal(
      fixture.board
        .projectWorkflow(fixture.project.projectId)
        .plans.find((plan) => plan.planRevisionId === revision.planRevisionId)?.state,
      "proposed"
    );
    assert.equal(fixture.board.listChildren(parent.workItemId).length, 0);
    assert.equal(gitCalls, 0);
  } finally {
    fixture.board.close();
  }
});

test("child pipeline executor drift rejects before Git or confirmation writes", async () => {
  let gitCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git: () => {
      gitCalls += 1;
      return `${PROVIDER_SHA}\n`;
    },
  });
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "drift-child",
        objective: "Run only with compatible child executors.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/drift-child"],
        acceptanceCriteria: ["The v2 child pipeline is executable."],
      },
    ],
    "feature",
    "child-executor-drift"
  );
  const compatible = fixture.board.getAutomationConfiguration();
  fixture.board.updateAutomationConfiguration(
    automationConfigurationRequest({
      version: compatible.version,
      agentTypes: compatible.agentTypes,
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: DECOMPOSITION_IMPLEMENTER.agentTypeId },
        verification: { kind: "agent_type", agentTypeId: DECOMPOSITION_REVIEWER.agentTypeId },
      }),
    })
  );

  try {
    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "TASK_BOARD_PIPELINE_EXECUTOR_DRIFT"
    );
    assert.equal(gitCalls, 0);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "plan_approval");
    assert.equal(fixture.board.listChildren(parent.workItemId).length, 0);
    assert.equal(
      fixture.board
        .projectWorkflow(fixture.project.projectId)
        .plans.find((plan) => plan.planRevisionId === revision.planRevisionId)?.state,
      "proposed"
    );
  } finally {
    fixture.board.close();
  }
});

test("a failure after the first child write rolls back the entire materialization transaction", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "rollback-first",
        objective: "Write first, then roll back.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/rollback-first"],
        acceptanceCriteria: ["No partial child survives."],
      },
      {
        key: "rollback-second",
        objective: "Trigger the forced materialization failure.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/rollback-second"],
        acceptanceCriteria: ["The transaction aborts."],
        dependsOn: ["rollback-first"],
      },
    ],
    "feature",
    "mid-materialization-rollback"
  );
  const triggerDb = new DatabaseSync(fixture.path);
  try {
    triggerDb.exec(`
      CREATE TRIGGER fail_second_materialized_child
      BEFORE INSERT ON work_items
      WHEN NEW.parent_work_item_id='${parent.workItemId}' AND NEW.child_ordinal=1
      BEGIN
        SELECT RAISE(ABORT, 'forced second child failure');
      END;
    `);
  } finally {
    triggerDb.close();
  }

  try {
    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      /forced second child failure/u
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.deepEqual(
        {
          ...db
            .prepare(
              `
        SELECT state,confirmed_by,confirmed_at
        FROM plan_revisions
        WHERE plan_revision_id=?
      `
            )
            .get(revision.planRevisionId),
        },
        {
          state: "proposed",
          confirmed_by: null,
          confirmed_at: null,
        }
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE parent_work_item_id=?").get(parent.workItemId)
          ?.count,
        0
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM plan_revisions WHERE work_item_id<>?").get(parent.workItemId)?.count,
        0
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM work_nodes WHERE plan_revision_id<>?").get(revision.planRevisionId)
          ?.count,
        0
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM gate_actions").get()?.count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_item_dependencies").get()?.count, 0);
    } finally {
      db.close();
    }
    const unchanged = fixture.board.requireWorkItem(parent.workItemId);
    assert.equal(unchanged.state, "plan_approval");
    assert.equal(unchanged.pipelineBranch, null);
    assert.equal(unchanged.baseSha, null);
  } finally {
    fixture.board.close();
  }
});

test("a coordinating parent with a pipeline-shaped node stays branchless and pipeline summary skips Git", async () => {
  let gitCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git: () => {
      gitCalls += 1;
      return `${PROVIDER_SHA}\n`;
    },
  });
  configureChildPipeline(fixture.board);
  const parent = fixture.board.createWorkItem(
    workItemRequest({
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    "branchless-pipeline-shaped-parent"
  ).workItem;
  const workflow = fixture.board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId: fixture.project.projectId,
    objective: "Coordinate children without creating a parent branch.",
    assumptions: [],
    acceptanceCriteria: ["Only child work receives pipeline identity."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["coordination"],
    children: [
      {
        key: "branch-owning-child",
        objective: "Own the only real pipeline branch.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/branch-owning-child"],
        acceptanceCriteria: ["The child owns its branch."],
      },
    ],
    skillIds: [],
    nodes: [
      {
        nodeId: "pipeline-shaped-parent-node",
        title: "Do not execute this parent node",
        objective: "Represent coordination only.",
        acceptanceCriteria: ["No parent pipeline is created."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
  });
  const revision = workflow.plans.find((plan) => plan.workItemId === parent.workItemId);
  assert.ok(revision);

  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const coordinating = fixture.board.requireWorkItem(parent.workItemId);
    assert.equal(coordinating.state, "coordinating");
    assert.equal(coordinating.pipelineBranch, null);
    assert.equal(coordinating.baseSha, null);
    const callsAfterConfirm = gitCalls;
    assert.throws(
      () => fixture.board.pipelineSummary(parent.workItemId),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.message === "Work item has no pipeline branch"
    );
    assert.equal(gitCalls, callsAfterConfirm);
  } finally {
    fixture.board.close();
  }
});

test("workflow reconciliation ignores a coordinating parent's ready node", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  const { parent, revision } = proposeDecomposedPlan(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "only-child",
        objective: "Execute the only child.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/child"],
        acceptanceCriteria: ["The child succeeds."],
      },
    ],
    "feature",
    "coordinating-reconciler-guard"
  );

  try {
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(
        `
        UPDATE work_nodes
        SET state='ready',current_stage='verification'
        WHERE plan_revision_id=?
      `
      ).run(revision.planRevisionId);
    } finally {
      db.close();
    }

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const parentNode = fixture.board
      .projectWorkflow(fixture.project.projectId)
      .nodes.find((node) => node.planRevisionId === revision.planRevisionId);
    assert.deepEqual(
      { state: parentNode?.state, currentStage: parentNode?.currentStage },
      {
        state: "ready",
        currentStage: "verification",
      }
    );
    assert.equal(
      fixture.board
        .snapshot(fixture.project.projectId)
        .tasks.some((task) => task.title === "verification: Coordinate declared work"),
      false
    );
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "coordinating");
  } finally {
    fixture.board.close();
  }
});

test("hazardous decomposition coordinates a branchless parent and starts Design on its ready child", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  configureChildPipeline(fixture.board);
  const parent = fixture.board.createWorkItem(
    workItemRequest({
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    "hazardous-decomposition-tier"
  ).workItem;
  const workflow = fixture.board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId: fixture.project.projectId,
    objective: "Design the hazardous split before child execution.",
    assumptions: [],
    acceptanceCriteria: ["The parent design covers the declared child."],
    changeShape: "blast_radius",
    tier: "hazardous",
    declaredScope: ["coordination"],
    children: [
      {
        key: "hazardous-child",
        objective: "Implement the parent-approved hazardous design.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/hazardous-child"],
        acceptanceCriteria: ["The hazardous design is implemented."],
        splitBy: "consumer",
      },
    ],
    skillIds: [],
    nodes: [
      {
        nodeId: "hazardous-decomposition-parent",
        title: "Design hazardous decomposition",
        objective: "Produce the parent-level hazardous design.",
        acceptanceCriteria: ["All hazardous failure points are covered."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
  });
  const revision = workflow.plans.find((plan) => plan.workItemId === parent.workItemId);
  assert.ok(revision);

  try {
    const confirmation = fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmation.outcome, undefined);
    const coordinating = fixture.board.requireWorkItem(parent.workItemId);
    assert.equal(coordinating.state, "coordinating");
    assert.equal(coordinating.pipelineBranch, null);
    assert.equal(coordinating.baseSha, null);
    assert.equal(
      fixture.board
        .snapshot(fixture.project.projectId)
        .tasks.filter((task) => task.title.startsWith("Design workflow:")).length,
      1
    );
    const [child] = fixture.board.listChildren(parent.workItemId);
    assert.ok(child);
    assert.equal(child.state, "designing");
    const { plan, node } = childPlan(fixture.board, child);
    assert.equal(plan.changeShape, "feature");
    assert.equal(plan.tier, "hazardous");
    assert.equal(node.state, "pending");
    assert.equal(node.currentStage, null);
    assert.doesNotThrow(() => validateMaterializedChildPlan(fixture.board, child));
  } finally {
    fixture.board.close();
  }
});

test("hazardous decomposition with a non-pipeline parent node materializes children instead of parking", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${PROVIDER_SHA}\n` });
  configureChildPipeline(fixture.board);
  const parent = fixture.board.createWorkItem(
    workItemRequest({
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    "hazardous-nonpipeline-decomposition"
  ).workItem;
  const workflow = fixture.board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId: fixture.project.projectId,
    objective: "Coordinate hazardous child work without a parent pipeline.",
    assumptions: [],
    acceptanceCriteria: ["The child is retained and coordinated."],
    changeShape: "blast_radius",
    tier: "hazardous",
    declaredScope: ["coordination"],
    children: [
      {
        key: "hazardous-nonpipeline-child",
        objective: "Design and implement the hazardous leaf.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/hazardous-nonpipeline-child"],
        acceptanceCriteria: ["The hazardous leaf completes safely."],
        splitBy: "consumer",
      },
    ],
    skillIds: [],
    nodes: [
      {
        nodeId: "hazardous-nonpipeline-parent-node",
        title: "Coordinate hazardous leaf",
        objective: "Coordinate only.",
        acceptanceCriteria: ["The child is not discarded."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      },
    ],
  });
  const revision = workflow.plans.find((plan) => plan.workItemId === parent.workItemId);
  assert.ok(revision);

  try {
    const confirmation = fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmation.outcome, undefined);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "coordinating");
    const [child] = fixture.board.listChildren(parent.workItemId);
    assert.ok(child);
    assert.equal(child.state, "designing");
    assert.equal(childPlan(fixture.board, child).plan.tier, "hazardous");
  } finally {
    fixture.board.close();
  }
});
