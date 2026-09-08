import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { claudeAdapter } from "../../../../src/server/agents/runtime/claude.js";
import { codexAdapter } from "../../../../src/server/agents/runtime/codex.js";
import type { RuntimeEvent } from "../../../../src/server/agents/runtime/adapter.js";
import { RuntimeCapabilityError } from "../../../../src/server/agents/runtime/profiles.js";
import {
  AGENT_GAP_REPORT_MAX_CHARACTERS,
  DESIGN_FAILURE_POINTS,
  DESIGN_RECORD_DETAIL_MAX_LENGTH,
  DESIGN_RECORD_LABEL_MAX_LENGTH,
  DESIGN_RECORD_MAX_FAILURE_POINTS,
  DESIGN_RECORD_MAX_FAULT_INJECTION_CASES,
  DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS,
  DESIGN_RECORD_MAX_STATES,
  DESIGN_RECORD_MAX_TRANSITIONS,
  IDENTIFIER_PATTERN,
  PLAN_CHANGE_SHAPES,
  PLAN_TIERS,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_DRAFT_MAX_ITEMS,
  REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH,
  REVIEW_FINDING_SEVERITIES,
  STAGE_HANDOFF_OUTCOMES,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  WORK_ITEM_PHASES,
  WORKFLOW_STAGES,
} from "#shared/task-board-contract";
import { ContractValidationError, parseWorkflowPlanDraft } from "#shared/task-board-contract/validate";
import { ContainedCliAgentLauncher, RESULT_SCHEMA } from "#server/agents/task-worker/contained-cli-launcher";
import { agentPrompt, structuredOutcome } from "#server/agents/task-worker/agent-envelope";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";
import { parseAgentRunOutcome } from "#server/agents/task-worker/claim-parsers";
import { CLAUDE_PROFILE, CODEX_PROFILE } from "../runtime/profile-fixtures.js";
import { context, tempRoot, until } from "./helpers.js";

const PROMPTS = PromptRegistry.loadSync(resolve("config/prompts.md"));

function jsonSchemaAccepts(schemaValue: unknown, value: unknown): boolean {
  if (schemaValue === null || typeof schemaValue !== "object" || Array.isArray(schemaValue)) return false;
  const schema = schemaValue as Record<string, unknown>;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((candidate) => jsonSchemaAccepts(candidate, value));
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
  const acceptedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type !== undefined && !acceptedTypes.includes(actualType)) return false;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number") {
    if (actualType === "number" && acceptedTypes.includes("integer") && !Number.isInteger(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.multipleOf === "number" && value % schema.multipleOf !== 0) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
      return false;
    if (schema.items !== undefined && value.some((item) => !jsonSchemaAccepts(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((field) => typeof field !== "string" || !(field in object))
    )
      return false;
    if (
      schema.additionalProperties === false &&
      properties !== undefined &&
      Object.keys(object).some((field) => !(field in properties))
    )
      return false;
    if (
      properties !== undefined &&
      Object.entries(object).some(
        ([field, item]) => properties[field] !== undefined && !jsonSchemaAccepts(properties[field], item)
      )
    )
      return false;
  }
  return true;
}

function renderPrompt(request: Parameters<typeof agentPrompt>[0]): string {
  return agentPrompt(request, PROMPTS);
}

async function fakeCli(
  root: string,
  command: string,
  source: string
): Promise<{ bin: string; working: string; scratch: string }> {
  const bin = join(root, "bin");
  const working = join(root, "workspace");
  const scratch = join(root, "scratch");
  await mkdir(bin);
  await mkdir(working);
  await mkdir(scratch);
  const executable = join(bin, command);
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { bin, working, scratch };
}

function fakeCodex(root: string, source: string): Promise<{ bin: string; working: string; scratch: string }> {
  return fakeCli(root, "codex", source);
}

async function collectActivity(activity: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const result: RuntimeEvent[] = [];
  for await (const item of activity) result.push(item);
  return result;
}

test("generated provider schema is the launcher schema and derives contract enums", async () => {
  assert.equal(existsSync(join(process.cwd(), "src/server/agents/task-worker/agent-result.schema.json")), false);
  const generated = JSON.parse(
    await readFile(join(process.cwd(), "build/server/agents/task-worker/agent-result.schema.json"), "utf8")
  ) as unknown;
  assert.deepEqual(generated, RESULT_SCHEMA);
  assert.equal(RESULT_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(RESULT_SCHEMA.properties.gapReport.maxLength, AGENT_GAP_REPORT_MAX_CHARACTERS);
  assert.equal((RESULT_SCHEMA.required as readonly string[]).includes("gapReport"), false);
  assert.deepEqual(RESULT_SCHEMA.properties.phases.items.properties.stage.enum, TASK_PHASE_STAGES);
  assert.deepEqual(RESULT_SCHEMA.properties.phases.items.properties.status.enum, TASK_PHASE_STATUSES);
  assert.deepEqual(RESULT_SCHEMA.properties.handoff.anyOf[1].properties.outcome.enum, STAGE_HANDOFF_OUTCOMES);
  assert.deepEqual(RESULT_SCHEMA.properties.handoff.anyOf[1].properties.recommendedReturnStage.enum, [
    ...WORKFLOW_STAGES,
    null,
  ]);
  assert.equal(RESULT_SCHEMA.properties.reviewFindings.maxItems, REVIEW_FINDING_DRAFT_MAX_ITEMS);
  assert.equal(
    RESULT_SCHEMA.properties.reviewFindings.items.properties.expected.maxLength,
    REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH
  );
  assert.equal(
    RESULT_SCHEMA.properties.reviewFindings.items.properties.actual.maxLength,
    REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH
  );
  assert.deepEqual(RESULT_SCHEMA.properties.reviewFindings.items.properties.category.enum, REVIEW_FINDING_CATEGORIES);
  assert.deepEqual(RESULT_SCHEMA.properties.reviewFindings.items.properties.severity.enum, REVIEW_FINDING_SEVERITIES);
  assert.deepEqual(RESULT_SCHEMA.properties.reviewFindings.items.required, [
    "category",
    "severity",
    "expected",
    "actual",
  ]);
  assert.equal("blocking" in RESULT_SCHEMA.properties.reviewFindings.items.properties, false);
  assert.ok(RESULT_SCHEMA.required.includes("reviewFindings"));
  assert.ok(RESULT_SCHEMA.required.includes("designRecord"));
  assert.deepEqual(
    RESULT_SCHEMA.properties.designRecord.anyOf[1].properties.failurePoints.items.properties.point.enum,
    DESIGN_FAILURE_POINTS
  );
  assert.deepEqual(RESULT_SCHEMA.properties.designRecord.anyOf[1].required, [
    "states",
    "transitions",
    "failurePoints",
    "idempotencyKeys",
    "faultInjectionCases",
  ]);
  const designProperties = RESULT_SCHEMA.properties.designRecord.anyOf[1].properties;
  assert.equal(designProperties.states.maxItems, DESIGN_RECORD_MAX_STATES);
  assert.equal(designProperties.states.items.maxLength, DESIGN_RECORD_LABEL_MAX_LENGTH);
  assert.equal(designProperties.transitions.maxItems, DESIGN_RECORD_MAX_TRANSITIONS);
  assert.equal(
    designProperties.transitions.items.properties.durablePrecondition.maxLength,
    DESIGN_RECORD_DETAIL_MAX_LENGTH
  );
  assert.equal(designProperties.failurePoints.maxItems, DESIGN_RECORD_MAX_FAILURE_POINTS);
  assert.equal(designProperties.idempotencyKeys.maxItems, DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS);
  assert.equal(designProperties.faultInjectionCases.maxItems, DESIGN_RECORD_MAX_FAULT_INJECTION_CASES);
  assert.deepEqual(
    RESULT_SCHEMA.properties.workflowPlan.anyOf[1].properties.nodes.items.properties.stageTemplate.items.enum,
    WORKFLOW_STAGES
  );
  assert.deepEqual(RESULT_SCHEMA.properties.workflowPlan.anyOf[1].properties.changeShape.enum, PLAN_CHANGE_SHAPES);
  assert.deepEqual(RESULT_SCHEMA.properties.workflowPlan.anyOf[1].properties.tier.enum, PLAN_TIERS);
  assert.equal(RESULT_SCHEMA.properties.workflowPlan.anyOf[1].properties.declaredScope.minItems, 1);
  assert.equal(RESULT_SCHEMA.properties.workflowPlan.anyOf[1].properties.blockingQuestions.maxItems, 16);
  assert.equal(RESULT_SCHEMA.properties.workflowPlan.anyOf[1].properties.criterionChecks.maxItems, 32);
  assert.equal(RESULT_SCHEMA.properties.phases.items.properties.phaseId.pattern, IDENTIFIER_PATTERN);
  assert.equal(
    RESULT_SCHEMA.properties.workflowPlan.anyOf[1].properties.nodes.items.properties.nodeId.pattern,
    IDENTIFIER_PATTERN
  );
});

test("workflow plan child JSON schema stays in parity with the draft validator", () => {
  const children = [
    {
      key: "expand-provider",
      objective: "Publish the expanded provider interface.",
      projectId: "provider-project",
      declaredScope: ["src/provider/interface.ts", "docs/interface.md"],
      acceptanceCriteria: ["The expanded interface is verified."],
      phase: "expand",
      dependsOn: [],
      splitBy: "phase",
    },
    {
      key: "migrate-consumer",
      objective: "Migrate the consumer to the expanded interface.",
      projectId: "consumer-project",
      declaredScope: ["src/consumer"],
      acceptanceCriteria: ["The consumer uses the expanded interface."],
      phase: "migrate",
      dependsOn: ["expand-provider"],
      splitBy: "consumer",
    },
    {
      key: "contract-provider",
      objective: "Remove the old provider interface.",
      projectId: "provider-project",
      declaredScope: ["src/provider/interface.ts", "docs/interface.md"],
      acceptanceCriteria: ["The old interface is removed."],
      phase: "contract",
      dependsOn: ["migrate-consumer"],
      splitBy: "phase",
    },
  ] as const;
  const draft = {
    objective: "Coordinate a phased provider migration.",
    assumptions: [],
    acceptanceCriteria: ["Every phase is verified."],
    changeShape: "blast_radius",
    tier: "standard",
    declaredScope: ["src"],
    nonGoals: [],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    nodes: [
      {
        nodeId: "coordinate-provider-migration",
        title: "Coordinate provider migration",
        objective: "Keep the parent plan available for confirmation.",
        acceptanceCriteria: ["The declaration is durable."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
    children,
  } as const;
  const workflowSchema = RESULT_SCHEMA.properties.workflowPlan.anyOf[1];
  const childSchema = workflowSchema.properties.children.items;

  assert.equal(jsonSchemaAccepts(workflowSchema, draft), true);
  assert.deepEqual(parseWorkflowPlanDraft(draft).children, children);
  assert.deepEqual(childSchema.required, ["key", "objective", "projectId", "declaredScope", "acceptanceCriteria"]);
  assert.deepEqual(childSchema.properties.phase.enum, WORK_ITEM_PHASES);
  assert.deepEqual(childSchema.properties.splitBy.enum, ["consumer", "phase"]);
  assert.equal(childSchema.properties.dependsOn.uniqueItems, true);
  assert.throws(() => parseWorkflowPlanDraft({ ...draft, children: undefined }), ContractValidationError);
});

test("structured provider outcomes accept and thread an optional bounded gap report", () => {
  const gapReport = "# Gaps\n\n- Branch protection is deferred.";
  const outcome = structuredOutcome({
    status: "completed",
    progress: [],
    result: "Onboarding implementation completed.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: null,
    workflowPlan: null,
    reviewFindings: [],
    designRecord: null,
    gapReport,
    detail: "Onboarding implementation completed.",
  });

  assert.equal(outcome.gapReport, gapReport);
  assert.throws(
    () =>
      structuredOutcome({
        status: "completed",
        progress: [],
        result: "Onboarding implementation completed.",
        proposedChildTasks: [],
        expectedAgentMinutes: null,
        phases: [],
        humanQuestion: null,
        handoff: null,
        workflowPlan: null,
        reviewFindings: [],
        designRecord: null,
        gapReport: "x".repeat(AGENT_GAP_REPORT_MAX_CHARACTERS + 1),
        detail: "Onboarding implementation completed.",
      }),
    /gapReport/u
  );
});

test("structured provider outcomes retain completed work with credential spans redacted", () => {
  const credential = "ghp_abcdefghijklmnop";
  const outcome = structuredOutcome({
    status: "completed",
    progress: [`Removed ${credential} from the fixture.`],
    result: `Completed after replacing ${credential} safely.`,
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    detail: `Verified without ${credential} present.`,
  });

  assert.deepEqual(outcome.outputs, [
    { type: "progress", body: "Removed [redacted: credential] from the fixture." },
    { type: "result", body: "Completed after replacing [redacted: credential] safely." },
  ]);
  assert.equal(outcome.detail, "Verified without [redacted: credential] present.");
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(credential, "u"));
});

test("structured provider outcomes remain completed when redaction grows a field past its schema bound", () => {
  const credential = "AKIA1234567890ABCDEF";
  const resultPrefix = `${"x".repeat(4_000 - credential.length - 1)} `;
  const result = `${resultPrefix}${credential}`;
  const outcome = structuredOutcome({
    status: "completed",
    progress: [],
    result,
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    detail: "Done.",
  });

  const completed = outcome.outputs.at(-1);
  assert.equal(outcome.status, "completed");
  assert.equal(completed?.type === "result" ? completed.body : null, `${resultPrefix.slice(2)}[redacted: credential]`);
  assert.doesNotThrow(() => parseAgentRunOutcome(outcome));
});

test("manager planning prompt branches on intake rather than the task title", () => {
  const titlePrefixed = renderPrompt({
    runId: "run-title-prefix",
    wakeReason: "human_assignment",
    context: context({
      intake: false,
      design: false,
      mission: { role: "manager", area: "Release oversight", mission: "Review evidence and risks." },
      task: { ...context().task, title: "Plan workflow: this is ordinary oversight" },
    }),
  });
  assert.match(titlePrefixed, /Perform read-only oversight/u);
  assert.doesNotMatch(titlePrefixed, /single-implementation pipeline plan/u);

  const intakePrompt = renderPrompt({
    runId: "run-intake",
    wakeReason: "human_assignment",
    context: context({
      intake: true,
      design: false,
      mission: { role: "manager", area: "Release oversight", mission: "Review evidence and risks." },
      task: { ...context().task, title: "Refine a request without the legacy prefix" },
    }),
  });
  assert.match(intakePrompt, /Refine the supplied request into a small dependency-aware workflow plan/u);
  assert.match(
    intakePrompt,
    /For a single-implementation pipeline plan, return exactly one node with stageTemplate \["implementation","testing","verification"\] \(Implement, machine Verify, then an independent review\)/u
  );
  assert.match(
    intakePrompt,
    /For blast_radius plans, include children with key, objective, projectId, declaredScope, acceptanceCriteria, splitBy, and optional phase and dependsOn/u
  );
  assert.match(intakePrompt, /Apply the reversibility test/u);
});

test("runs one real contained Codex process with bounded full-task context", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(
    root,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "prompt.txt"), input);
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "args.json"), JSON.stringify(process.argv.slice(2)));
  const result = {
    status: "completed",
    progress: ["The focused retry checks pass."],
    result: "Customers can retry checkout without a duplicate charge.",
    proposedChildTasks: [],
    expectedAgentMinutes: 45,
    phases: [],
    humanQuestion: null,
    detail: "Checkout retries are now idempotent and tested."
  };
  process.stdout.write('{"type":"thread.started","thread_id":"secret');
  process.stdout.write('-thread"}\\n');
  process.stdout.write(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"cat /Users/alice/private.txt",aggregated_output:"sk-proj-provider-secret-token"}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"command_execution",exit_code:0,aggregated_output:"STEWARD_ESTIMATE_MINUTES=45\\n"}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
});
`
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: {
      PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: fixture.scratch,
    },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });

  const handle = await launcher.launch({
    runId: "run-contained-one",
    wakeReason: "human_assignment",
    context: context(),
  });
  const activity = collectActivity(handle.activity);
  const outcome = await handle.completion;
  const observedActivity = await activity;

  assert.equal(outcome.status, "completed");
  assert.deepEqual(
    outcome.outputs.map((output) => output.type),
    ["progress", "result"]
  );
  assert.deepEqual(observedActivity, [
    { type: "stage_started" },
    { type: "tool_call", name: "command", detail: "cat /Users/alice/private.txt" },
    { type: "tool_result", name: "command", output: "STEWARD_ESTIMATE_MINUTES=45\n", failed: false },
    {
      type: "message_delta",
      text: JSON.stringify({
        status: "completed",
        progress: ["The focused retry checks pass."],
        result: "Customers can retry checkout without a duplicate charge.",
        proposedChildTasks: [],
        expectedAgentMinutes: 45,
        phases: [],
        humanQuestion: null,
        detail: "Checkout retries are now idempotent and tested.",
      }),
    },
    { type: "stage_finished" },
  ]);
  assert.equal(
    observedActivity.filter((event) => event.type === "credential_redaction").length,
    0,
    "a run with nothing to redact stays silent"
  );
  const prompt = await readFile(join(fixture.scratch, "prompt.txt"), "utf8");
  assert.match(prompt, /research → plan → execute → test/u);
  assert.match(prompt, /single event-triggered run/u);
  assert.match(prompt, /Never deploy/u);
  assert.match(prompt, /STEWARD_ESTIMATE_MINUTES=N/u);
  const args = JSON.parse(await readFile(join(fixture.scratch, "args.json"), "utf8")) as string[];
  assert.ok(args.includes("workspace-write"));
  const outputSchema = args.indexOf("--output-schema");
  assert.notEqual(outputSchema, -1);
  const codexSchema = JSON.parse(await readFile(args[outputSchema + 1]!, "utf8")) as { readonly $schema?: unknown };
  assert.equal(codexSchema.$schema, RESULT_SCHEMA.$schema);
});

test("redacts contained context and diagnostics without aborting the run", async () => {
  const credential = "ghp_abcdefghijklmnop";
  const baseContext = context();
  const root = await tempRoot();
  const fixture = await fakeCodex(
    root,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "redacted-prompt.txt"), input);
  process.stderr.write(${JSON.stringify(`Diagnostic contained <${credential}>; keep this.`)});
  const result = {status:"completed",progress:[],result:${JSON.stringify(`Done after ${credential}.`)},proposedChildTasks:[],expectedAgentMinutes:null,phases:[],humanQuestion:null,detail:"Done."};
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}));
  console.log(JSON.stringify({type:"turn.completed"}));
});
`
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: {
      PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: fixture.scratch,
    },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });

  const handle = await launcher.launch({
    runId: "run-contained-redaction",
    wakeReason: "human_assignment",
    context: context({
      projectMemory: "Reference https://github.com and keep this field.",
      task: {
        ...baseContext.task,
        objective: "Rotate the -----BEGIN PRIVATE KEY----- described in the runbook.",
        acceptanceCriteria: "Keep git@github.com:org/repo.git and this field intact.",
      },
      messages: [
        ...baseContext.messages,
        {
          messageId: "message-three",
          cursor: 3,
          author: "human",
          body: `Remove ${credential} from the fixture.`,
          createdAt: "2026-07-19T20:00:00.000Z",
        },
      ],
      nextMessageCursor: 3,
    }),
  });

  const outcome = await handle.completion;
  assert.equal(outcome.status, "completed");
  const activity: RuntimeEvent[] = [];
  for await (const event of handle.activity) activity.push(event);
  const prompt = await readFile(join(fixture.scratch, "redacted-prompt.txt"), "utf8");
  assert.match(prompt, /"objective":"Rotate the \[redacted: credential\]"/u);
  assert.match(prompt, /"projectMemory":"Reference https:\/\/github\.com and keep this field\."/u);
  assert.match(prompt, /"acceptanceCriteria":"Keep git@github\.com:org\/repo\.git and this field intact\."/u);
  assert.match(prompt, /Remove \[redacted: credential\] from the fixture\./u);
  assert.doesNotMatch(prompt, new RegExp(credential, "u"));
  assert.deepEqual(
    activity.filter((event) => event.type === "credential_redaction"),
    [
      { type: "credential_redaction", site: "context", patternName: "privateKey", count: 1 },
      { type: "credential_redaction", site: "context", patternName: "prefixedToken", count: 1 },
      { type: "credential_redaction", site: "provider_outcome", patternName: "prefixedToken", count: 1 },
      { type: "credential_redaction", site: "diagnostics", patternName: "prefixedToken", count: 1 },
    ]
  );
  assert.deepEqual(
    activity.find((event) => event.type === "tool_result" && event.name === "diagnostics"),
    {
      type: "tool_result",
      name: "diagnostics",
      output: "Diagnostic contained <[redacted: credential]>; keep this.",
    }
  );
  assert.match(JSON.stringify(outcome), /Done after \[redacted: credential\]/u);
  assert.doesNotMatch(JSON.stringify({ activity, outcome, prompt }), new RegExp(credential, "u"));
});

test("spawns the binary selected by the runtime profile", async () => {
  const root = await tempRoot();
  const fixture = await fakeCli(
    root,
    "profile-codex",
    `
process.stdin.resume();
process.stdin.on("end", () => {
  const result = {status:"completed",progress:[],result:"Done.",proposedChildTasks:[],expectedAgentMinutes:null,phases:[],humanQuestion:null,detail:"Done."};
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}));
  console.log(JSON.stringify({type:"turn.completed"}));
});
`
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: { ...CODEX_PROFILE, binary: "profile-codex" },
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: {
      PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: fixture.scratch,
    },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });

  const handle = await launcher.launch({
    runId: "run-profile-binary",
    wakeReason: "human_assignment",
    context: context(),
  });
  assert.equal((await handle.completion).status, "completed");
});

test("parses Claude stream-json activity while preserving its terminal structured result", async () => {
  const root = await tempRoot();
  const fixture = await fakeCli(
    root,
    "claude",
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "prompt.txt"), input);',
      '  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "args.json"), JSON.stringify(process.argv.slice(2)));',
      '  const result = {status:"completed",progress:["The focused checks pass."],result:"Customers see a reliable checkout retry.",proposedChildTasks:[],expectedAgentMinutes:45,phases:[],humanQuestion:null,detail:"The checkout retry is implemented and verified."};',
      '  console.log(JSON.stringify({type:"system",subtype:"init",cwd:"/Users/alice/private-repo",session_id:"secret-session"}));',
      '  console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Read",input:{file_path:"/Users/alice/private.ts",token:"sk-ant-provider-secret"}}]}}));',
      '  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,structured_output:result,result:"raw terminal text"}));',
      "});",
    ].join("\n")
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: claudeAdapter,
    profile: CLAUDE_PROFILE,
    prompts: PROMPTS,
    model: "claude-test-model",
    workingDirectory: fixture.working,
    environment: {
      PATH: fixture.bin + delimiter + (process.env.PATH ?? ""),
      TMPDIR: fixture.scratch,
    },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });

  const handle = await launcher.launch({
    runId: "run-claude-one",
    wakeReason: "human_assignment",
    context: context(),
  });
  const activity = collectActivity(handle.activity);
  const outcome = await handle.completion;
  const observedActivity = await activity;

  assert.equal(outcome.status, "completed");
  assert.deepEqual(
    outcome.outputs.map((output) => output.type),
    ["progress", "result"]
  );
  const result = outcome.outputs.at(-1);
  assert.equal(result?.type === "result" ? result.body : null, "Customers see a reliable checkout retry.");
  assert.deepEqual(observedActivity, [
    { type: "stage_started" },
    {
      type: "tool_call",
      name: "Read",
      detail: '{"file_path":"/Users/alice/private.ts","token":"[redacted: credential]"}',
    },
    { type: "stage_finished" },
  ]);
  assert.doesNotMatch(JSON.stringify(observedActivity), /sk-ant-provider-secret/u);
  const args = JSON.parse(await readFile(join(fixture.scratch, "args.json"), "utf8")) as string[];
  const outputFormat = args.indexOf("--output-format");
  assert.notEqual(outputFormat, -1);
  assert.equal(args[outputFormat + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  const jsonSchema = args.indexOf("--json-schema");
  assert.notEqual(jsonSchema, -1);
  assert.equal((JSON.parse(args[jsonSchema + 1]!) as { readonly $schema?: unknown }).$schema, RESULT_SCHEMA.$schema);
  assert.ok(!args.includes("--bare"), "OAuth/keychain authentication remains available without an API key");
});

test("uses Claude bare mode when an explicit API key supplies authentication", async () => {
  const root = await tempRoot();
  const fixture = await fakeCli(
    root,
    "claude",
    [
      "process.stdin.resume();",
      'process.stdin.on("end", () => {',
      '  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "args.json"), JSON.stringify(process.argv.slice(2)));',
      '  const result = {status:"completed",progress:[],result:"Done.",proposedChildTasks:[],expectedAgentMinutes:null,phases:[],humanQuestion:null,detail:"Done."};',
      '  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,structured_output:result}));',
      "});",
    ].join("\n")
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: claudeAdapter,
    profile: CLAUDE_PROFILE,
    prompts: PROMPTS,
    model: "claude-test-model",
    workingDirectory: fixture.working,
    environment: {
      PATH: fixture.bin + delimiter + (process.env.PATH ?? ""),
      TMPDIR: fixture.scratch,
      ANTHROPIC_API_KEY: "unit-test-api-key-not-a-real-secret",
    },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });

  const handle = await launcher.launch({
    runId: "run-claude-bare-auth",
    wakeReason: "human_assignment",
    context: context(),
  });
  await handle.completion;
  const args = JSON.parse(await readFile(join(fixture.scratch, "args.json"), "utf8")) as string[];
  assert.ok(args.includes("--bare"));
});

test("manager role with a legacy planning title and no intake signal is launched with an oversight prompt", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(
    root,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "prompt.txt"), input);
  require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "args.json"), JSON.stringify(process.argv.slice(2)));
  const result = {status:"completed",progress:[],result:"The evidence is ready for human review.",proposedChildTasks:[],expectedAgentMinutes:30,phases:[],humanQuestion:null,detail:"Oversight completed."};
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}));
  console.log(JSON.stringify({type:"turn.completed"}));
});
`
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: { PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: fixture.scratch },
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    groupAbsenceTimeoutMs: 2_000,
  });
  const handle = await launcher.launch({
    runId: "run-manager-one",
    wakeReason: "human_assignment",
    context: context({
      intake: false,
      design: false,
      mission: { role: "manager", area: "Release oversight", mission: "Review evidence and risks." },
      task: { ...context().task, title: "Plan workflow: review this without intake authority" },
    }),
  });
  await handle.completion;
  const args = JSON.parse(await readFile(join(fixture.scratch, "args.json"), "utf8")) as string[];
  assert.ok(args.includes("read-only"));
  assert.match(await readFile(join(fixture.scratch, "prompt.txt"), "utf8"), /read-only oversight/u);
  assert.match(
    await readFile(join(fixture.scratch, "prompt.txt"), "utf8"),
    /READY_FOR_HUMAN_CHECK or CHANGES_REQUESTED/u
  );
});

test("rejects a missing role capability at launch before spawning the runtime", async () => {
  const root = await tempRoot();
  const workingDirectory = join(root, "workspace");
  await mkdir(workingDirectory);
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: {
      ...CODEX_PROFILE,
      roles: { manager: { sandbox: "read-only" }, verifier: { sandbox: "read-only" } },
    },
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory,
    environment: { PATH: process.env.PATH },
  });

  await assert.rejects(
    launcher.launch({
      runId: "run-missing-capability",
      wakeReason: "human_assignment",
      context: context(),
    }),
    (error: unknown) =>
      error instanceof RuntimeCapabilityError && error.runtime === "codex" && error.role === "engineer"
  );
});

test("direct interrupt kills and confirms absence of the entire OS process group", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(
    root,
    `
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");
fs.writeFileSync(path.join(process.env.TMPDIR, "pid.txt"), String(process.pid));
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:"ignore"});
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: { PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: fixture.scratch },
    timeoutMs: 10_000,
    terminationGraceMs: 20,
    groupAbsenceTimeoutMs: 2_000,
  });
  const handle = await launcher.launch({
    runId: "run-interrupt-one",
    wakeReason: "human_assignment",
    context: context(),
  });
  const completion = handle.completion;
  void completion.catch(() => undefined);
  const marker = join(fixture.scratch, "pid.txt");
  await until(() => existsSync(marker), "fake agent process");
  const groupId = Number(await readFile(marker, "utf8"));
  await handle.interrupt("Human interrupted this agent run");
  await assert.rejects(completion, /interrupted/u);
  assert.throws(
    () => process.kill(-groupId, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"
  );
});

test("direct interrupt cannot let a credential-like reason prevent process-group termination", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(
    root,
    `
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");
fs.writeFileSync(path.join(process.env.TMPDIR, "pid.txt"), String(process.pid));
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:"ignore"});
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: { PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: fixture.scratch },
    timeoutMs: 10_000,
    terminationGraceMs: 20,
    groupAbsenceTimeoutMs: 2_000,
  });
  const handle = await launcher.launch({
    runId: "run-interrupt-secret",
    wakeReason: "human_assignment",
    context: context(),
  });
  const completion = handle.completion;
  void completion.catch(() => undefined);
  const marker = join(fixture.scratch, "pid.txt");
  await until(() => existsSync(marker), "fake agent process");
  const groupId = Number(await readFile(marker, "utf8"));
  try {
    await handle.interrupt("Human reported sk-proj-0123456789abcdef in the interrupt reason");
    await assert.rejects(completion, /interrupted/u);
    assert.throws(
      () => process.kill(-groupId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  } finally {
    try {
      process.kill(-groupId, "SIGKILL");
    } catch {}
  }
});

test("direct interrupt shares an in-flight termination but clears a rejected launcher attempt for retry", async () => {
  const root = await tempRoot();
  const fixture = await fakeCodex(
    root,
    `
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.env.TMPDIR, "pid.txt"), String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`
  );
  const launcher = new ContainedCliAgentLauncher({
    adapter: codexAdapter,
    profile: CODEX_PROFILE,
    prompts: PROMPTS,
    model: "codex-test-model",
    workingDirectory: fixture.working,
    environment: { PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: fixture.scratch },
    timeoutMs: 10_000,
    terminationGraceMs: 20,
    groupAbsenceTimeoutMs: 2_000,
  });
  const handle = await launcher.launch({
    runId: "run-interrupt-retry",
    wakeReason: "human_assignment",
    context: context(),
  });
  const completion = handle.completion;
  void completion.catch(() => undefined);
  const marker = join(fixture.scratch, "pid.txt");
  await until(() => existsSync(marker), "fake agent process");
  const groupId = Number(await readFile(marker, "utf8"));
  const originalKill = process.kill;
  let sigtermAttempts = 0;
  Object.defineProperty(process, "kill", {
    configurable: true,
    value: ((pid: number, signal?: NodeJS.Signals | number): true => {
      if (pid === -groupId && signal === "SIGTERM") {
        sigtermAttempts += 1;
        if (sigtermAttempts === 1) {
          const error = new Error("Simulated first signal failure") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      }
      return originalKill(pid, signal);
    }) satisfies typeof process.kill,
  });
  try {
    const first = handle.interrupt("Human interrupted this agent run");
    const concurrent = handle.interrupt("Human interrupted this agent run");
    await Promise.all([
      assert.rejects(first, /first signal failure/u),
      assert.rejects(concurrent, /first signal failure/u),
    ]);
    assert.equal(sigtermAttempts, 1);

    await handle.interrupt("Human retried the interrupt");
    assert.equal(sigtermAttempts, 2);
    await assert.rejects(completion, /interrupted/u);
    assert.throws(
      () => originalKill(-groupId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  } finally {
    Object.defineProperty(process, "kill", { configurable: true, value: originalKill });
    try {
      originalKill(-groupId, "SIGKILL");
    } catch {}
  }
});
