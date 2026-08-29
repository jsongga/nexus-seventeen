import {
  MAX_AREA_MEMORY_RESULT_CHARACTERS,
  MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS,
  type ClaimRunResult,
} from "#shared/task-board-contract";
import {
  identifier,
  integer,
  parseAgentTaskPhaseResponse,
  parseWorkerAgentContext,
  timestamp,
} from "#shared/task-board-contract/validate";

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const clean = value.trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, Math.max(1, maximum - 16)).trimEnd()}\n[truncated]`;
}

function positive(value: number, label: string): number {
  return integer(value, label, 1, `${label} is invalid`);
}

function estimateMinutes(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 15 || value > 10_080 || value % 15 !== 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function taskPhase(value: unknown, projectId: string, taskId: string, label: string) {
  const item = parseAgentTaskPhaseResponse(value, projectId, taskId, label);
  return Object.freeze({
    phaseId: item.phaseId,
    title: bounded(item.title, `${label}.title`, 240),
    stage: item.stage,
    status: item.status,
    parallelGroup: item.parallelGroup,
    orderKey: item.orderKey,
    version: item.version,
  });
}

function canonicalTimestamp(value: string, label: string): string {
  return timestamp(value, label, `${label} is invalid`, true);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function questionProjection(value: ClaimRunResult["context"]["triggerQuestion"], requireAnswer: boolean) {
  if (value === null) return null;
  if (requireAnswer && (value.status !== "answered" || value.answer === null)) {
    throw new Error("Human-answer wake omitted its answered trigger question");
  }
  if (value.answer === null) return null;
  return {
    questionId: identifier(value.questionId, "triggerQuestion.questionId"),
    question: bounded(value.question, "triggerQuestion.question", 2_000),
    answer: bounded(value.answer, "triggerQuestion.answer", 4_000),
  };
}

/** Maps a board claim into the only context shape allowed across the model boundary. */
export function mapClaimContext(
  result: ClaimRunResult,
  requestedCursor: number | null,
): ReturnType<typeof parseWorkerAgentContext> | null {
  const projected = projectClaimContext(result, requestedCursor);
  return projected === null ? null : parseWorkerAgentContext(projected);
}

export function projectClaimContext(
  result: ClaimRunResult,
  requestedCursor: number | null,
): Readonly<Record<string, unknown>> | null {
  const { run, wakeup, task, context } = result;
  if (wakeup.taskId === null) {
    if (task !== null) throw new Error("Taskless wake included a task");
    return null;
  }
  if (
    task === null || task.taskId !== wakeup.taskId || task.projectId !== run.projectId ||
    task.assignedAgentId !== run.agentId || context.agent.agentId !== run.agentId ||
    context.agent.projectId !== run.projectId || context.projectMemory.projectId !== run.projectId ||
    context.acceptanceCriteria !== task.acceptanceCriteria || !sameStrings(context.workspaceRefs, task.workspaceRefs)
  ) {
    throw new Error("Claim task and bounded context binding is invalid");
  }
  const messages = context.messages.slice(-12).map((message) => ({
    messageId: identifier(message.messageId, "message.messageId"),
    cursor: integer(message.sequence, "message.sequence", 0, "message.sequence is invalid"),
    author: message.actorType,
    body: bounded(message.body, "message.body", 2_000),
    createdAt: canonicalTimestamp(message.createdAt, "message.createdAt"),
  }));
  const areaMemory = context.areaMemory.map((memory, index) => ({
    taskId: identifier(memory.taskId, `areaMemory[${index}].taskId`),
    title: bounded(memory.title, `areaMemory[${index}].title`, 512),
    result: bounded(memory.result, `areaMemory[${index}].result`, MAX_AREA_MEMORY_RESULT_CHARACTERS),
    endedAt: canonicalTimestamp(memory.endedAt, `areaMemory[${index}].endedAt`),
  }));
  if (areaMemory.some((memory) => memory.taskId === task.taskId)) {
    throw new Error("Claim area memory includes the current task");
  }
  const parentEvidence = context.parentTask === null
    ? null
    : {
        taskId: identifier(context.parentTask.taskId, "parent.taskId"),
        title: bounded(context.parentTask.title, "parent.title", 512),
        objective: bounded(context.parentTask.objective, "parent.objective", 8_000),
        acceptanceCriteria: bounded(context.parentTask.acceptanceCriteria, "parent.acceptanceCriteria", 4_000),
        status: bounded(context.parentTask.status, "parent.status", 64),
        assignedAgentId: context.parentTask.assignedAgentId === null
          ? null
          : identifier(context.parentTask.assignedAgentId, "parent.assignedAgentId"),
        workspaceRefs: context.parentTask.workspaceRefs.map((reference, index) =>
          bounded(reference, `parent.workspaceRefs[${index}]`, 512)),
        startedAt: context.parentTask.startedAt === null
          ? null
          : canonicalTimestamp(context.parentTask.startedAt, "parent.startedAt"),
        endedAt: context.parentTask.endedAt === null
          ? null
          : canonicalTimestamp(context.parentTask.endedAt, "parent.endedAt"),
        result: context.parentTask.result === null ? null : bounded(context.parentTask.result, "parent.result", 4_000),
        messages: context.parentMessages.slice(-12).map((message, index) => {
          if (
            message.taskId !== context.parentTask?.taskId || message.projectId !== run.projectId ||
            message.actorType !== "human" && message.actorType !== "agent"
          ) {
            throw new Error(`Parent message ${index} is not bound to the parent task`);
          }
          return {
            messageId: identifier(message.messageId, `parent.messages[${index}].messageId`),
            author: message.actorType,
            kind: message.kind,
            body: bounded(message.body, `parent.messages[${index}].body`, 2_000),
            createdAt: canonicalTimestamp(message.createdAt, `parent.messages[${index}].createdAt`),
          };
        }),
      };
  if (context.parentTask === null && context.parentMessages.length !== 0) {
    throw new Error("Claim context included parent messages without a parent task");
  }
  if (context.parentTask !== null && context.parentTask.taskId !== task.parentTaskId) {
    throw new Error("Claim context parent does not match the task parent");
  }
  return Object.freeze({
    apiVersion: 1,
    projectId: run.projectId,
    agentId: run.agentId,
    taskId: task.taskId,
    intake: context.intake,
    ...(context.onboarding === true ? { onboarding: true as const } : {}),
    design: context.design ?? false,
    mission: {
      role: context.agent.role,
      area: bounded(context.agent.area, "agent.area", 256),
      mission: bounded(context.agent.mission, "agent.mission", 2_000),
    },
    projectMemory: bounded(`${context.projectMemory.name}\n\n${context.projectMemory.description}`, "projectMemory", 4_000),
    task: {
      kind: task.kind,
      requiredRole: task.requiredRole,
      title: bounded(task.title, "task.title", 512),
      objective: bounded(
        task.objective,
        "task.objective",
        context.design === true ? MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS : 8_000,
      ),
      acceptanceCriteria: bounded(task.acceptanceCriteria, "task.acceptanceCriteria", 4_000),
      version: positive(task.version, "task.version"),
      expectedAgentMinutes: estimateMinutes(task.expectedAgentMinutes, "task.expectedAgentMinutes"),
      phases: (() => {
        const parsed = task.phases.map((phase, index) => taskPhase(
          phase,
          run.projectId,
          task.taskId,
          `task.phases[${index}]`,
        ));
        if (parsed.length <= 64) return parsed;
        const selected = new Set<number>();
        for (let index = parsed.length - 1; index >= 0 && selected.size < 64; index -= 1) {
          const phase = parsed[index];
          if (phase !== undefined && phase.status !== "completed" && phase.status !== "failed") selected.add(index);
        }
        for (let index = parsed.length - 1; index >= 0 && selected.size < 64; index -= 1) selected.add(index);
        return parsed.filter((_phase, index) => selected.has(index));
      })(),
    },
    areaMemory,
    parentEvidence,
    messagesSinceCursor: requestedCursor,
    nextMessageCursor: integer(context.messageCursor, "context.messageCursor", 0, "context.messageCursor is invalid"),
    messages,
    triggerQuestion: questionProjection(context.triggerQuestion, wakeup.reason === "human_answer"),
    openQuestions: context.openQuestions.slice(0, 4).map((question) => ({
      questionId: identifier(question.questionId, "openQuestion.questionId"),
      question: bounded(question.question, "openQuestion.question", 2_000),
      answer: question.answer === null ? null : bounded(question.answer, "openQuestion.answer", 4_000),
      status: question.status,
    })),
    workspaceRefs: context.workspaceRefs,
    phase: context.phase ?? null,
    ...(context.crossRepoContext === undefined ? {} : { crossRepoContext: context.crossRepoContext }),
    workflow: context.workflow === undefined || context.workflow === null
      ? null
      : {
          ...context.workflow,
          workspaceKey: context.workflow.workspaceKey ?? null,
          pipeline: context.workflow.pipeline === undefined || context.workflow.pipeline === null
            ? null
            : {
                ...context.workflow.pipeline,
                designRecord: context.workflow.pipeline.designRecord ?? null,
              },
          review: context.workflow.review === undefined || context.workflow.review === null
            ? null
            : {
                ...context.workflow.review,
                mechanicalPortions: context.workflow.review.mechanicalPortions ?? [],
              },
        },
  });
}

/** Removes the allocation-time task identifier from readiness input identity. */
export function claimContextInputForDigest(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...value, taskId: "migrate-task" });
}
