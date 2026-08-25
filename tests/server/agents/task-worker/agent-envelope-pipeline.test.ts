import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { agentPrompt } from "#server/agents/task-worker/agent-envelope";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";
import { context } from "./helpers.js";

const PROMPTS = PromptRegistry.loadSync(resolve("prompts"));

function renderPrompt(request: Parameters<typeof agentPrompt>[0]): string {
  return agentPrompt(request, PROMPTS);
}

const DESIGNER_PROMPT = "Produce the design record for the approved plan below — return it as designRecord. Required: states and legal transitions (for each transition crossing a process or network boundary, what is durably recorded before the boundary and the recovery); a failure-point table covering all six points (crash_before_send, crash_after_send_before_response, crash_after_response_before_commit, crash_after_commit_before_ack, duplicate_delivery, concurrent_invocation) with resulting state and recovery for each; idempotency-key lifecycle (where generated, persisted, how reused); fault-injection cases that the implementer will write as tests. Standing prohibitions: locks are an optimization to reduce duplicate work, never the correctness boundary — correctness comes from conditional writes whose affected-row count resolves the race; unknown outcome is a distinct state, never collapsed into failure, resolved by querying the remote, never by assuming; idempotency keys are generated once, persisted with the intent record, reused verbatim on retry; timer, cleanup, and retry paths are participants in the state machine and appear in the transition table. Never write code.";

const DESIGN_RECORD = {
  states: ["pending", "committed"],
  transitions: [{ from: "pending", to: "committed" }],
  failurePoints: [
    "crash_before_send",
    "crash_after_send_before_response",
    "crash_after_response_before_commit",
    "crash_after_commit_before_ack",
    "duplicate_delivery",
    "concurrent_invocation",
  ].map((point) => ({ point, resultingState: `state after ${point}`, recovery: `recover ${point}` })),
  idempotencyKeys: [],
  faultInjectionCases: [],
} as const;

const PIPELINE_BLOCK = "Pipeline task on branch task/work-item-one. Declared scope (only these path prefixes): src/server, tests/server. Non-goals: do not change the schema, do not add dependencies. Loop: write a failing test where a criterion allows, implement, run `npm run verify:fast`, read the failure, fix; repeat until green. Run `npm run verify:area` once before finishing. Commit in staged logical units (schema, core, wiring, tests) — never one blob. Reversible mid-run decisions: record each mid-run assumption as an evidence entry prefixed ASSUMPTION: . STOP and return failed with detail starting `BRIGHT_LINE:` if you would need to: touch a file outside declared scope, change a schema or migration unplanned, add a dependency, change a published interface, violate a non-goal, find the plan infeasible, or delete/skip an existing test.";

function pipelineWorkflow(stage: "implementation" | "testing" | "verification") {
  return {
    planRevisionId: "plan-one",
    nodeId: "node-one",
    stage,
    skills: [],
    dependencyHandoffs: [],
    workspaceKey: "work-item-one",
    pipeline: {
      branch: "task/work-item-one",
      baseSha: "a".repeat(40),
      changeShape: "feature" as const,
      tier: "standard" as const,
      declaredScope: ["src/server", "tests/server"],
      nonGoals: ["do not change the schema", "do not add dependencies"],
      assumptions: ["The focused tests describe the intended behavior."],
    },
  } as const;
}

const REVIEWER_BLOCK = "Pipeline review on branch task/work-item-one. You are reviewing the diff against the approved plan — injected below — never the implementer's reasoning. Review depth follows change shape (feature): spot-check a mechanical sweep; read feature work line by line; review a blast-radius change per consumer. Check in order: (1) files touched vs declared scope — pre-computed as scopeOk=true, files below; (2) each acceptance criterion actually met in the code; (3) docs updated in the same diff where the plan requires; (4) any modified or deleted existing test — emit a test_modification finding for each unless the plan's mechanicalPortions declared it. Emit reviewFindings [{file, line, category, severity, expected, actual}]; categories correctness|security|plan_deviation block, others do not. If any blocking finding exists return handoff outcome failed with recommendedReturnStage implementation; otherwise outcome passed. Do not edit the workspace.";

const GOLDEN_FIXTURE_ROOT = resolve("tests/server/agents/task-worker/fixtures/agent-prompts");

function goldenPromptCases(): readonly Readonly<{ name: string; prompt: string }>[] {
  const fixWorkflow = {
    ...pipelineWorkflow("implementation"),
    fix: {
      round: 2,
      findings: [{
        findingId: "finding-two",
        nodeId: "node-one",
        stage: "verification",
        round: 2,
        file: "src/server/fix.ts",
        line: 24,
        category: "correctness",
        severity: "major",
        expected: "The retry reaches machine verification.",
        actual: "The retry skipped machine verification.",
        blocking: true,
        createdAt: "2026-08-19T12:00:00.000Z",
      }],
    },
  } as const;
  const reviewWorkflow = {
    ...pipelineWorkflow("verification"),
    workspaceKey: "work-item-one-review",
    review: {
      commits: [{ sha: "b".repeat(40), subject: "Implement review context" }],
      diffstat: " 2 files changed, 8 insertions(+), 1 deletion(-)\n",
      filesTouched: [
        { path: "src/server/review.ts", status: "added" },
        { path: "tests/server/review.test.ts", status: "modified" },
      ],
      scopeOk: true,
      midRunAssumptions: ["The review workspace remains read-only."],
      acceptanceCriteria: ["The reviewer receives branch evidence."],
      criterionChecks: [{ criterion: "The reviewer receives branch evidence.", check: "npm run test:runtime" }],
      mechanicalPortions: ["Regenerate the task-board snapshots."],
      priorFindings: [{
        findingId: "finding-one",
        nodeId: "node-one",
        stage: "verification",
        round: 1,
        file: "src/server/review.ts",
        line: 12,
        category: "correctness",
        severity: "major",
        expected: "The context is isolated.",
        actual: "The prior attempt reused the engineer workspace.",
        blocking: true,
        createdAt: "2026-08-19T12:00:00.000Z",
      }],
      priorFindingsTruncated: true,
    },
  } as const;
  return [
    {
      name: "manager-intake",
      prompt: renderPrompt({
        runId: "run-golden-manager-intake",
        wakeReason: "human_assignment",
        context: context({
          intake: true,
          mission: {
            role: "manager",
            area: "Campaign intake",
            mission: "Turn the campaign request into an observable workflow plan.",
          },
        }),
      }),
    },
    {
      name: "engineer-pipeline-implementation",
      prompt: renderPrompt({
        runId: "run-golden-pipeline-implementation",
        wakeReason: "workflow_handoff",
        context: context({ workflow: pipelineWorkflow("implementation") }),
      }),
    },
    {
      name: "engineer-fix-round",
      prompt: renderPrompt({
        runId: "run-golden-fix-round",
        wakeReason: "workflow_handoff",
        context: context({ workflow: fixWorkflow as never }),
      }),
    },
    {
      name: "verifier-machine",
      prompt: renderPrompt({
        runId: "run-golden-verifier-machine",
        wakeReason: "workflow_handoff",
        context: context({
          mission: {
            role: "verifier",
            area: "Machine verification",
            mission: "Verify the implementation with the configured non-modifying checks.",
          },
          workflow: pipelineWorkflow("testing"),
        }),
      }),
    },
    {
      name: "reviewer-prior-findings",
      prompt: renderPrompt({
        runId: "run-golden-reviewer",
        wakeReason: "workflow_handoff",
        context: context({
          mission: {
            role: "verifier",
            area: "Pipeline review",
            mission: "Review the implementation independently.",
          },
          workflow: reviewWorkflow as never,
        }),
      }),
    },
    {
      name: "designer-hazardous",
      prompt: renderPrompt({
        runId: "run-golden-designer",
        wakeReason: "human_assignment",
        context: context({
          design: true,
          mission: {
            role: "manager",
            area: "Hazard design",
            mission: "Design the approved hazardous workflow.",
          },
        } as never),
      }),
    },
    {
      name: "oversight",
      prompt: renderPrompt({
        runId: "run-golden-oversight",
        wakeReason: "human_resume",
        context: context({
          mission: {
            role: "manager",
            area: "Release oversight",
            mission: "Review the supplied evidence and risks for human judgment.",
          },
        }),
      }),
    },
  ];
}

test("agent prompt context matrix matches byte-identical golden fixtures", () => {
  const cases = goldenPromptCases();
  for (const fixture of cases) {
    assert.equal(
      fixture.prompt,
      readFileSync(join(GOLDEN_FIXTURE_ROOT, `${fixture.name}.txt`), "utf8"),
      fixture.name,
    );
  }
});

test("pipeline implementation engineer prompt appends the declared-scope bright-line block verbatim", () => {
  const prompt = renderPrompt({
    runId: "run-pipeline-implementation",
    wakeReason: "human_assignment",
    context: context({ workflow: pipelineWorkflow("implementation") }),
  });

  assert.ok(prompt.includes(PIPELINE_BLOCK));
  assert.equal(prompt.split(PIPELINE_BLOCK).length, 2);
});

test("design-task manager prompt uses the hazardous designer instructions verbatim", () => {
  const prompt = renderPrompt({
    runId: "run-hazardous-design",
    wakeReason: "human_assignment",
    context: context({
      design: true,
      mission: { role: "manager", area: "Hazard design", mission: "Design the approved hazardous workflow." },
    } as never),
  });

  assert.ok(prompt.includes(DESIGNER_PROMPT));
  assert.equal(prompt.split(DESIGNER_PROMPT).length, 2);
  assert.doesNotMatch(prompt, /READY_FOR_HUMAN_CHECK/u);
});

test("hazardous implementation prompt injects the design record and fault-injection requirement", () => {
  const workflow = {
    ...pipelineWorkflow("implementation"),
    pipeline: {
      ...pipelineWorkflow("implementation").pipeline,
      tier: "hazardous" as const,
      designRecord: DESIGN_RECORD,
    },
  };
  const prompt = renderPrompt({
    runId: "run-hazardous-implementation",
    wakeReason: "workflow_handoff",
    context: context({ workflow: workflow as never }),
  });

  assert.match(prompt, /This is a hazardous-tier task\. Design record below\. Write each fault-injection case as a test\./u);
  assert.ok(prompt.includes(JSON.stringify(DESIGN_RECORD)));
});

test("fix-round engineer prompt replaces the plain implementation block and renders findings", () => {
  const workflow = {
    ...pipelineWorkflow("implementation"),
    fix: {
      round: 2,
      findings: [{
        findingId: "finding-two",
        nodeId: "node-one",
        stage: "verification",
        round: 2,
        file: "src/server/fix.ts",
        line: 24,
        category: "correctness",
        severity: "major",
        expected: "The retry reaches machine verification.",
        actual: "The retry skipped machine verification.",
        blocking: true,
        createdAt: "2026-08-19T12:00:00.000Z",
      }],
    },
  } as const;
  const prompt = renderPrompt({
    runId: "run-pipeline-fix",
    wakeReason: "workflow_handoff",
    context: context({ workflow: workflow as never }),
  });

  const fixBlock = "Fix round 2 on branch task/work-item-one. A reviewer found the defects below; the diff is on the branch. Fix each finding, then re-trace the whole flow end to end — not just the patch. Loop: run `npm run verify:fast`, read the failure, fix; repeat until green. Run `npm run verify:area` once before finishing. Commit in staged logical units. The declared scope, non-goals, and BRIGHT_LINE rules from the original task still apply verbatim.";
  assert.ok(prompt.includes(fixBlock));
  assert.match(prompt, /src\/server\/fix\.ts/u);
  assert.match(prompt, /The retry skipped machine verification\./u);
  assert.match(prompt, /Reversible mid-run decisions:/u);
  assert.doesNotMatch(prompt, /Pipeline task on branch task\/work-item-one/u);
  assert.ok(prompt.indexOf(fixBlock) < prompt.indexOf("src/server/fix.ts"));
  assert.ok(prompt.indexOf("src/server/fix.ts") < prompt.indexOf("Reversible mid-run decisions:"));
});

test("pipeline block is absent outside the engineer implementation stage", () => {
  const cases = [
    context({ workflow: null }),
    context({ workflow: pipelineWorkflow("testing") }),
    context({
      mission: { role: "manager", area: "Release oversight", mission: "Review evidence and risks." },
      workflow: pipelineWorkflow("implementation"),
    }),
  ];

  for (const boundedContext of cases) {
    const prompt = renderPrompt({
      runId: `run-without-pipeline-block-${boundedContext.mission.role}-${boundedContext.workflow?.stage ?? "none"}`,
      wakeReason: "human_assignment",
      context: boundedContext,
    });
    assert.doesNotMatch(prompt, /Pipeline task on branch/u);
    assert.doesNotMatch(prompt, /BRIGHT_LINE:/u);
  }
});

test("pipeline verification reviewer prompt injects the independent review instructions and evidence", () => {
  const workflow = {
    ...pipelineWorkflow("verification"),
    workspaceKey: "work-item-one-review",
    review: {
      commits: [{ sha: "b".repeat(40), subject: "Implement review context" }],
      diffstat: " 2 files changed, 8 insertions(+), 1 deletion(-)\n",
      filesTouched: [
        { path: "src/server/review.ts", status: "added" },
        { path: "tests/server/review.test.ts", status: "modified" },
      ],
      scopeOk: true,
      midRunAssumptions: ["The review workspace remains read-only."],
      acceptanceCriteria: ["The reviewer receives branch evidence."],
      criterionChecks: [{ criterion: "The reviewer receives branch evidence.", check: "npm run test:runtime" }],
      mechanicalPortions: ["Regenerate the task-board snapshots."],
      priorFindings: [{
        findingId: "finding-one",
        nodeId: "node-one",
        stage: "verification",
        round: 1,
        file: "src/server/review.ts",
        line: 12,
        category: "correctness",
        severity: "major",
        expected: "The context is isolated.",
        actual: "The prior attempt reused the engineer workspace.",
        blocking: true,
        createdAt: "2026-08-19T12:00:00.000Z",
      }],
      priorFindingsTruncated: true,
    },
  } as const;
  const prompt = renderPrompt({
    runId: "run-pipeline-review",
    wakeReason: "workflow_handoff",
    context: context({
      mission: {
        role: "verifier",
        area: "Pipeline review",
        mission: "Review the implementation independently.",
      },
      workflow: workflow as never,
    }),
  });

  assert.ok(prompt.includes(REVIEWER_BLOCK));
  assert.equal(prompt.split(REVIEWER_BLOCK).length, 2);
  assert.match(prompt, /Implement review context/u);
  assert.match(prompt, /src\/server\/review\.ts \(added\)/u);
  assert.match(prompt, /tests\/server\/review\.test\.ts \(modified\)/u);
  assert.match(prompt, /The review workspace remains read-only\./u);
  assert.match(prompt, /The reviewer receives branch evidence\./u);
  assert.match(prompt, /Mechanical portions:\n- Regenerate the task-board snapshots\./u);
  assert.match(prompt, /The prior attempt reused the engineer workspace\./u);
  assert.match(prompt, /oldest findings omitted to fit the claim context/u);
  assert.doesNotMatch(prompt, /design record/iu);
});

test("hazardous reviewer prompt traces the injected design record to guaranteeing lines", () => {
  const base = pipelineWorkflow("verification");
  const prompt = renderPrompt({
    runId: "run-hazardous-review",
    wakeReason: "workflow_handoff",
    context: context({
      mission: {
        role: "verifier",
        area: "Hazardous pipeline review",
        mission: "Review every hazardous recovery guarantee independently.",
      },
      workflow: {
        ...base,
        workspaceKey: "work-item-one-review",
        pipeline: { ...base.pipeline, tier: "hazardous", designRecord: DESIGN_RECORD },
        review: null,
      } as never,
    }),
  });

  assert.match(prompt, /For hazardous tier, trace each failure point in the design record to the line that guarantees it\./u);
  assert.ok(prompt.includes(JSON.stringify(DESIGN_RECORD)));
});

test("legacy pipeline review replays mark scope evidence unavailable instead of reporting a violation", () => {
  const prompt = renderPrompt({
    runId: "run-legacy-pipeline-review",
    wakeReason: "workflow_handoff",
    context: context({
      mission: {
        role: "verifier",
        area: "Pipeline review",
        mission: "Review the implementation independently.",
      },
      workflow: {
        ...pipelineWorkflow("verification"),
        workspaceKey: "work-item-one-review",
        review: null,
      },
    }),
  });

  assert.match(prompt, /scope evidence unavailable in this legacy claim replay — skip check \(1\)/u);
  assert.doesNotMatch(prompt, /scopeOk=false/u);
  assert.match(prompt, /Review context: unavailable in this legacy claim replay\./u);
});
