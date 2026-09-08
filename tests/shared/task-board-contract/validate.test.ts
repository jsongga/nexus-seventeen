import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_GAP_REPORT_MAX_CHARACTERS,
  AGENT_ROLES,
  AUTOMATION_STAGE_ALLOWED_ROLES,
  EVALUATOR_PROFILES,
  GATE_KINDS,
  IDENTIFIER_PATTERN,
  PLAN_CHANGE_SHAPES,
  PLAN_TIERS,
  REVIEW_FINDING_DRAFT_MAX_ITEMS,
  REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH,
  STAGE_HANDOFF_OUTCOMES,
  TASK_KINDS,
  TASK_BOARD_API_VERSION,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  WORKFLOW_STAGES,
  WORK_ITEM_PHASES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_TASK_TYPES,
  type VerifyAttempt,
} from "#shared/task-board-contract";
import {
  BROWSER_SCALAR_MESSAGES,
  boundedClaimText,
  claimEstimateMinutes,
  ContractValidationError,
  NAMED_EXACT_MESSAGES,
  PATH_EXACT_MESSAGES,
  exact,
  identifier,
  parseBoardAutomationUpdate,
  parseBoardSnapshotEntity,
  parseBoardClaim,
  parseBoardCreateAgent,
  parseBoardCreateTaskPhase,
  parseBoardCreateWorkItem,
  parseBoardIdentifier,
  parseBoardSettle,
  parseBoardUpdateRepository,
  parseBoardUpdateTask,
  parseBoardUpdateTaskPhase,
  parseClaimRunResult,
  parseGateAction,
  parsePlanEntity,
  parseTaskEntity,
  parseWorkItemEntity,
  parseWorkerAgentContext,
  parseWorkerAgentRunOutcome,
  positiveClaimInteger,
  prose,
  projectAgentTaskPhase,
  timestamp,
} from "#shared/task-board-contract/validate";

const NOW = "2026-08-09T20:00:00.000Z";

const browserProfile = {
  exact: false,
  identifiers: "string",
  projection: "browser",
  scalarMessages: BROWSER_SCALAR_MESSAGES,
  tolerantEnums: true,
} as const;

function taskEntity(status: string): Record<string, unknown> {
  return {
    apiVersion: TASK_BOARD_API_VERSION,
    taskId: "task-one",
    projectId: "project-one",
    parentTaskId: null,
    kind: "work",
    requiredRole: null,
    requiresReview: false,
    title: "Validate browser parsing",
    objective: "Keep future task states visible.",
    acceptanceCriteria: "Unknown states are inert.",
    workspaceRefs: [],
    status,
    assignedAgentId: null,
    assignedRole: null,
    expectedAgentMinutes: null,
    estimateRecordedAt: null,
    orderKey: 0,
    phases: [],
    startedAt: null,
    expectedCompletedAt: null,
    endedAt: null,
    result: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workItemEntity(state: string): Record<string, unknown> {
  return {
    apiVersion: TASK_BOARD_API_VERSION,
    workItemId: "work-item-one",
    originalRequest: "Keep future work-item states visible.",
    refinedObjective: null,
    priority: "normal",
    taskType: "standard",
    projectTarget: { mode: "auto" },
    resolvedProjectId: null,
    parentWorkItemId: null,
    phase: null,
    childOrdinal: null,
    planningTaskId: null,
    state,
    currentStage: "refinement",
    createdBy: "human:operator",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    endedAt: null,
    cancelledReason: null,
    archivedAt: null,
  };
}

function boardSnapshotEntity(repositories?: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    apiVersion: TASK_BOARD_API_VERSION,
    project: {
      apiVersion: TASK_BOARD_API_VERSION,
      projectId: "project-one",
      name: "One product",
      description: "A product spanning repositories.",
      repoPath: "/repos/primary",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...(repositories === undefined ? {} : { repositories }),
    agents: [],
    tasks: [],
    openQuestions: [],
    recentQuestions: [],
    recentRuns: [],
    recentInterrupts: [],
    recentEvents: [],
  };
}

function assertAcceptedSet(expected: readonly string[], validate: (value: string) => unknown): void {
  const candidates = [...expected, "not_a_contract_member"];
  const accepted = candidates.filter((candidate) => {
    try {
      validate(candidate);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(accepted, [...expected]);
}

function thrownMessage(validate: () => unknown): string {
  try {
    validate();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("Expected validation to throw");
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 1,
    projectId: "project-one",
    agentId: "agent-one",
    taskId: "task-one",
    intake: false,
    design: false,
    mission: { role: "engineer", area: "Checkout", mission: "Keep checkout dependable." },
    projectMemory: "Checkout uses idempotency keys.",
    task: {
      kind: "work",
      requiredRole: null,
      title: "Inspect checkout",
      objective: "Find the retry boundary.",
      acceptanceCriteria: "The boundary is verified.",
      version: 1,
      expectedAgentMinutes: null,
      phases: [],
    },
    areaMemory: [],
    parentEvidence: null,
    messagesSinceCursor: null,
    nextMessageCursor: 0,
    messages: [],
    triggerQuestion: null,
    openQuestions: [],
    workspaceRefs: [],
    workflow: null,
    ...overrides,
  };
}

function outcome(handoff: unknown = null, workflowPlan: unknown = null): unknown {
  return {
    status: "completed",
    outputs: [{ type: "result", body: "Done." }],
    expectedAgentMinutes: null,
    phases: [],
    detail: "Done.",
    handoff,
    workflowPlan,
  };
}

function pipelinePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective: "Add the first local pipeline contract.",
    assumptions: ["The repository remains local-first."],
    acceptanceCriteria: ["The pipeline contract round-trips."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/shared", "tests/shared"],
    nonGoals: ["Do not add remote delivery."],
    mechanicalPortions: ["Add nullable schema columns."],
    blockingQuestions: [
      {
        question: "Should legacy plans remain valid?",
        recommendedDefault: "Yes, keep every new field optional.",
      },
    ],
    criterionChecks: [
      {
        criterion: "The shared contract tests pass.",
        check: "npm run test:runtime",
      },
    ],
    nodes: [
      {
        nodeId: "node-one",
        title: "Implement the pipeline contract",
        objective: "Add and verify the shared contract.",
        acceptanceCriteria: ["The pipeline contract round-trips."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "verification"],
      },
    ],
    ...overrides,
  };
}

function stages(): Array<Readonly<{ stage: string; executor: Readonly<{ kind: string }> }>> {
  return WORK_ITEM_STAGES.map((stage) => ({
    stage,
    executor: { kind: stage === "human_review" ? "human" : "disabled" },
  }));
}

test("shared claim projection validators preserve the worker boundary", () => {
  assert.equal(boundedClaimText("  ready  ", "claim.title", 20), "ready");
  assert.equal(boundedClaimText("a".repeat(30), "claim.title", 20), "aaaa\n[truncated]");
  assert.equal(positiveClaimInteger(2, "claim.version"), 2);
  assert.throws(() => positiveClaimInteger(0, "claim.version"), /claim\.version is invalid/u);
  assert.equal(claimEstimateMinutes(null, "claim.estimate"), null);
  assert.equal(claimEstimateMinutes(30, "claim.estimate"), 30);
  assert.throws(() => claimEstimateMinutes(17, "claim.estimate"), /claim\.estimate is invalid/u);
  assert.deepEqual(
    projectAgentTaskPhase(
      {
        apiVersion: TASK_BOARD_API_VERSION,
        phaseId: "phase-one",
        projectId: "project-one",
        taskId: "task-one",
        title: "  Implement contract  ",
        stage: "execution",
        status: "pending",
        parallelGroup: null,
        orderKey: 1,
        startedAt: null,
        endedAt: null,
        version: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      "project-one",
      "task-one",
      "claim.phase"
    ),
    {
      phaseId: "phase-one",
      title: "Implement contract",
      stage: "execution",
      status: "pending",
      parallelGroup: null,
      orderKey: 1,
      version: 2,
    }
  );
});

test("exact supports generic, named-field, and browser path-compatible messages", () => {
  assert.equal(
    thrownMessage(() => exact({ a: 1, b: 2 }, ["a"], "Payload")),
    "Payload has unexpected or missing fields"
  );
  assert.equal(
    thrownMessage(() => exact({ a: 1, b: 2 }, ["a"], "Payload", { messages: NAMED_EXACT_MESSAGES })),
    "Payload has unexpected field b"
  );
  assert.equal(
    thrownMessage(() => exact({}, ["a"], "payload", { messages: PATH_EXACT_MESSAGES })),
    "payload.a is required"
  );
});

test("prose exposes board-strict and worker-preserved carriage-return policies", () => {
  assert.throws(() => prose("line one\r\nline two", "body", { maximum: 100 }), /invalid/u);
  assert.throws(() => prose("\rline one", "body", { maximum: 100 }), /invalid/u);
  assert.equal(
    prose("line one\r\nline two", "body", { maximum: 100, carriageReturns: "preserve" }),
    "line one\r\nline two"
  );
  assert.equal(
    prose("line one\r\nline two", "body", { maximum: 100, carriageReturns: "normalize" }),
    "line one\nline two"
  );
});

test("every gate-action refId remains an identifier", () => {
  for (const gate of GATE_KINDS) {
    assert.throws(
      () =>
        parseGateAction(
          {
            gateActionId: `gate-action-${gate}`,
            workItemId: "work-item-one",
            gate,
            actorId: "human:operator",
            planRevisionId: null,
            verifiedSha: null,
            mergeSha: null,
            refId: "not an identifier",
            note: null,
            createdAt: NOW,
          },
          "gateAction"
        ),
      ContractValidationError,
      gate
    );
  }
});

test("claim pinning accepts an optional closed-world block of bounded single-line values", () => {
  assert.deepEqual(parseBoardClaim({ claimId: "claim-one", messageCursor: null }), {
    claimId: "claim-one",
    messageCursor: null,
  });
  const perTask = parseBoardClaim({
    claimId: "claim-one",
    messageCursors: { "task-one": 4 },
    pinned: {
      runtime: " node ",
      runtimeVersion: "22.18.0",
      model: "gpt-5",
      promptsSha: "a".repeat(128),
    },
  });
  assert.deepEqual({ ...perTask.messageCursors }, { "task-one": 4 });
  assert.deepEqual(perTask.pinned, {
    runtime: " node ",
    runtimeVersion: "22.18.0",
    model: "gpt-5",
    promptsSha: "a".repeat(128),
  });
  assert.throws(
    () => parseBoardClaim({ claimId: "claim-one", messageCursor: null, pinned: { runtime: "node", extra: "no" } }),
    /unexpected or missing fields/u
  );
  assert.throws(
    () => parseBoardClaim({ claimId: "claim-one", messageCursor: null, pinned: { runtime: "r".repeat(129) } }),
    /runtime is invalid/u
  );
  assert.throws(
    () => parseBoardClaim({ claimId: "claim-one", messageCursor: null, pinned: { model: "gpt-5\npreview" } }),
    /model is invalid/u
  );
  assert.throws(
    () => parseBoardClaim({ claimId: "claim-one", messageCursor: null, pinned: { runtime: "node\0runtime" } }),
    /runtime is invalid/u
  );
});

test("claim result validation preserves canonical timestamps and the legacy projection boundary", () => {
  const claim = {
    apiVersion: TASK_BOARD_API_VERSION,
    run: {
      apiVersion: TASK_BOARD_API_VERSION,
      runId: "run-one",
      claimId: "claim-one",
      projectId: "project-one",
      agentId: "agent-one",
      wakeupId: "wakeup-one",
      taskId: "task-one",
      status: "active",
      startedAt: NOW,
      heartbeatAt: null,
      endedAt: null,
      result: null,
      runtime: null,
      runtimeVersion: null,
      model: null,
      promptsSha: null,
    },
    wakeup: {
      apiVersion: TASK_BOARD_API_VERSION,
      wakeupId: "wakeup-one",
      projectId: "project-one",
      agentId: "agent-one",
      reason: "human_assignment",
      taskId: "task-one",
      questionId: null,
      detail: "Run the task.",
      createdBy: "human:operator",
      createdAt: NOW,
      claimedAt: NOW,
      runId: "run-one",
    },
    task: { validatedByTheBoundedContextProjection: true },
    context: {
      intake: false,
      design: false,
      agent: null,
      projectMemory: null,
      areaMemory: [],
      parentTask: null,
      parentMessages: [],
      acceptanceCriteria: null,
      workspaceRefs: [],
      messageCursor: 0,
      messages: [],
      triggerQuestion: null,
      openQuestions: [],
      workflow: null,
    },
  };

  assert.equal(parseClaimRunResult(claim), claim);
  assert.equal(
    thrownMessage(() =>
      parseClaimRunResult({
        ...claim,
        run: { ...claim.run, startedAt: "2026-08-09T13:00:00-07:00" },
      })
    ),
    "run.startedAt is invalid"
  );

  for (const phase of WORK_ITEM_PHASES) {
    const phasedClaim = { ...claim, context: { ...claim.context, phase } };
    assert.equal(parseClaimRunResult(phasedClaim), phasedClaim);
  }
  assert.throws(
    () => parseClaimRunResult({ ...claim, context: { ...claim.context, phase: "future-phase" } }),
    /context\.phase/u
  );

  const crossRepoContext = {
    providerProjectId: "project-provider",
    providerRepoName: "provider-api",
    interfacePath: "docs/interface.md",
    sha: "a".repeat(40),
    markdown: "# Published interface\n\n- `GET /v1/orders`\n",
  };
  const crossRepoClaim = {
    ...claim,
    context: { ...claim.context, crossRepoContext },
  };
  assert.equal(parseClaimRunResult(crossRepoClaim), crossRepoClaim);
  for (const markdown of ["# Emoji 😀 interface\n", "# CJK Extension B 𠀀 interface\n"]) {
    assert.equal(
      parseClaimRunResult({
        ...crossRepoClaim,
        context: {
          ...crossRepoClaim.context,
          crossRepoContext: { ...crossRepoContext, markdown },
        },
      }).context.crossRepoContext?.markdown,
      markdown
    );
  }
  for (const markdown of ["NUL \0 control", "ESC \u001b control", "C1 \u0085 control", "lone \ud800 surrogate"]) {
    assert.throws(
      () =>
        parseClaimRunResult({
          ...crossRepoClaim,
          context: {
            ...crossRepoClaim.context,
            crossRepoContext: { ...crossRepoContext, markdown },
          },
        }),
      /crossRepoContext\.markdown is invalid/u
    );
  }
  assert.throws(
    () =>
      parseClaimRunResult({
        ...crossRepoClaim,
        context: {
          ...crossRepoClaim.context,
          crossRepoContext: { ...crossRepoContext, sha: "not-a-merge-sha" },
        },
      }),
    /crossRepoContext\.sha is invalid/u
  );
});

test("timestamp accepts ISO spellings for web millisecond projection and can require canonical worker form", () => {
  const offset = "2026-08-09T13:00:00-07:00";
  assert.equal(timestamp(offset, "createdAt"), offset);
  assert.equal(Date.parse(timestamp(offset, "createdAt")), Date.parse(NOW));
  assert.throws(() => timestamp(offset, "createdAt", "createdAt must be canonical", true), /canonical/u);
  assert.equal(timestamp(NOW, "createdAt", "createdAt must be canonical", true), NOW);
});

test("strict entity parsing rejects unknown task statuses and work-item states", () => {
  assert.throws(() => parseTaskEntity(taskEntity("future_task_state"), "tasks[0]"), /unsupported value/u);
  assert.throws(
    () => parseWorkItemEntity(workItemEntity("future_work_item_state"), "workItems[0]"),
    /unsupported value/u
  );
  assert.throws(
    () => parseTaskEntity(taskEntity("future_task_state"), "tasks[0]", { tolerantEnums: true }),
    /unsupported value/u
  );
  assert.throws(
    () => parseWorkItemEntity(workItemEntity("future_work_item_state"), "workItems[0]", { tolerantEnums: true }),
    /unsupported value/u
  );
});

test("the browser profile buckets state enums and preserves unknown work-item task types verbatim", () => {
  assert.equal(parseTaskEntity(taskEntity("future_task_state"), "tasks[0]", browserProfile).status, "unrecognized");
  assert.equal(
    parseWorkItemEntity(workItemEntity("future_work_item_state"), "workItems[0]", browserProfile).state,
    "unrecognized"
  );
  assert.equal(
    parseWorkItemEntity({ ...workItemEntity("queued"), taskType: "future_task_type" }, "workItems[0]", browserProfile)
      .taskType,
    "future_task_type"
  );
  assert.throws(
    () => parseWorkItemEntity({ ...workItemEntity("queued"), taskType: "future_task_type" }, "workItems[0]"),
    /taskType has an unsupported value/u
  );

  assert.throws(
    () =>
      parseTaskEntity(
        {
          ...taskEntity("queued"),
          kind: "future_task_kind",
        },
        "tasks[0]",
        browserProfile
      ),
    /kind has an unsupported value/u
  );
  assert.throws(
    () =>
      parseWorkItemEntity(
        {
          ...workItemEntity("queued"),
          priority: "future_priority",
        },
        "workItems[0]",
        browserProfile
      ),
    /priority has an unsupported value/u
  );
});

test("work-item repository identity distinguishes inherited and pinned repositories", () => {
  assert.equal(parseWorkItemEntity(workItemEntity("queued"), "workItems[0]").repositoryId, null);
  assert.equal(
    parseWorkItemEntity({ ...workItemEntity("queued"), repositoryId: "repository-consumer" }, "workItems[0]")
      .repositoryId,
    "repository-consumer"
  );
  assert.throws(
    () => parseWorkItemEntity({ ...workItemEntity("queued"), repositoryId: 12 }, "workItems[0]"),
    /repositoryId/u
  );
});

test("board snapshots parse repositories while legacy snapshots default to an empty list", () => {
  const repository = {
    apiVersion: TASK_BOARD_API_VERSION,
    repositoryId: "repository-primary",
    projectId: "project-one",
    name: "primary",
    path: "/repos/primary",
    isPrimary: true,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  assert.deepEqual(parseBoardSnapshotEntity(boardSnapshotEntity([repository])).repositories, [repository]);
  assert.deepEqual(parseBoardSnapshotEntity(boardSnapshotEntity()).repositories, []);
  assert.throws(
    () => parseBoardSnapshotEntity(boardSnapshotEntity([{ ...repository, isPrimary: "yes" }])),
    /board\.repositories\[0\]\.isPrimary/u
  );
});

test("repository updates require a version and at least one mutable field", () => {
  assert.deepEqual(parseBoardUpdateRepository({ version: 2, name: "consumer" }), {
    version: 2,
    name: "consumer",
  });
  assert.deepEqual(parseBoardUpdateRepository({ version: 3, path: "/repos/consumer-new" }), {
    version: 3,
    path: "/repos/consumer-new",
  });
  assert.throws(() => parseBoardUpdateRepository({ version: 1 }), /must include name or path/u);
  assert.throws(() => parseBoardUpdateRepository({ name: "consumer" }), /missing fields/u);
  assert.throws(() => parseBoardUpdateRepository({ version: 1, path: "repos/consumer" }), /absolute path/u);
  assert.throws(
    () => parseBoardUpdateRepository({ version: 1, name: "consumer", isPrimary: true }),
    /unexpected or missing fields/u
  );
});

test("the browser profile buckets future declared-child phases while strict plan parsing rejects them", () => {
  const revision = {
    apiVersion: TASK_BOARD_API_VERSION,
    planRevisionId: "plan-future-child-phase",
    workItemId: "work-item-one",
    revision: 1,
    objective: "Keep a future phased plan visible in an older browser.",
    assumptions: [],
    acceptanceCriteria: ["The plan remains visible."],
    changeShape: "blast_radius",
    tier: "standard",
    declaredScope: ["src"],
    nonGoals: [],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    children: [
      {
        key: "future-child",
        objective: "Apply the future phase.",
        projectId: "project-one",
        declaredScope: ["src/future"],
        acceptanceCriteria: ["The future phase is represented."],
        phase: "future_phase",
        splitBy: "phase",
      },
    ],
    projectId: "project-one",
    skillDigests: {},
    state: "proposed",
    createdBy: "agent:planner",
    confirmedBy: null,
    createdAt: NOW,
    confirmedAt: null,
  };

  assert.equal(parsePlanEntity(revision, "plan", browserProfile).children?.[0]?.phase, "unrecognized");
  assert.throws(() => parsePlanEntity(revision, "plan"), /children\[0\]\.phase has an unsupported value/u);
});

test("work-item detail transitions are accepted in both profiles and remain strict", () => {
  const transition = {
    fromState: null,
    toState: "queued",
    actorType: "human",
    actorId: "human:operator",
    createdAt: NOW,
  };
  const detail = { ...workItemEntity("queued"), transitions: [transition] };

  assert.equal(parseWorkItemEntity(detail, "workItem").state, "queued");
  assert.equal(parseWorkItemEntity(detail, "workItem", browserProfile).state, "queued");
  assert.throws(
    () =>
      parseWorkItemEntity(
        {
          ...detail,
          transitions: [{ ...transition, toState: "future_work_item_state" }],
        },
        "workItem",
        browserProfile
      ),
    /transitions\[0\]\.toState has an unsupported value/u
  );
});

test("identifier validation is the single contract grammar", () => {
  const contractPattern = new RegExp(IDENTIFIER_PATTERN, "u");
  assert.equal(contractPattern.source, IDENTIFIER_PATTERN);
  assert.equal(parseBoardIdentifier("A" + "a".repeat(127), "id"), "A" + "a".repeat(127));
  assert.throws(() => parseBoardIdentifier("A" + "a".repeat(128), "id"), /invalid/u);
  assert.throws(() => identifier("-leading-dash", "id"), /invalid/u);
});

test("board request shapes accept exactly the shared contract enum members", () => {
  assertAcceptedSet(AGENT_ROLES, (role) =>
    parseBoardCreateAgent({
      agentId: "agent-one",
      role,
      area: "checkout",
      mission: "Keep checkout safe.",
      model: "model-one",
      token: "task-board-agent-token-0123456789abcdef",
    })
  );
  assertAcceptedSet(TASK_PHASE_STAGES, (stage) =>
    parseBoardCreateTaskPhase({ title: "Inspect", stage, parallelGroup: null })
  );
  assertAcceptedSet(TASK_PHASE_STATUSES, (status) => parseBoardUpdateTaskPhase({ version: 1, status }));
  assertAcceptedSet(TASK_STATUSES, (status) => parseBoardUpdateTask({ version: 1, status }));
  assertAcceptedSet(WORK_ITEM_PRIORITIES, (priority) =>
    parseBoardCreateWorkItem({
      originalRequest: "Make checkout safe.",
      priority,
      projectTarget: { mode: "explicit", projectId: "project-one" },
    })
  );
  assertAcceptedSet(WORK_ITEM_TASK_TYPES, (taskType) =>
    parseBoardCreateWorkItem({
      originalRequest: "Make checkout safe.",
      taskType,
      projectTarget: { mode: "explicit", projectId: "project-one" },
    })
  );
  assert.equal(
    parseBoardCreateWorkItem({
      originalRequest: "Make checkout safe.",
      projectTarget: { mode: "explicit", projectId: "project-one" },
    }).taskType,
    "standard"
  );
  assert.throws(
    () => parseBoardCreateWorkItem({ originalRequest: "Onboard checkout.", taskType: "onboarding" }),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.code === "ONBOARDING_PROJECT_REQUIRED" &&
      error.message === "Choose a project"
  );
  assertAcceptedSet(EVALUATOR_PROFILES, (evaluatorProfile) =>
    parseBoardAutomationUpdate({
      version: 1,
      agentTypes: [
        {
          agentTypeId: "type-one",
          name: "Type one",
          description: "Disabled drift-test type.",
          role: "engineer",
          supplementalInstructions: "",
          skillIds: [],
          evaluatorProfile,
          enabled: false,
        },
      ],
      stages: stages(),
    })
  );
  assert.deepEqual(
    parseBoardAutomationUpdate({ version: 1, agentTypes: [], stages: stages() }).stages.map((stage) => stage.stage),
    [...WORK_ITEM_STAGES]
  );
  const machineVerifyStages = stages();
  machineVerifyStages[WORK_ITEM_STAGES.indexOf("testing")] = {
    stage: "testing",
    executor: { kind: "machine_verify" },
  };
  assert.deepEqual(
    parseBoardAutomationUpdate({ version: 1, agentTypes: [], stages: machineVerifyStages }).stages.find(
      (stage) => stage.stage === "testing"
    )?.executor,
    { kind: "machine_verify" }
  );

  for (const stage of WORK_ITEM_STAGES.filter((candidate) => candidate !== "testing")) {
    const invalidMachineVerifyStages = stages();
    invalidMachineVerifyStages[WORK_ITEM_STAGES.indexOf(stage)] = {
      stage,
      executor: { kind: "machine_verify" },
    };
    assert.throws(
      () => parseBoardAutomationUpdate({ version: 1, agentTypes: [], stages: invalidMachineVerifyStages }),
      new RegExp(`${stage} cannot use the machine_verify executor`, "u")
    );
  }
});

test("automation role authorization follows the shared stage table", () => {
  assert.equal(Object.isFrozen(AUTOMATION_STAGE_ALLOWED_ROLES), true);

  for (const stage of WORK_ITEM_STAGES) {
    const allowedRoles: readonly string[] = AUTOMATION_STAGE_ALLOWED_ROLES[stage];
    assert.equal(Object.isFrozen(allowedRoles), true);
    for (const role of AGENT_ROLES) {
      const configuredStages = stages();
      configuredStages[WORK_ITEM_STAGES.indexOf(stage)] = {
        stage,
        executor: { kind: "agent_type", agentTypeId: "type-one" },
      } as never;
      const parse = () =>
        parseBoardAutomationUpdate({
          version: 1,
          agentTypes: [
            {
              agentTypeId: "type-one",
              name: "Type one",
              description: "Exercises the shared stage-role policy.",
              role,
              supplementalInstructions: "Follow the assigned stage policy.",
              skillIds: [],
              evaluatorProfile: "tests",
              enabled: true,
            },
          ],
          stages: configuredStages,
        });

      if (allowedRoles.includes(role)) {
        assert.doesNotThrow(parse, `${stage} should allow ${role}`);
        continue;
      }
      // The human-owned and disabled stages reject an agent executor before the
      // role table is consulted, so only the automated stages pin the role text.
      // A bare string second argument here would be Node's assertion message,
      // not a matcher, and would pass on any throw at all.
      const expected =
        stage === "human_review"
          ? /human_review must use the human executor/u
          : stage === "deployment"
            ? /deployment must remain disabled/u
            : new RegExp(`${stage} cannot use an agent type with the ${role} role`, "u");
      assert.throws(parse, expected, `${stage} should reject ${role}`);
    }
  }
});

test("board workflow shapes accept exactly the shared handoff and stage enums", () => {
  const handoff = (outcomeValue: string, returnStage: string | null) => ({
    outcome: outcomeValue,
    summary: "Verified.",
    evidence: [],
    artifactIds: [],
    acceptanceCriteria: [],
    blockers: [],
    recommendedReturnStage: returnStage,
  });
  assertAcceptedSet(STAGE_HANDOFF_OUTCOMES, (value) =>
    parseBoardSettle({ outcome: "completed", result: "Done.", handoff: handoff(value, null) })
  );
  assertAcceptedSet(WORKFLOW_STAGES, (value) =>
    parseBoardSettle({ outcome: "completed", result: "Done.", handoff: handoff("passed", value) })
  );
  assertAcceptedSet(WORKFLOW_STAGES, (stage) =>
    parseBoardSettle({
      outcome: "completed",
      result: "Done.",
      workflowPlan: {
        objective: "Complete the work.",
        assumptions: [],
        acceptanceCriteria: ["The work is verified."],
        nodes: [
          {
            nodeId: "node-one",
            title: "Do the work",
            objective: "Complete and verify it.",
            acceptanceCriteria: ["The work is verified."],
            dependencyNodeIds: [],
            stageTemplate: stage === "verification" ? [stage] : [stage, "verification"],
          },
        ],
      },
    })
  );
  assert.deepEqual(
    parseBoardSettle({
      outcome: "completed",
      result: "Done.",
      workflowPlan: pipelinePlan({
        nodes: [
          {
            nodeId: "node-one",
            title: "Implement the pipeline contract",
            objective: "Add and machine-verify the shared contract.",
            acceptanceCriteria: ["The pipeline contract round-trips."],
            dependencyNodeIds: [],
            stageTemplate: ["implementation", "testing"],
          },
        ],
      }),
    }).workflowPlan?.nodes[0]?.stageTemplate,
    ["implementation", "testing"]
  );
});

test("worker context shapes accept exactly the shared role, task, and phase enums", () => {
  assert.deepEqual(
    [...WAKEUP_REASONS],
    ["human_assignment", "human_answer", "human_resume", "workflow_handoff", "assigned", "resumed"]
  );
  assertAcceptedSet(AGENT_ROLES, (requiredRole) =>
    parseWorkerAgentContext(context({ task: { ...(context().task as object), requiredRole } }))
  );
  assertAcceptedSet(TASK_KINDS, (kind) =>
    parseWorkerAgentContext(context({ task: { ...(context().task as object), kind } }))
  );
  assertAcceptedSet(TASK_PHASE_STAGES, (stage) =>
    parseWorkerAgentContext(
      context({
        task: {
          ...(context().task as object),
          phases: [
            {
              phaseId: "phase-one",
              title: "Inspect",
              stage,
              status: stage === "done" ? "completed" : "pending",
              parallelGroup: null,
              orderKey: 0,
              version: 1,
            },
          ],
        },
      })
    )
  );
  assertAcceptedSet(TASK_PHASE_STATUSES, (status) =>
    parseWorkerAgentContext(
      context({
        task: {
          ...(context().task as object),
          phases: [
            {
              phaseId: "phase-one",
              title: "Inspect",
              stage: "research",
              status,
              parallelGroup: null,
              orderKey: 0,
              version: 1,
            },
          ],
        },
      })
    )
  );
  assertAcceptedSet(WORK_ITEM_PHASES, (phase) => parseWorkerAgentContext(context({ phase })));
  assert.equal((parseWorkerAgentContext(context()) as { phase?: string | null }).phase, null);
});

test("worker intake context accepts a bounded closed-world board-project list", () => {
  const boardProjects = [
    { projectId: "project-one", name: "Provider API", repoName: "provider-api" },
    { projectId: "project-consumer", name: "Consumer web", repoName: "consumer-web" },
  ];
  assert.deepEqual(
    (parseWorkerAgentContext(context({ intake: true, boardProjects })) as { boardProjects?: unknown }).boardProjects,
    boardProjects
  );
  assert.throws(
    () =>
      parseWorkerAgentContext(
        context({
          intake: true,
          boardProjects: Array.from({ length: 65 }, (_, index) => ({
            projectId: `project-${index}`,
            name: `Project ${index}`,
            repoName: `repo-${index}`,
          })),
        })
      ),
    /boardProjects/u
  );
});

test("worker expected minutes rejects an explicitly undefined value", () => {
  assert.equal(
    thrownMessage(() =>
      parseWorkerAgentContext(
        context({
          task: { ...(context().task as object), expectedAgentMinutes: undefined },
        })
      )
    ),
    "task.expectedAgentMinutes must be a 15-minute interval between 15 and 10080"
  );
});

test("worker outcome shapes accept exactly the shared handoff and workflow enums", () => {
  assertAcceptedSet(STAGE_HANDOFF_OUTCOMES, (value) =>
    parseWorkerAgentRunOutcome(
      outcome({
        outcome: value,
        summary: "Verified.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [],
        recommendedReturnStage: null,
      })
    )
  );
  assertAcceptedSet(WORKFLOW_STAGES, (value) =>
    parseWorkerAgentRunOutcome(
      outcome({
        outcome: "passed",
        summary: "Verified.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [],
        recommendedReturnStage: value,
      })
    )
  );
  assertAcceptedSet(WORKFLOW_STAGES, (stage) =>
    parseWorkerAgentRunOutcome(
      outcome(null, {
        objective: "Complete the work.",
        assumptions: [],
        acceptanceCriteria: ["The work is verified."],
        nodes: [
          {
            nodeId: "node-one",
            title: "Do the work",
            objective: "Complete and verify it.",
            acceptanceCriteria: ["The work is verified."],
            dependencyNodeIds: [],
            stageTemplate: stage === "verification" ? [stage] : [stage, "verification"],
          },
        ],
      })
    )
  );
});

test("gap reports round-trip through worker outcomes and board settlements with a shared bound", () => {
  const gapReport = "# Gaps\n\n- Branch protection is deferred.";
  assert.equal(
    parseWorkerAgentRunOutcome({
      ...(outcome() as Record<string, unknown>),
      gapReport,
    }).gapReport,
    gapReport
  );
  assert.equal(
    parseBoardSettle({
      outcome: "completed",
      result: "Onboarding completed.",
      gapReport,
    }).gapReport,
    gapReport
  );
  assert.throws(() =>
    parseWorkerAgentRunOutcome({
      ...(outcome() as Record<string, unknown>),
      gapReport: "x".repeat(AGENT_GAP_REPORT_MAX_CHARACTERS + 1),
    })
  );
  assert.throws(() =>
    parseBoardSettle({
      outcome: "completed",
      result: "Onboarding completed.",
      gapReport: "x".repeat(AGENT_GAP_REPORT_MAX_CHARACTERS + 1),
    })
  );
});

test("review finding drafts round-trip through board and worker settlement fields", () => {
  const reviewFindings = [
    {
      file: "src/server/task-board/persistence/workflow.ts",
      line: 1200,
      category: "correctness",
      severity: "major",
      expected: "A failed review returns to implementation.",
      actual: "The node remained in review.",
    },
  ] as const;
  assert.deepEqual(
    parseBoardSettle({
      outcome: "failed",
      result: "Review failed.",
      reviewFindings,
    }).reviewFindings,
    reviewFindings
  );
  assert.deepEqual(
    parseWorkerAgentRunOutcome({
      ...(outcome() as Record<string, unknown>),
      reviewFindings,
    }).reviewFindings,
    reviewFindings
  );

  const tooMany = Array.from({ length: REVIEW_FINDING_DRAFT_MAX_ITEMS + 1 }, () => reviewFindings[0]);
  assert.throws(() => parseBoardSettle({ outcome: "failed", result: "Review failed.", reviewFindings: tooMany }));
  assert.throws(() =>
    parseWorkerAgentRunOutcome({
      ...(outcome() as Record<string, unknown>),
      reviewFindings: tooMany,
    })
  );

  const maximumFinding = {
    file: "x".repeat(512),
    line: Number.MAX_SAFE_INTEGER,
    category: "test_modification",
    severity: "critical",
    expected: "e".repeat(REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH),
    actual: "a".repeat(REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH),
  } as const;
  const maximumSettlement = {
    outcome: "failed",
    result: "r".repeat(16_000),
    reviewFindings: Array.from({ length: REVIEW_FINDING_DRAFT_MAX_ITEMS }, () => maximumFinding),
  } as const;
  assert.equal(parseBoardSettle(maximumSettlement).reviewFindings?.length, REVIEW_FINDING_DRAFT_MAX_ITEMS);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumSettlement), "utf8") < 64 * 1_024);
  assert.throws(() =>
    parseBoardSettle({
      ...maximumSettlement,
      reviewFindings: [
        {
          ...maximumFinding,
          expected: "e".repeat(REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH + 1),
        },
      ],
    })
  );
});

test("pipeline plan-record fields round-trip through board and worker draft validators", () => {
  const children = [
    {
      key: "legacy-child",
      objective: "Keep a pre-repository declaration valid.",
      projectId: "project-one",
      declaredScope: ["src/legacy"],
      acceptanceCriteria: ["The declaration keeps its primary-repository meaning."],
    },
    {
      key: "repository-child",
      objective: "Target a repository explicitly.",
      projectId: "project-one",
      repositoryId: "repository-one",
      declaredScope: ["tests/repository"],
      acceptanceCriteria: ["The repository target round-trips."],
    },
  ] as const;
  const plan = pipelinePlan({ children });
  const boardPlan = parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: plan }).workflowPlan;
  const workerPlan = parseWorkerAgentRunOutcome(outcome(null, plan)).workflowPlan;
  assert.deepEqual(boardPlan, plan);
  assert.deepEqual(workerPlan, plan);
  assert.equal(boardPlan?.children?.[0]?.repositoryId, undefined);
  assert.equal(workerPlan?.children?.[1]?.repositoryId, "repository-one");

  const invalid = pipelinePlan({
    children: [{ ...children[1], repositoryId: "-invalid-repository" }],
  });
  assert.throws(
    () => parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: invalid }),
    /repositoryId is invalid/u
  );
  assert.throws(() => parseWorkerAgentRunOutcome(outcome(null, invalid)), /repositoryId is invalid/u);
});

test("phased children may share a project when they name different repositories", () => {
  // Campaign 10 could treat "different repository" as "different project",
  // because a project had exactly one. Campaign 16's whole premise is that a
  // product may span repositories inside one project, so the rule has to
  // discriminate on the (project, repository) pair — and a migrate child that
  // shares both with the provider is still a violation.
  const child = (key: string, phase: string, repositoryId: string | undefined, extra: object = {}) => ({
    key,
    objective: `Phase ${key}.`,
    projectId: "one-project",
    ...(repositoryId === undefined ? {} : { repositoryId }),
    declaredScope: [`src/${key}`, "docs/interface.md"],
    acceptanceCriteria: ["The phase completes."],
    phase,
    splitBy: "phase",
    ...extra,
  });
  const plan = (migrateRepositoryId: string | undefined) => ({
    objective: "Coordinate the phased change.",
    assumptions: [],
    acceptanceCriteria: ["Every phase merges."],
    changeShape: "blast_radius",
    declaredScope: ["coordination"],
    criterionChecks: [],
    children: [
      child("expand", "expand", "repository-primary"),
      child("migrate", "migrate", migrateRepositoryId, { dependsOn: ["expand"] }),
      child("contract", "contract", "repository-primary", { dependsOn: ["migrate"] }),
    ],
    nodes: [
      {
        nodeId: "coordinate",
        title: "Coordinate",
        objective: "Coordinate the phases.",
        acceptanceCriteria: ["The parent records each outcome."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      },
    ],
  });

  // A second repository in the same project is the case the campaign exists for.
  assert.doesNotThrow(() =>
    parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: plan("repository-secondary") })
  );
  // Naming the provider's own repository is still rejected.
  assert.throws(
    () => parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: plan("repository-primary") }),
    /migrate children must use a repository other than the provider's/u
  );
  // Omitting the id resolves to the same primary the provider named, so this is
  // the same collision — but the contract has no database and cannot see it.
  // Asserted rather than implied, so the limit is visible and materialization is
  // known to own the case.
  assert.doesNotThrow(() => parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: plan(undefined) }));
});

test("phased plans require Expand and Contract scope to cover docs/interface.md", () => {
  const children = [
    {
      key: "expand",
      objective: "Publish the additive provider interface.",
      projectId: "provider-project",
      declaredScope: ["src/provider", "docs/"],
      acceptanceCriteria: ["The additive interface is published."],
      phase: "expand",
      splitBy: "phase",
    },
    {
      key: "migrate",
      objective: "Migrate the consumer.",
      projectId: "consumer-project",
      declaredScope: ["src/consumer"],
      acceptanceCriteria: ["The consumer uses the additive interface."],
      phase: "migrate",
      dependsOn: ["expand"],
      splitBy: "consumer",
    },
    {
      key: "contract",
      objective: "Remove the legacy provider interface.",
      projectId: "provider-project",
      declaredScope: ["src/provider", "docs/interface.md"],
      acceptanceCriteria: ["The legacy interface is removed."],
      phase: "contract",
      dependsOn: ["migrate"],
      splitBy: "phase",
    },
  ] as const;
  const valid = pipelinePlan({ changeShape: "blast_radius", children });
  assert.doesNotThrow(() => parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: valid }));
  assert.doesNotThrow(() => parseWorkerAgentRunOutcome(outcome(null, valid)));

  for (const phase of ["expand", "contract"] as const) {
    const invalid = pipelinePlan({
      changeShape: "blast_radius",
      children: children.map((child) =>
        child.phase === phase ? { ...child, declaredScope: ["src/provider"] } : child
      ),
    });
    assert.throws(
      () => parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: invalid }),
      new RegExp(`${phase}.*docs/interface\\.md`, "u")
    );
    assert.throws(
      () => parseWorkerAgentRunOutcome(outcome(null, invalid)),
      new RegExp(`${phase}.*docs/interface\\.md`, "u")
    );
  }
});

test("plan-record enums, revision entities, and verify-attempt types expose the v20 contract", () => {
  assert.deepEqual(PLAN_CHANGE_SHAPES, ["mechanical_sweep", "feature", "blast_radius"]);
  assert.deepEqual(PLAN_TIERS, ["standard", "hazardous"]);
  const revision = {
    apiVersion: TASK_BOARD_API_VERSION,
    planRevisionId: "plan-one",
    workItemId: "work-item-one",
    revision: 2,
    objective: "Keep the plan record durable.",
    assumptions: [],
    acceptanceCriteria: ["The record round-trips."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/shared"],
    nonGoals: ["Do not add remote delivery."],
    mechanicalPortions: ["Add nullable schema columns."],
    blockingQuestions: [{ question: "Keep legacy plans?", recommendedDefault: "Yes." }],
    criterionChecks: [{ criterion: "The suite passes.", check: "npm test" }],
    children: [
      {
        key: "provider-child",
        objective: "Publish the provider change.",
        projectId: "project-one",
        repositoryId: "repository-one",
        declaredScope: ["src/provider"],
        acceptanceCriteria: ["The provider change is verified."],
      },
    ],
    projectId: "project-one",
    skillDigests: {},
    state: "rejected",
    createdBy: "agent:planner",
    confirmedBy: null,
    createdAt: NOW,
    confirmedAt: null,
    rejectedNote: "Clarify the requested scope.",
  };
  const parsedRevision = parsePlanEntity(revision, "Plan revision");
  assert.deepEqual({ ...parsedRevision, skillDigests: { ...parsedRevision.skillDigests } }, revision);

  const attempt: VerifyAttempt = {
    verifyAttemptId: "verify-one",
    nodeId: "node-one",
    stage: "testing",
    attempt: 1,
    verifyRunId: null,
    workspacePath: null,
    state: "starting",
    checkResults: [{ criterion: "The suite passes.", check: "npm test", passed: true }],
    detail: null,
    createdAt: NOW,
    endedAt: null,
  };
  assert.equal(attempt.state, "starting");

  const workItem = parseWorkItemEntity(
    {
      ...workItemEntity("queued"),
      pipelineBranch: "task/work-item-one",
      baseSha: null,
    },
    "Work item"
  );
  assert.equal(workItem.pipelineBranch, "task/work-item-one");
  assert.equal(workItem.baseSha, null);
});

test("pipeline plan-record validation rejects invalid enums, scope, bounds, and check controls", () => {
  const invalidPlans = [
    pipelinePlan({ changeShape: "not_a_contract_member" }),
    pipelinePlan({ tier: "not_a_contract_member" }),
    pipelinePlan({ declaredScope: [] }),
    pipelinePlan({ declaredScope: ["/src/shared"] }),
    pipelinePlan({ declaredScope: ["src/../secrets"] }),
    pipelinePlan({ declaredScope: ["s".repeat(257)] }),
    pipelinePlan({ declaredScope: Array.from({ length: 65 }, (_, index) => `scope-${index}`) }),
    pipelinePlan({ nonGoals: Array.from({ length: 33 }, (_, index) => `non-goal-${index}`) }),
    pipelinePlan({ nonGoals: ["n".repeat(1_001)] }),
    pipelinePlan({ mechanicalPortions: Array.from({ length: 33 }, (_, index) => `portion-${index}`) }),
    pipelinePlan({ mechanicalPortions: ["m".repeat(1_001)] }),
    pipelinePlan({
      blockingQuestions: Array.from({ length: 17 }, (_, index) => ({
        question: `Question ${index}?`,
        recommendedDefault: "Use the default.",
      })),
    }),
    pipelinePlan({ blockingQuestions: [{ question: "q".repeat(1_001), recommendedDefault: "Use the default." }] }),
    pipelinePlan({ blockingQuestions: [{ question: "Choose a default?", recommendedDefault: "d".repeat(1_001) }] }),
    pipelinePlan({
      criterionChecks: Array.from({ length: 33 }, (_, index) => ({
        criterion: `Criterion ${index}`,
        check: "npm test",
      })),
    }),
    pipelinePlan({ criterionChecks: [{ criterion: "c".repeat(1_001), check: "npm test" }] }),
    pipelinePlan({ criterionChecks: [{ criterion: "Stay bounded.", check: "x".repeat(513) }] }),
    pipelinePlan({ criterionChecks: [{ criterion: "Stay bounded.", check: "npm test\nrm -rf build" }] }),
  ];
  for (const plan of invalidPlans) {
    assert.throws(() => parseBoardSettle({ outcome: "completed", result: "Done.", workflowPlan: plan }), /invalid/u);
    assert.throws(() => parseWorkerAgentRunOutcome(outcome(null, plan)), /invalid/u);
  }
});
