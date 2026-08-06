import { randomUUID } from "node:crypto";
import type {
  AnswerHumanQuestionRequest,
  CreateHumanQuestionRequest,
  CreateHumanTaskMessageRequest,
  CreateTaskMessageRequest,
  HumanQuestion,
  TaskMessage,
  Wakeup,
} from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import {
  messageFromRow,
  questionFromRow,
  stringValue,
  wakeupFromRow,
} from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { Actor, TaskBoardRuntime } from "./runtime.js";

export class MessagesCollaborator {
  constructor(private readonly runtime: TaskBoardRuntime) {}

  appendAgentMessage(taskId: string, agentId: string, request: CreateTaskMessageRequest): TaskMessage {
    const task = this.runtime.requireTask(taskId);
    if (task.assignedAgentId !== agentId) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    return this.appendMessage(task, { type: "agent", id: agentId }, request.clientEventId, request.runId, request.kind, request.body);
  }

  appendHumanMessage(taskId: string, request: CreateHumanTaskMessageRequest): TaskMessage {
    const task = this.runtime.requireTask(taskId);
    return this.appendMessage(
      task,
      { type: "human", id: this.runtime.config.humanPrincipal },
      request.clientEventId,
      null,
      request.kind,
      request.body,
    );
  }

  askQuestion(taskId: string, agentId: string, request: CreateHumanQuestionRequest): HumanQuestion {
    const task = this.runtime.requireTask(taskId);
    if (task.assignedAgentId !== agentId) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    const hash = sha256({ action: "ask_question", taskId, agentId, request });
    const prior = this.runtime.store.db.prepare("SELECT * FROM questions WHERE agent_id = ? AND client_event_id = ?").get(agentId, request.clientEventId);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("CLIENT_EVENT_CONFLICT", "clientEventId was used for another question");
      return questionFromRow(prior);
    }
    this.runtime.requireRun(request.runId, agentId, taskId, true);
    if (task.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal task cannot wait for a human answer");
    const questionId = randomUUID();
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.transaction(() => {
      this.runtime.store.db.prepare(`
        INSERT INTO questions(
          question_id, project_id, task_id, agent_id, run_id, client_event_id, request_hash,
          question, status, answer, asked_at, answered_at, answered_by, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL, 1)
      `).run(questionId, task.projectId, taskId, agentId, request.runId, request.clientEventId, hash, request.question, now);
      const settled = this.runtime.store.db.prepare(`
        UPDATE runs SET status = 'waiting_for_human', ended_at = ?, result = ?
        WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).run(now, `Waiting for human answer: ${request.question}`, request.runId, agentId);
      if (Number(settled.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is no longer active");
      if (task.status !== "blocked") {
        const blocked = this.runtime.store.db.prepare(`
          UPDATE tasks
          SET status = 'blocked', version = version + 1, updated_at = ?
          WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
        `).run(now, taskId, agentId, task.version);
        if (Number(blocked.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its question was opening");
        this.runtime.insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "task_blocked_for_human", {
          runId: request.runId,
          questionId,
          previousStatus: task.status,
          status: "blocked",
          version: task.version + 1,
        }, now);
      }
      this.runtime.insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "human_question_opened", {
        questionId,
        runId: request.runId,
      }, now);
    });
    return questionFromRow(this.runtime.store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId)!);
  }

  answerQuestion(questionId: string, request: AnswerHumanQuestionRequest): { question: HumanQuestion; wakeup: Wakeup; duplicate: boolean } {
    const currentRow = this.runtime.store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId);
    if (!currentRow) throw new TaskBoardError(404, "QUESTION_NOT_FOUND", "Question was not found");
    const current = questionFromRow(currentRow);
    if (current.status === "answered") {
      if (current.answer !== request.answer || current.version !== request.version + 1) {
        throw conflict("QUESTION_ALREADY_ANSWERED", "Question already has another answer");
      }
      const wake = this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE reason = 'human_answer' AND source_key = ?").get(`question:${questionId}`);
      if (!wake) throw new Error("TASK_BOARD_DATABASE_CORRUPT:answered_question_wakeup");
      return { question: current, wakeup: wakeupFromRow(wake), duplicate: true };
    }
    if (current.version !== request.version) throw conflict("QUESTION_VERSION_CONFLICT", "Question version changed");
    const now = exactNow(this.runtime.config.now);
    let wakeupId = "";
    this.runtime.store.transaction(() => {
      const update = this.runtime.store.db.prepare(`
        UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, answered_by = ?, version = version + 1
        WHERE question_id = ? AND status = 'open' AND version = ?
      `).run(request.answer, now, this.runtime.config.humanPrincipal, questionId, request.version);
      if (Number(update.changes) !== 1) throw conflict("QUESTION_VERSION_CONFLICT", "Question version changed");
      wakeupId = this.runtime.insertWakeup(
        current.projectId,
        current.agentId,
        "human_answer",
        `question:${questionId}`,
        current.taskId,
        questionId,
        `Human answered: ${request.answer}`,
        now,
      );
      this.runtime.insertEvent(current.projectId, current.taskId, { type: "human", id: this.runtime.config.humanPrincipal }, "human_question_answered", {
        questionId,
        wakeupId,
      }, now);
    });
    this.runtime.wakeupEvents.emit(current.agentId);
    return {
      question: questionFromRow(this.runtime.store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId)!),
      wakeup: wakeupFromRow(this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!),
      duplicate: false,
    };
  }

  listMessages(taskId: string, after = 0): readonly TaskMessage[] {
    this.runtime.requireTask(taskId);
    return Object.freeze(this.runtime.store.db.prepare(`
      SELECT * FROM task_messages WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 200
    `).all(taskId, after).map(messageFromRow));
  }

  private appendMessage(
    task: ReturnType<TaskBoardRuntime["requireTask"]>,
    actor: Actor,
    clientEventId: string,
    runId: string | null,
    kind: TaskMessage["kind"],
    body: string,
  ): TaskMessage {
    const hash = sha256({ action: "append_task_message", taskId: task.taskId, actor, clientEventId, runId, kind, body });
    const prior = this.runtime.store.db.prepare(`
      SELECT * FROM task_messages WHERE actor_type = ? AND actor_id = ? AND client_event_id = ?
    `).get(actor.type, actor.id, clientEventId);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("CLIENT_EVENT_CONFLICT", "clientEventId was used for another message");
      return messageFromRow(prior);
    }
    if (actor.type === "agent") {
      if (runId === null) throw new Error("TASK_BOARD_AGENT_MESSAGE_RUN_MISSING");
      this.runtime.requireRun(runId, actor.id, task.taskId, true);
    }
    const messageId = randomUUID();
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.transaction(() => {
      this.runtime.store.db.prepare(`
        INSERT INTO task_messages(
          message_id, project_id, task_id, run_id, actor_type, actor_id, client_event_id,
          request_hash, kind, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(messageId, task.projectId, task.taskId, runId, actor.type, actor.id, clientEventId, hash, kind, body, now);
      this.runtime.insertEvent(task.projectId, task.taskId, actor, "task_message_appended", { messageId, kind }, now);
    });
    return messageFromRow(this.runtime.store.db.prepare("SELECT * FROM task_messages WHERE message_id = ?").get(messageId)!);
  }
}
