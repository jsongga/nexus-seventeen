/** Builds bounded agent prompts and validates provider output at the task-worker boundary. */

/* —— Imports —— */

import {
  AGENT_GAP_REPORT_MAX_CHARACTERS,
  AGENT_ROLES,
  DESIGN_FAILURE_POINTS,
  DESIGN_RECORD_DETAIL_MAX_LENGTH,
  DESIGN_RECORD_LABEL_MAX_LENGTH,
  DESIGN_RECORD_MAX_FAILURE_POINTS,
  DESIGN_RECORD_MAX_FAULT_INJECTION_CASES,
  DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS,
  DESIGN_RECORD_MAX_STATES,
  DESIGN_RECORD_MAX_TRANSITIONS,
  IDENTIFIER_PATTERN,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_DRAFT_MAX_ITEMS,
  REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH,
  REVIEW_FINDING_SEVERITIES,
  STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
  STAGE_HANDOFF_OUTCOMES,
  STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  WORK_ITEM_PHASES,
  WORKFLOW_STAGES,
  type AgentRole,
} from "#shared/task-board-contract";
import { AgentProcessError, type RuntimeEvent } from "../runtime/adapter.js";
import { CREDENTIAL_REJECTION_PATTERNS } from "../../shared/redact.js";
import type { PromptRegistry } from "./prompt-registry.js";
import { parseAgentRunOutcome } from "./schema.js";
import type { AgentLaunchRequest, AgentRunOutcome } from "./types.js";

/* —— Structured result schema —— */

const MAX_QUEUED_ACTIVITY = 64;

const DESIGN_RECORD_SCHEMA = Object.freeze({
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        states: {
          type: "array",
          minItems: 1,
          maxItems: DESIGN_RECORD_MAX_STATES,
          items: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_LABEL_MAX_LENGTH },
        },
        transitions: {
          type: "array",
          minItems: 1,
          maxItems: DESIGN_RECORD_MAX_TRANSITIONS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              from: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_LABEL_MAX_LENGTH },
              to: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_LABEL_MAX_LENGTH },
              durablePrecondition: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
              recovery: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
            },
            required: ["from", "to"],
          },
        },
        failurePoints: {
          type: "array",
          minItems: DESIGN_FAILURE_POINTS.length,
          maxItems: DESIGN_RECORD_MAX_FAILURE_POINTS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              point: { type: "string", enum: DESIGN_FAILURE_POINTS },
              resultingState: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
              recovery: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
            },
            required: ["point", "resultingState", "recovery"],
          },
        },
        idempotencyKeys: {
          type: "array",
          maxItems: DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_LABEL_MAX_LENGTH },
              generatedAt: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
              persistedAt: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
              reuse: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
            },
            required: ["name", "generatedAt", "persistedAt", "reuse"],
          },
        },
        faultInjectionCases: {
          type: "array",
          maxItems: DESIGN_RECORD_MAX_FAULT_INJECTION_CASES,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_LABEL_MAX_LENGTH },
              scenario: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
              expectation: { type: "string", minLength: 1, maxLength: DESIGN_RECORD_DETAIL_MAX_LENGTH },
            },
            required: ["name", "scenario", "expectation"],
          },
        },
      },
      required: ["states", "transitions", "failurePoints", "idempotencyKeys", "faultInjectionCases"],
    },
  ],
} as const);

export const RESULT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "failed", "waiting_for_human"] },
    progress: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2_000 } },
    result: { type: ["string", "null"], maxLength: 4_000 },
    gapReport: { type: "string", minLength: 1, maxLength: AGENT_GAP_REPORT_MAX_CHARACTERS },
    proposedChildTasks: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 512 },
          objective: { type: "string", minLength: 1, maxLength: 4_000 },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
        required: ["title", "objective", "acceptanceCriteria"],
      },
    },
    expectedAgentMinutes: { type: ["integer", "null"], minimum: 15, maximum: 10_080, multipleOf: 15 },
    phases: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          phaseId: { type: ["string", "null"], pattern: IDENTIFIER_PATTERN },
          title: { type: "string", minLength: 1, maxLength: 240 },
          stage: { type: "string", enum: TASK_PHASE_STAGES },
          status: { type: "string", enum: TASK_PHASE_STATUSES },
          parallelGroup: { type: ["string", "null"], pattern: IDENTIFIER_PATTERN },
          orderKey: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        },
        required: ["phaseId", "title", "stage", "status", "parallelGroup", "orderKey"],
      },
    },
    humanQuestion: { type: ["string", "null"], maxLength: 2_000 },
    handoff: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: STAGE_HANDOFF_OUTCOMES },
            summary: { type: "string", minLength: 1, maxLength: STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS },
            evidence: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2_000 } },
            artifactIds: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 } },
            acceptanceCriteria: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  criterion: { type: "string", minLength: 1, maxLength: 1_000 },
                  passed: { type: "boolean" },
                  evidence: { type: "string", minLength: 1, maxLength: 2_000 },
                },
                required: ["criterion", "passed", "evidence"],
              },
            },
            blockers: {
              type: "array",
              maxItems: STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
              items: { type: "string", minLength: 1, maxLength: 2_000 },
            },
            recommendedReturnStage: { type: ["string", "null"], enum: [...WORKFLOW_STAGES, null] },
          },
          required: [
            "outcome",
            "summary",
            "evidence",
            "artifactIds",
            "acceptanceCriteria",
            "blockers",
            "recommendedReturnStage",
          ],
        },
      ],
    },
    reviewFindings: {
      type: "array",
      maxItems: REVIEW_FINDING_DRAFT_MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 512,
            pattern: "^(?!/)[^\\u0000-\\u001f\\u007f]+$",
          },
          line: { type: ["integer", "null"], minimum: 1 },
          category: { type: "string", enum: REVIEW_FINDING_CATEGORIES },
          severity: { type: "string", enum: REVIEW_FINDING_SEVERITIES },
          expected: { type: "string", minLength: 1, maxLength: REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH },
          actual: { type: "string", minLength: 1, maxLength: REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH },
        },
        required: ["category", "severity", "expected", "actual"],
      },
    },
    designRecord: DESIGN_RECORD_SCHEMA,
    workflowPlan: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            objective: { type: "string", minLength: 1, maxLength: 8_000 },
            assumptions: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 2_000 } },
            acceptanceCriteria: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              items: { type: "string", minLength: 1, maxLength: 2_000 },
            },
            changeShape: { type: "string", enum: ["mechanical_sweep", "feature", "blast_radius"] },
            tier: { type: "string", enum: ["standard", "hazardous"] },
            declaredScope: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              items: { type: "string", minLength: 1, maxLength: 256, pattern: "^(?!/)(?!.*\\.\\.).+$" },
            },
            nonGoals: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 1_000 } },
            mechanicalPortions: {
              type: "array",
              maxItems: 32,
              items: { type: "string", minLength: 1, maxLength: 1_000 },
            },
            blockingQuestions: {
              type: "array",
              maxItems: 16,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  question: { type: "string", minLength: 1, maxLength: 1_000 },
                  recommendedDefault: { type: "string", minLength: 1, maxLength: 1_000 },
                },
                required: ["question", "recommendedDefault"],
              },
            },
            criterionChecks: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  criterion: { type: "string", minLength: 1, maxLength: 1_000 },
                  check: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" },
                },
                required: ["criterion", "check"],
              },
            },
            children: {
              type: "array",
              maxItems: 64,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  key: { type: "string", pattern: IDENTIFIER_PATTERN },
                  objective: { type: "string", minLength: 1, maxLength: 4_000 },
                  projectId: { type: "string", pattern: IDENTIFIER_PATTERN },
                  declaredScope: {
                    type: "array",
                    minItems: 1,
                    maxItems: 64,
                    items: { type: "string", minLength: 1, maxLength: 256, pattern: "^(?!/)(?!.*\\.\\.).+$" },
                  },
                  acceptanceCriteria: {
                    type: "array",
                    minItems: 1,
                    maxItems: 64,
                    items: { type: "string", minLength: 1, maxLength: 2_000 },
                  },
                  phase: { type: "string", enum: WORK_ITEM_PHASES },
                  // Optional, like phase: absent means the target project's
                  // primary repository. Without it here, additionalProperties:
                  // false rejects the whole provider result before the contract
                  // validator ever sees the field.
                  repositoryId: { type: "string", pattern: IDENTIFIER_PATTERN },
                  dependsOn: {
                    type: "array",
                    maxItems: 64,
                    uniqueItems: true,
                    items: { type: "string", pattern: IDENTIFIER_PATTERN },
                  },
                  splitBy: { type: "string", enum: ["consumer", "phase"] },
                },
                required: ["key", "objective", "projectId", "declaredScope", "acceptanceCriteria"],
              },
            },
            nodes: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  nodeId: { type: "string", pattern: IDENTIFIER_PATTERN },
                  title: { type: "string", minLength: 1, maxLength: 512 },
                  objective: { type: "string", minLength: 1, maxLength: 4_000 },
                  acceptanceCriteria: {
                    type: "array",
                    minItems: 1,
                    maxItems: 64,
                    items: { type: "string", minLength: 1, maxLength: 2_000 },
                  },
                  dependencyNodeIds: {
                    type: "array",
                    maxItems: 64,
                    items: { type: "string", pattern: IDENTIFIER_PATTERN },
                  },
                  stageTemplate: {
                    type: "array",
                    minItems: 1,
                    maxItems: 5,
                    uniqueItems: true,
                    items: { type: "string", enum: WORKFLOW_STAGES },
                  },
                },
                required: ["nodeId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds", "stageTemplate"],
              },
            },
          },
          required: ["objective", "assumptions", "acceptanceCriteria", "nodes"],
        },
      ],
    },
    detail: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  required: [
    "status",
    "progress",
    "result",
    "proposedChildTasks",
    "expectedAgentMinutes",
    "phases",
    "humanQuestion",
    "handoff",
    "workflowPlan",
    "reviewFindings",
    "designRecord",
    "detail",
  ],
} as const);

/* —— Launch safeguards and activity —— */

export interface ProviderArgumentOptions {
  readonly model: string;
  readonly workingDirectory: string;
  /** Absolute path of agent-result.schema.json as seen by the CLI process (codex only). */
  readonly schemaPath: string;
  /** Claude only: pass --bare when explicit API-key auth is available. */
  readonly bareApiKey: boolean;
  /** Codex only: allow subprocess network access through the container's proxy environment. */
  readonly proxyEgress?: boolean;
}

export class ActivityChannel implements AsyncIterable<RuntimeEvent> {
  readonly #queued: RuntimeEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  #closed = false;
  #iteratorCreated = false;

  publish(value: RuntimeEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return;
    }
    if (this.#queued.length === MAX_QUEUED_ACTIVITY) this.#queued.shift();
    this.#queued.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    if (this.#iteratorCreated) throw new Error("Agent activity stream can only be consumed once");
    this.#iteratorCreated = true;
    return { next: () => this.#next() };
  }

  #next(): Promise<IteratorResult<RuntimeEvent>> {
    const value = this.#queued.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label} is invalid`);
  return result;
}

export function configText(value: string, label: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

// Rejection, not redaction: this refuses the whole prompt, context or provider
// output rather than rewriting a span, so it uses the rejection set (same
// credential shapes, prose-safe length floors) from server/shared/redact.ts.
export function assertCredentialSafe(value: string, label: string): void {
  if (Object.values(CREDENTIAL_REJECTION_PATTERNS).some((pattern) => pattern.test(value)))
    throw new AgentProcessError(`${label} failed the credential-safety filter`);
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function agentRole(request: AgentLaunchRequest): AgentRole {
  const value = request.context.mission.role;
  if (!(AGENT_ROLES as readonly string[]).includes(value)) {
    throw new AgentProcessError("Agent profile has an unsupported fixed role");
  }
  return value as AgentRole;
}

/* —— Prompt assembly —— */

function promptBlock(prompts: PromptRegistry, name: string, vars: Readonly<Record<string, string>> = {}): string {
  const rendered = prompts.render(name, vars);
  return rendered.endsWith("\r\n") ? rendered.slice(0, -2) : rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
}

export function agentPrompt(request: AgentLaunchRequest, prompts: PromptRegistry): string {
  const fixedRole = agentRole(request);
  const planningRun = request.context.intake === true;
  const onboarding = request.context.onboarding === true;
  const boardProjects =
    planningRun && request.context.boardProjects !== undefined
      ? promptBlock(prompts, "board-projects", {
          projects: request.context.boardProjects
            .map(
              (project) =>
                `- ${project.projectId} | ${project.name} | ${project.repoName}${
                  project.projectId === request.context.projectId ? " (parent project)" : ""
                }`
            )
            .join("\n"),
        })
      : null;
  const previousPlanRejection =
    request.previousPlanRejectionDetail === undefined
      ? null
      : promptBlock(prompts, "previous-plan-rejection", {
          detail: configText(request.previousPlanRejectionDetail, "previousPlanRejectionDetail", 2_000),
        });
  const pipeline = request.context.workflow?.pipeline;
  const designRecord = pipeline?.designRecord ?? null;
  const renderedDesignRecord = designRecord === null ? null : JSON.stringify(designRecord);
  const hazardousImplementationDesign =
    fixedRole === "engineer" && request.context.workflow?.stage === "implementation" && renderedDesignRecord !== null
      ? promptBlock(prompts, "hazardous-implementation", { designRecord: renderedDesignRecord })
      : null;
  const hazardousReviewDesign =
    fixedRole === "verifier" && request.context.workflow?.stage === "verification" && renderedDesignRecord !== null
      ? promptBlock(prompts, "hazardous-review", { designRecord: renderedDesignRecord })
      : null;
  const crossRepoInterface =
    fixedRole === "engineer" && request.context.crossRepoContext !== undefined
      ? promptBlock(prompts, "engineer-cross-repo-interface", {
          interfacePath: request.context.crossRepoContext.interfacePath,
          sha: request.context.crossRepoContext.sha,
          providerProjectId: request.context.crossRepoContext.providerProjectId,
          providerRepoName: request.context.crossRepoContext.providerRepoName,
          markdown: request.context.crossRepoContext.markdown,
        })
      : null;
  const interfacePhase =
    request.context.phase === "expand" || request.context.phase === "contract" ? request.context.phase : null;
  const brightLineBlock = promptBlock(prompts, "bright-line", {
    publishedInterfaceRule:
      interfacePhase === null
        ? "change a published interface"
        : "change a published interface other than docs/interface.md",
  });
  const interfacePhaseAuthorization =
    fixedRole === "engineer" &&
    request.context.workflow?.stage === "implementation" &&
    pipeline != null &&
    interfacePhase !== null
      ? promptBlock(prompts, "engineer-interface-phase-authorization", {
          phase: interfacePhase === "expand" ? "Expand" : "Contract",
        })
      : null;
  const pipelineImplementation =
    fixedRole === "engineer" && request.context.workflow?.stage === "implementation" && pipeline != null
      ? (() => {
          const onboardingBlock = onboarding
            ? promptBlock(prompts, "onboarding-engineer", {
                branch: pipeline.branch,
                declaredScope: pipeline.declaredScope.join(", "),
                nonGoals: pipeline.nonGoals.join(", ") || "none",
                brightLine: brightLineBlock,
              })
            : null;
          const fix = request.context.workflow?.fix;
          if (fix !== null && fix !== undefined) {
            const fixBlock = promptBlock(prompts, "engineer-fix", {
              round: String(fix.round),
              branch: pipeline.branch,
              findings: fix.findings.map((finding) => `- ${JSON.stringify(finding)}`).join("\n"),
              brightLine: brightLineBlock,
            });
            return onboardingBlock === null ? [fixBlock] : [fixBlock, onboardingBlock];
          }
          return [
            onboardingBlock ??
              promptBlock(prompts, "pipeline-implementation", {
                branch: pipeline.branch,
                declaredScope: pipeline.declaredScope.join(", "),
                nonGoals: pipeline.nonGoals.join(", "),
                brightLine: brightLineBlock,
              }),
          ];
        })()
      : [];
  const pipelineReview =
    fixedRole === "verifier" && request.context.workflow?.stage === "verification" && pipeline != null
      ? (() => {
          const review = request.context.workflow?.review;
          const scopeInstruction =
            review === null || review === undefined
              ? promptBlock(prompts, "reviewer-scope-legacy")
              : promptBlock(prompts, "reviewer-scope", { scopeOk: String(review.scopeOk) });
          const block = promptBlock(prompts, "reviewer", {
            branch: pipeline.branch,
            changeShape: pipeline.changeShape,
            scopeInstruction,
          });
          if (review === null || review === undefined) {
            return [block, promptBlock(prompts, "reviewer-legacy")] as const;
          }
          const commits =
            review.commits.length === 0
              ? "- none"
              : review.commits.map((commit) => `- ${commit.sha} ${commit.subject}`).join("\n");
          const files =
            review.filesTouched.length === 0
              ? "- none"
              : review.filesTouched.map((file) => `- ${file.path} (${file.status})`).join("\n");
          const assumptions =
            review.midRunAssumptions.length === 0
              ? "- none"
              : review.midRunAssumptions.map((assumption) => `- ${assumption}`).join("\n");
          const criteria =
            review.acceptanceCriteria.length === 0
              ? "- none"
              : review.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
          const criterionChecks =
            review.criterionChecks.length === 0
              ? "- none"
              : review.criterionChecks.map((criterion) => `- ${criterion.criterion}: ${criterion.check}`).join("\n");
          const mechanicalPortions =
            review.mechanicalPortions.length === 0
              ? "- none"
              : review.mechanicalPortions.map((portion) => `- ${portion}`).join("\n");
          const priorFindings =
            review.priorFindings.length === 0
              ? "- none"
              : review.priorFindings.map((finding) => `- ${JSON.stringify(finding)}`).join("\n");
          return [
            block,
            promptBlock(prompts, "reviewer-evidence", {
              declaredScope: pipeline.declaredScope.join(", "),
              nonGoals: pipeline.nonGoals.join(", ") || "none",
              assumptions: pipeline.assumptions.join(" | ") || "none",
              commits,
              diffstat: review.diffstat,
              files,
              midRunAssumptions: assumptions,
              acceptanceCriteria: criteria,
              criterionChecks,
              mechanicalPortions,
              priorFindingsLabel: promptBlock(
                prompts,
                review.priorFindingsTruncated ? "reviewer-prior-findings-truncated" : "reviewer-prior-findings"
              ),
              priorFindings,
            }),
          ] as const;
        })()
      : null;
  const workflow = request.context.design
    ? [promptBlock(prompts, "designer")]
    : fixedRole === "engineer"
      ? [promptBlock(prompts, "engineer")]
      : fixedRole === "verifier"
        ? [promptBlock(prompts, "verifier")]
        : planningRun
          ? [promptBlock(prompts, onboarding ? "onboarding-intake" : "intake")]
          : [promptBlock(prompts, "oversight")];
  const trailer = promptBlock(prompts, "trailer", {
    planningInstruction: promptBlock(prompts, planningRun ? "intake-return" : "workflow-plan-return"),
    wakeReason: request.wakeReason,
    context: JSON.stringify(
      (({ phase: _phase, crossRepoContext: _crossRepoContext, ...context }) => context)(request.context)
    ),
  });
  return [
    promptBlock(prompts, "header", {
      role: fixedRole,
      area: request.context.mission.area,
      mission: request.context.mission.mission,
    }),
    ...workflow,
    ...(boardProjects === null ? [] : [boardProjects]),
    ...pipelineImplementation,
    ...(interfacePhaseAuthorization === null ? [] : [interfacePhaseAuthorization]),
    ...(crossRepoInterface === null ? [] : [crossRepoInterface]),
    ...(hazardousImplementationDesign === null ? [] : [hazardousImplementationDesign]),
    ...(pipelineReview === null ? [] : pipelineReview),
    ...(hazardousReviewDesign === null ? [] : [hazardousReviewDesign]),
    ...(previousPlanRejection === null ? [] : [previousPlanRejection]),
    trailer,
  ].join("\n");
}

/* —— Provider output —— */

function outputObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AgentProcessError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function structuredOutcome(value: unknown): AgentRunOutcome {
  const item = outputObject(value, "Provider result");
  const expected = [
    "status",
    "progress",
    "result",
    "proposedChildTasks",
    "expectedAgentMinutes",
    "phases",
    "humanQuestion",
    ...("handoff" in item ? ["handoff"] : []),
    ...("workflowPlan" in item ? ["workflowPlan"] : []),
    ...("reviewFindings" in item ? ["reviewFindings"] : []),
    ...("designRecord" in item ? ["designRecord"] : []),
    ...("gapReport" in item ? ["gapReport"] : []),
    "detail",
  ].sort();
  const actual = Object.keys(item).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AgentProcessError("Provider result has unexpected or missing fields");
  }
  if (!Array.isArray(item.progress) || !Array.isArray(item.proposedChildTasks) || !Array.isArray(item.phases)) {
    throw new AgentProcessError("Provider result collections are invalid");
  }
  const outputs: unknown[] = item.progress.map((body) => ({ type: "progress", body }));
  for (const proposal of item.proposedChildTasks) {
    const task = outputObject(proposal, "Proposed child task");
    outputs.push({
      type: "proposed_child_task",
      title: task.title,
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
    });
  }
  // A provider may self-report a non-completed outcome with a result summary.
  // Those outcomes use detail; result outputs remain reserved for completed runs.
  if (item.result !== null && item.status === "completed") outputs.push({ type: "result", body: item.result });
  if (item.humanQuestion !== null) outputs.push({ type: "human_question", question: item.humanQuestion });
  const outcome = parseAgentRunOutcome({
    status: item.status,
    outputs,
    expectedAgentMinutes: item.expectedAgentMinutes,
    phases: item.phases,
    detail: item.detail,
    handoff: item.handoff ?? null,
    workflowPlan: item.workflowPlan ?? null,
    ...(item.reviewFindings === undefined ? {} : { reviewFindings: item.reviewFindings }),
    ...(item.designRecord === undefined || item.designRecord === null ? {} : { designRecord: item.designRecord }),
    ...(item.gapReport === undefined ? {} : { gapReport: item.gapReport }),
  });
  assertCredentialSafe(JSON.stringify(outcome), "Provider output");
  return outcome;
}
