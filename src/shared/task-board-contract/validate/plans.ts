/** Applies the plan-draft policy shared by the board and worker boundaries. */

/* —— Imports —— */

import {
  AGENT_GAP_REPORT_MAX_CHARACTERS,
  ContractValidationError,
  type DeclaredChild,
  PLAN_CHANGE_SHAPES,
  PLAN_TIERS,
  type PlanRecordFields,
  STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
  STAGE_HANDOFF_OUTCOMES,
  STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS,
  type StageHandoffDraft,
  WORKFLOW_STAGES,
  WORK_ITEM_PHASES,
  type WorkflowPlanDraft,
  type NodeStage,
  declaredScopesOverlap,
  normalizeDeclaredScope,
} from "../index.js";
import {
  PLAN_RECORD_FIELD_NAMES,
  boundedPlanArray,
  expectedMinutes,
  parseDesignRecordDraft,
  parseReviewFindingDraftList,
  planCheck,
  planScopeEntry,
} from "./entities.js";
import {
  type ExactMessageMap,
  GENERIC_EXACT_MESSAGES,
  type JsonRecord,
  contractMember,
  exact,
  identifier,
  prose,
  record,
  text,
} from "./scalars.js";
import {
  MAX_OUTCOME_BYTES,
  type ValidatedAgentRunOutcome,
  boundedJsonValue,
  parseWorkerAgentRunOutput,
  parseWorkerPhaseUpdate,
  workerProse,
} from "./worker.js";

/* —— Shared plan-draft policy —— */

interface DraftMessageMap {
  readonly handoffLabel: string;
  readonly handoffObjectInvalid?: string;
  readonly handoffCriteriaInvalid: string;
  readonly handoffCriterionLabel: (index: number) => string;
  readonly handoffCriterionResultInvalid: (index: number) => string;
  readonly criterionLabel: string;
  readonly criterionEvidenceLabel: string;
  readonly handoffOutcomeLabel: string;
  readonly handoffReturnStageLabel: string;
  readonly workflowPlanLabel: string;
  readonly workflowNodesInvalid: string;
  readonly workflowNodeLabel: (index: number) => string;
  readonly workflowNodeStagesInvalid: (index: number) => string;
  readonly workflowNodeStageLabel: (index: number, stageIndex: number) => string;
  readonly workflowNodeStageOrderInvalid: (index: number) => string;
}

interface DraftParserPolicy {
  readonly exactMessages: ExactMessageMap;
  readonly textKind: "prose" | "text";
  readonly stageListKind: "members" | "strings";
  readonly messages: DraftMessageMap;
}

const WORKER_DRAFT_POLICY: DraftParserPolicy = Object.freeze({
  exactMessages: GENERIC_EXACT_MESSAGES,
  textKind: "prose",
  stageListKind: "members",
  messages: Object.freeze({
    handoffLabel: "Stage handoff",
    handoffCriteriaInvalid: "Stage handoff criteria are invalid",
    handoffCriterionLabel: (index: number) => `Stage handoff criterion ${index}`,
    handoffCriterionResultInvalid: (index: number) => `Stage handoff criterion ${index} result is invalid`,
    criterionLabel: "criterion",
    criterionEvidenceLabel: "criterion evidence",
    handoffOutcomeLabel: "Stage handoff outcome",
    handoffReturnStageLabel: "Stage handoff return stage",
    workflowPlanLabel: "Workflow plan",
    workflowNodesInvalid: "Workflow plan nodes are invalid",
    workflowNodeLabel: (index: number) => `Workflow plan node ${index}`,
    workflowNodeStagesInvalid: (index: number) => `Workflow plan node ${index} stages are invalid`,
    workflowNodeStageLabel: (index: number, stageIndex: number) => `Workflow plan node ${index} stage ${stageIndex}`,
    workflowNodeStageOrderInvalid: (index: number) => `Workflow plan node ${index} stage order is invalid`,
  }),
});

export const BOARD_DRAFT_POLICY: DraftParserPolicy = Object.freeze({
  exactMessages: GENERIC_EXACT_MESSAGES,
  textKind: "text",
  stageListKind: "strings",
  messages: Object.freeze({
    handoffLabel: "handoff",
    handoffObjectInvalid: "handoff is invalid",
    handoffCriteriaInvalid: "handoff criteria are invalid",
    handoffCriterionLabel: (index: number) => `handoff criterion ${index}`,
    handoffCriterionResultInvalid: () => "handoff criterion result is invalid",
    criterionLabel: "criterion",
    criterionEvidenceLabel: "evidence",
    handoffOutcomeLabel: "handoff outcome",
    handoffReturnStageLabel: "handoff return stage",
    workflowPlanLabel: "workflowPlan",
    workflowNodesInvalid: "workflowPlan.nodes is invalid",
    workflowNodeLabel: (index: number) => `workflowPlan.nodes[${index}]`,
    workflowNodeStagesInvalid: (index: number) => `workflowPlan.nodes[${index}].stageTemplate is invalid`,
    workflowNodeStageLabel: (index: number, stageIndex: number) =>
      `workflowPlan.nodes[${index}].stageTemplate[${stageIndex}]`,
    workflowNodeStageOrderInvalid: (index: number) => `workflowPlan.nodes[${index}].stageTemplate is invalid`,
  }),
});

function draftExact(value: unknown, fields: readonly string[], label: string, policy: DraftParserPolicy): JsonRecord {
  return exact(value, fields, label, { messages: policy.exactMessages });
}

function draftText(value: unknown, label: string, maximum: number, policy: DraftParserPolicy): string {
  return policy.textKind === "prose"
    ? prose(value, label, { maximum, carriageReturns: "preserve" })
    : text(value, label, { maximum, message: `${label} is invalid` });
}

function draftStringList(
  value: unknown,
  label: string,
  policy: DraftParserPolicy,
  maximum = 32,
  minimum = 0
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  return Object.freeze(value.map((entry, index) => draftText(entry, `${label}[${index}]`, 2_000, policy)));
}

export function parseHandoffDraft(value: unknown, policy: DraftParserPolicy): StageHandoffDraft {
  const messages = policy.messages;
  if (
    messages.handoffObjectInvalid !== undefined &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  ) {
    throw new ContractValidationError(messages.handoffObjectInvalid);
  }
  const item = draftExact(
    value,
    ["outcome", "summary", "evidence", "artifactIds", "acceptanceCriteria", "blockers", "recommendedReturnStage"],
    messages.handoffLabel,
    policy
  );
  if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length > 32) {
    throw new ContractValidationError(messages.handoffCriteriaInvalid);
  }
  const criteria = item.acceptanceCriteria.map((entry, index) => {
    const criterion = draftExact(
      entry,
      ["criterion", "passed", "evidence"],
      messages.handoffCriterionLabel(index),
      policy
    );
    if (typeof criterion.passed !== "boolean")
      throw new ContractValidationError(messages.handoffCriterionResultInvalid(index));
    return Object.freeze({
      criterion: draftText(criterion.criterion, messages.criterionLabel, 1_000, policy),
      passed: criterion.passed,
      evidence: draftText(criterion.evidence, messages.criterionEvidenceLabel, 2_000, policy),
    });
  });
  return Object.freeze({
    outcome: contractMember(item.outcome, STAGE_HANDOFF_OUTCOMES, messages.handoffOutcomeLabel),
    summary: draftText(item.summary, "handoff.summary", STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS, policy),
    evidence: draftStringList(item.evidence, "handoff.evidence", policy),
    artifactIds: draftStringList(item.artifactIds, "handoff.artifactIds", policy),
    acceptanceCriteria: Object.freeze(criteria),
    blockers: draftStringList(item.blockers, "handoff.blockers", policy, STAGE_HANDOFF_BLOCKERS_MAX_ITEMS),
    recommendedReturnStage:
      item.recommendedReturnStage === null
        ? null
        : contractMember(item.recommendedReturnStage, WORKFLOW_STAGES, messages.handoffReturnStageLabel),
  });
}

function parseDeclaredChild(value: unknown, label: string, policy: DraftParserPolicy): DeclaredChild {
  const required = ["key", "objective", "projectId", "declaredScope", "acceptanceCriteria"];
  const item = exact(value, [...required, "repositoryId", "phase", "dependsOn", "splitBy"], label, {
    messages: policy.exactMessages,
    required,
  });
  const parseText = (entry: unknown, entryLabel: string, maximum: number): string =>
    draftText(entry, entryLabel, maximum, policy);
  return Object.freeze({
    key: identifier(item.key, `${label}.key`),
    objective: draftText(item.objective, `${label}.objective`, 4_000, policy),
    projectId: identifier(item.projectId, `${label}.projectId`),
    ...(item.repositoryId === undefined
      ? {}
      : { repositoryId: identifier(item.repositoryId, `${label}.repositoryId`) }),
    declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64, (entry, entryLabel) =>
      planScopeEntry(entry, entryLabel, parseText)
    ),
    acceptanceCriteria: draftStringList(item.acceptanceCriteria, `${label}.acceptanceCriteria`, policy, 64, 1),
    ...(item.phase === undefined
      ? {}
      : {
          phase: contractMember(item.phase, WORK_ITEM_PHASES, `${label}.phase`, `${label}.phase is invalid`),
        }),
    ...(item.dependsOn === undefined
      ? {}
      : {
          dependsOn: Object.freeze(
            draftStringList(item.dependsOn, `${label}.dependsOn`, policy, 64).map((dependency, dependencyIndex) =>
              identifier(dependency, `${label}.dependsOn[${dependencyIndex}]`)
            )
          ),
        }),
    ...(item.splitBy === undefined
      ? {}
      : {
          splitBy: contractMember(
            item.splitBy,
            ["consumer", "phase"] as const,
            `${label}.splitBy`,
            `${label}.splitBy is invalid`
          ),
        }),
  });
}

/**
 * Two children share a checkout when they name the same project *and* the same
 * repository within it.
 *
 * Campaign 10 could equate "different repository" with "different project",
 * because a project had exactly one. Campaign 16 breaks that: a product may span
 * repositories inside one project, so the phased rules below have to discriminate
 * on the pair. `undefined` here means "the project's primary", which two children
 * of one project genuinely do share — so absent-vs-absent still collides, and
 * that keeps every pre-campaign plan meaning what it meant.
 *
 * What this cannot see is a child naming the primary explicitly beside one that
 * omits it: equal after resolution, distinct here. The contract has no database,
 * so materialization owns that case.
 */
function sharesCheckout(a: DeclaredChild, b: DeclaredChild): boolean {
  return a.projectId === b.projectId && (a.repositoryId ?? null) === (b.repositoryId ?? null);
}

export function validateWorkflowPlanChildren(
  plan: Pick<WorkflowPlanDraft, "changeShape" | "children">,
  parentProjectId?: string,
  parentWorkItemId?: string | null
): void {
  const children = plan.children;
  const hasChildren = children !== undefined && children.length > 0;
  if (parentWorkItemId !== undefined && parentWorkItemId !== null && hasChildren) {
    throw new ContractValidationError("workflowPlan.children is invalid for a child work item");
  }
  if (plan.changeShape === "mechanical_sweep" && hasChildren) {
    throw new ContractValidationError("workflowPlan.children is invalid for a mechanical_sweep");
  }
  if (plan.changeShape === "blast_radius" && !hasChildren) {
    throw new ContractValidationError("workflowPlan.children is required for a blast_radius");
  }
  if (!hasChildren) return;
  if (plan.changeShape === "blast_radius" && children.some((child) => child.splitBy === undefined)) {
    throw new ContractValidationError("every blast_radius child requires splitBy");
  }
  const phasedChildren = children.filter((child) => child.phase !== undefined);
  if (phasedChildren.length > 0 && phasedChildren.length !== children.length) {
    throw new ContractValidationError("every workflowPlan child requires phase when any phase is declared");
  }
  if (plan.changeShape === "feature" && phasedChildren.length > 0) {
    throw new ContractValidationError("workflowPlan.children phases are invalid for a feature split");
  }

  const childrenByKey = new Map<string, DeclaredChild>();
  for (const child of children) {
    if (childrenByKey.has(child.key)) {
      throw new ContractValidationError("workflowPlan.children contains a duplicate key");
    }
    childrenByKey.set(child.key, child);
    const dependencies = child.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      throw new ContractValidationError(`workflowPlan child ${child.key} contains a duplicate dependency`);
    }
  }
  for (const child of children) {
    for (const dependency of child.dependsOn ?? []) {
      if (!childrenByKey.has(dependency)) {
        throw new ContractValidationError(`workflowPlan child ${child.key} has an unknown dependency`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new ContractValidationError("workflowPlan.children contains a dependency cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of childrenByKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const child of children) visit(child.key);

  for (let left = 0; left < children.length; left += 1) {
    for (let right = left + 1; right < children.length; right += 1) {
      const a = children[left]!;
      const b = children[right]!;
      const requiresDisjointScopes =
        (a.phase === undefined && b.phase === undefined) || (a.phase === "migrate" && b.phase === "migrate");
      if (requiresDisjointScopes && sharesCheckout(a, b) && declaredScopesOverlap(a.declaredScope, b.declaredScope)) {
        throw new ContractValidationError(`workflowPlan child scopes overlap in project ${a.projectId}`);
      }
    }
  }

  if (phasedChildren.length === 0) return;
  const expands = children.filter((child) => child.phase === "expand");
  const migrates = children.filter((child) => child.phase === "migrate");
  const contracts = children.filter((child) => child.phase === "contract");
  if (expands.length !== 1 || migrates.length < 1 || contracts.length !== 1) {
    throw new ContractValidationError("workflowPlan.children has an invalid phased declaration");
  }
  const expand = expands[0]!;
  const contract = contracts[0]!;
  const publishedInterfacePath = "docs/interface.md";
  const coversPublishedInterface = (child: DeclaredChild): boolean =>
    normalizeDeclaredScope(child.declaredScope).some(
      (prefix) => publishedInterfacePath === prefix || publishedInterfacePath.startsWith(`${prefix}/`)
    );
  if (!coversPublishedInterface(expand)) {
    throw new ContractValidationError(`expand child declaredScope must cover ${publishedInterfacePath}`);
  }
  if (!coversPublishedInterface(contract)) {
    throw new ContractValidationError(`contract child declaredScope must cover ${publishedInterfacePath}`);
  }
  const providerProjectId = parentProjectId ?? expand.projectId;
  if (expand.projectId !== providerProjectId || contract.projectId !== providerProjectId) {
    throw new ContractValidationError("expand and contract children must use the parent project");
  }
  if (migrates.some((child) => sharesCheckout(child, expand))) {
    throw new ContractValidationError("migrate children must use a repository other than the provider's");
  }
  if (migrates.some((child) => !(child.dependsOn ?? []).includes(expand.key))) {
    throw new ContractValidationError("every migrate child must depend on the expand child");
  }
  const contractDependencies = new Set(contract.dependsOn ?? []);
  if (migrates.some((child) => !contractDependencies.has(child.key))) {
    throw new ContractValidationError("the contract child must depend on every migrate child");
  }
}

function parseDraftPlanRecord(item: JsonRecord, label: string, policy: DraftParserPolicy): PlanRecordFields {
  const parseText = (value: unknown, field: string, maximum: number): string =>
    draftText(value, field, maximum, policy);
  return Object.freeze({
    ...(item.changeShape === undefined
      ? {}
      : {
          changeShape: contractMember(
            item.changeShape,
            PLAN_CHANGE_SHAPES,
            `${label}.changeShape`,
            `${label}.changeShape is invalid`
          ),
        }),
    ...(item.tier === undefined
      ? {}
      : {
          tier: contractMember(item.tier, PLAN_TIERS, `${label}.tier`, `${label}.tier is invalid`),
        }),
    ...(item.declaredScope === undefined
      ? {}
      : {
          declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64, (entry, entryLabel) =>
            planScopeEntry(entry, entryLabel, parseText)
          ),
        }),
    ...(item.nonGoals === undefined
      ? {}
      : {
          nonGoals: boundedPlanArray(item.nonGoals, `${label}.nonGoals`, 0, 32, (entry, entryLabel) =>
            parseText(entry, entryLabel, 1_000)
          ),
        }),
    ...(item.mechanicalPortions === undefined
      ? {}
      : {
          mechanicalPortions: boundedPlanArray(
            item.mechanicalPortions,
            `${label}.mechanicalPortions`,
            0,
            32,
            (entry, entryLabel) => parseText(entry, entryLabel, 1_000)
          ),
        }),
    ...(item.blockingQuestions === undefined
      ? {}
      : {
          blockingQuestions: boundedPlanArray(
            item.blockingQuestions,
            `${label}.blockingQuestions`,
            0,
            16,
            (entry, entryLabel) => {
              const question = draftExact(entry, ["question", "recommendedDefault"], entryLabel, policy);
              return Object.freeze({
                question: parseText(question.question, `${entryLabel}.question`, 1_000),
                recommendedDefault: parseText(question.recommendedDefault, `${entryLabel}.recommendedDefault`, 1_000),
              });
            }
          ),
        }),
    ...(item.criterionChecks === undefined
      ? {}
      : {
          criterionChecks: boundedPlanArray(
            item.criterionChecks,
            `${label}.criterionChecks`,
            0,
            32,
            (entry, entryLabel) => {
              const criterion = draftExact(entry, ["criterion", "check"], entryLabel, policy);
              return Object.freeze({
                criterion: parseText(criterion.criterion, `${entryLabel}.criterion`, 1_000),
                check: planCheck(criterion.check, `${entryLabel}.check`, parseText),
              });
            }
          ),
        }),
  });
}

export function parseWorkflowPlan(value: unknown, policy: DraftParserPolicy): WorkflowPlanDraft {
  const messages = policy.messages;
  const required = ["objective", "assumptions", "acceptanceCriteria", "nodes"];
  const item = exact(value, [...required, ...PLAN_RECORD_FIELD_NAMES, "children"], messages.workflowPlanLabel, {
    messages: policy.exactMessages,
    required,
  });
  if (!Array.isArray(item.nodes) || item.nodes.length < 1 || item.nodes.length > 64) {
    throw new ContractValidationError(messages.workflowNodesInvalid);
  }
  const nodes = item.nodes.map((entry, index) => {
    const node = draftExact(
      entry,
      ["nodeId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds", "stageTemplate"],
      messages.workflowNodeLabel(index),
      policy
    );
    let stageTemplate: readonly NodeStage[];
    if (policy.stageListKind === "members") {
      if (!Array.isArray(node.stageTemplate) || node.stageTemplate.length < 1 || node.stageTemplate.length > 5) {
        throw new ContractValidationError(messages.workflowNodeStagesInvalid(index));
      }
      stageTemplate = node.stageTemplate.map((nodeStage, stageIndex) =>
        contractMember(nodeStage, WORKFLOW_STAGES, messages.workflowNodeStageLabel(index, stageIndex))
      );
      if (
        new Set(stageTemplate).size !== stageTemplate.length ||
        (stageTemplate.at(-1) !== "verification" && stageTemplate.at(-1) !== "testing")
      ) {
        throw new ContractValidationError(messages.workflowNodeStageOrderInvalid(index));
      }
    } else {
      const stages = draftStringList(node.stageTemplate, `workflowPlan.nodes[${index}].stageTemplate`, policy, 64, 1);
      if (
        stages.length > 5 ||
        new Set(stages).size !== stages.length ||
        (stages.at(-1) !== "verification" && stages.at(-1) !== "testing") ||
        stages.some((nodeStage) => !(WORKFLOW_STAGES as readonly string[]).includes(nodeStage))
      ) {
        throw new ContractValidationError(messages.workflowNodeStageOrderInvalid(index));
      }
      stageTemplate = stages as readonly NodeStage[];
    }
    return Object.freeze({
      nodeId: identifier(node.nodeId, `workflowPlan.nodes[${index}].nodeId`),
      title: draftText(node.title, `workflowPlan.nodes[${index}].title`, 512, policy),
      objective: draftText(node.objective, `workflowPlan.nodes[${index}].objective`, 4_000, policy),
      acceptanceCriteria: draftStringList(
        node.acceptanceCriteria,
        `workflowPlan.nodes[${index}].acceptanceCriteria`,
        policy,
        64,
        1
      ),
      dependencyNodeIds: draftStringList(
        node.dependencyNodeIds,
        `workflowPlan.nodes[${index}].dependencyNodeIds`,
        policy,
        64
      ),
      stageTemplate: Object.freeze(stageTemplate),
    });
  });
  const parsed = Object.freeze({
    objective: draftText(item.objective, "workflowPlan.objective", 8_000, policy),
    assumptions: draftStringList(item.assumptions, "workflowPlan.assumptions", policy, 64),
    acceptanceCriteria: draftStringList(item.acceptanceCriteria, "workflowPlan.acceptanceCriteria", policy, 64, 1),
    ...parseDraftPlanRecord(item, messages.workflowPlanLabel, policy),
    nodes: Object.freeze(nodes),
    ...(item.children === undefined
      ? {}
      : {
          children: boundedPlanArray(item.children, "workflowPlan.children", 0, 64, (entry, entryLabel) =>
            parseDeclaredChild(entry, entryLabel, policy)
          ),
        }),
  });
  validateWorkflowPlanChildren(parsed);
  return parsed;
}

export function parseWorkflowPlanDraft(value: unknown): WorkflowPlanDraft {
  return parseWorkflowPlan(value, BOARD_DRAFT_POLICY);
}

export function parseWorkerAgentRunOutcome(value: unknown): ValidatedAgentRunOutcome {
  boundedJsonValue(value, MAX_OUTCOME_BYTES, "Agent outcome");
  const raw = record(value, "Agent outcome");
  const item = exact(
    value,
    [
      "status",
      "outputs",
      "expectedAgentMinutes",
      "phases",
      "detail",
      ...("gapReport" in raw ? ["gapReport"] : []),
      ...("handoff" in raw ? ["handoff"] : []),
      ...("workflowPlan" in raw ? ["workflowPlan"] : []),
      ...("reviewFindings" in raw ? ["reviewFindings"] : []),
      ...("designRecord" in raw ? ["designRecord"] : []),
    ],
    "Agent outcome"
  );
  if (
    item.status !== "completed" &&
    item.status !== "failed" &&
    item.status !== "interrupted" &&
    item.status !== "waiting_for_human"
  ) {
    throw new ContractValidationError("Agent outcome status is invalid");
  }
  if (!Array.isArray(item.outputs) || item.outputs.length > 64)
    throw new ContractValidationError("Agent outcome outputs are invalid");
  if (!Array.isArray(item.phases) || item.phases.length > 32)
    throw new ContractValidationError("Agent outcome phases are invalid");
  const outputs = item.outputs.map(parseWorkerAgentRunOutput);
  const phases = item.phases.map(parseWorkerPhaseUpdate);
  const ids = phases.flatMap((phase) => (phase.phaseId === null ? [] : [phase.phaseId]));
  if (new Set(ids).size !== ids.length)
    throw new ContractValidationError("Agent outcome phases contain duplicate phase IDs");
  const results = outputs.filter((output) => output.type === "result").length;
  const questions = outputs.filter((output) => output.type === "human_question").length;
  if (item.status === "completed" ? results !== 1 || questions !== 0 : results !== 0) {
    throw new ContractValidationError("Agent outcome result does not match its terminal status");
  }
  if (item.status === "waiting_for_human" ? questions !== 1 : questions !== 0) {
    throw new ContractValidationError("Agent outcome question does not match its terminal status");
  }
  if (item.status === "waiting_for_human" && outputs.at(-1)?.type !== "human_question") {
    throw new ContractValidationError("A human question must be the final output because it ends the run");
  }
  return Object.freeze({
    status: item.status,
    outputs: Object.freeze(outputs),
    expectedAgentMinutes: expectedMinutes(item.expectedAgentMinutes, "outcome.expectedAgentMinutes", {
      nullable: true,
      maximum: 10_080,
      message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
    }),
    phases: Object.freeze(phases),
    detail: workerProse(item.detail, "outcome.detail", 2_000),
    ...(item.gapReport === undefined
      ? {}
      : {
          gapReport: workerProse(item.gapReport, "outcome.gapReport", AGENT_GAP_REPORT_MAX_CHARACTERS),
        }),
    handoff:
      item.handoff === undefined || item.handoff === null ? null : parseHandoffDraft(item.handoff, WORKER_DRAFT_POLICY),
    workflowPlan:
      item.workflowPlan === undefined || item.workflowPlan === null
        ? null
        : parseWorkflowPlan(item.workflowPlan, WORKER_DRAFT_POLICY),
    ...(item.reviewFindings === undefined
      ? {}
      : {
          reviewFindings: parseReviewFindingDraftList(item.reviewFindings, "outcome.reviewFindings"),
        }),
    ...(item.designRecord === undefined || item.designRecord === null
      ? {}
      : {
          designRecord: parseDesignRecordDraft(item.designRecord),
        }),
  });
}
