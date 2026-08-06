import { randomUUID } from "node:crypto";
import type {
  DocumentEvent,
  DocumentSnapshot,
  DocumentSummary,
  CreateDocumentRequest,
  UpdateDocumentPenRequest,
  UpdateDocumentRequest,
} from "#shared/task-board-contract";
import { canonicalJson } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import {
  documentEventFromRow,
  documentFromRow,
  documentSummaryFromRow,
} from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { Actor, TaskBoardRuntime } from "./runtime.js";

type DocumentEventType = DocumentEvent["eventType"];

export class DocumentsCollaborator {
  constructor(private readonly runtime: TaskBoardRuntime) {}

  createDocument(projectId: string, request: CreateDocumentRequest): DocumentSnapshot {
    this.runtime.requireProject(projectId);
    const documentId = randomUUID();
    const now = exactNow(this.runtime.config.now);
    const actor: Actor = { type: "human", id: this.runtime.config.humanPrincipal };
    this.runtime.store.transaction(() => {
      this.runtime.store.db.prepare(`
        INSERT INTO documents(
          document_id, project_id, title, content_type, content, content_version,
          pen_epoch, pen_holder_actor_type, pen_holder_actor_id, pen_holder_client_id,
          pen_acquired_at, sequence, created_at, updated_at
        ) VALUES (?, ?, ?, 'text/markdown', ?, 1, 1, 'human', ?, ?, ?, 1, ?, ?)
      `).run(
        documentId,
        projectId,
        request.title,
        request.content,
        actor.id,
        request.clientId,
        now,
        now,
        now,
      );
      this.insertDocumentEvent(this.requireDocument(documentId), actor, request.clientId, "document_created", now);
    });
    return this.requireDocument(documentId);
  }

  listDocuments(projectId: string): readonly DocumentSummary[] {
    this.runtime.requireProject(projectId);
    return Object.freeze(this.runtime.store.db.prepare(`
      SELECT * FROM documents WHERE project_id = ? ORDER BY updated_at DESC, document_id
    `).all(projectId).map(documentSummaryFromRow));
  }

  getDocument(documentId: string): DocumentSnapshot {
    return this.requireDocument(documentId);
  }

  updateDocumentPen(documentId: string, request: UpdateDocumentPenRequest, actor: Actor): DocumentSnapshot {
    const current = this.requireDocument(documentId);
    this.assertDocumentActor(current, actor);
    if (request.force && actor.type !== "human") {
      throw new TaskBoardError(403, "DOCUMENT_FORCE_HUMAN_ONLY", "Only a human can force a pen takeover");
    }

    const sameHolder = current.penHolder?.actorType === actor.type
      && current.penHolder.actorId === actor.id
      && current.penHolder.clientId === request.clientId;
    if (
      request.action === "acquire" &&
      sameHolder &&
      (request.expectedPenEpoch === current.penEpoch || request.expectedPenEpoch === current.penEpoch - 1)
    ) return current;
    if (request.expectedPenEpoch !== current.penEpoch) {
      throw conflict("DOCUMENT_PEN_EPOCH_CONFLICT", "Document pen epoch changed");
    }
    if (request.action === "release" && current.penHolder === null) return current;
    if (request.action === "acquire" && current.penHolder !== null && !request.force) {
      throw conflict("DOCUMENT_PEN_HELD", "Document pen is held by another client");
    }
    if (request.action === "release" && !sameHolder) {
      throw new TaskBoardError(403, "DOCUMENT_PEN_NOT_HELD", "Only the current pen holder can release it");
    }
    if (request.action === "acquire" && current.penEpoch === Number.MAX_SAFE_INTEGER) {
      throw conflict("DOCUMENT_PEN_EPOCH_EXHAUSTED", "Document pen epoch is exhausted");
    }

    const now = exactNow(this.runtime.config.now);
    const nextSequence = current.sequence + 1;
    const eventType: DocumentEventType = request.action === "acquire" ? "document_pen_acquired" : "document_pen_released";
    this.runtime.store.transaction(() => {
      const update = request.action === "acquire"
        ? this.runtime.store.db.prepare(`
            UPDATE documents
            SET pen_epoch = pen_epoch + 1, pen_holder_actor_type = ?, pen_holder_actor_id = ?,
                pen_holder_client_id = ?, pen_acquired_at = ?, sequence = sequence + 1, updated_at = ?
            WHERE document_id = ? AND pen_epoch = ? AND sequence = ?
          `).run(actor.type, actor.id, request.clientId, now, now, documentId, current.penEpoch, current.sequence)
        : this.runtime.store.db.prepare(`
            UPDATE documents
            SET pen_holder_actor_type = NULL, pen_holder_actor_id = NULL, pen_holder_client_id = NULL,
                pen_acquired_at = NULL, sequence = sequence + 1, updated_at = ?
            WHERE document_id = ? AND pen_epoch = ? AND sequence = ?
              AND pen_holder_actor_type = ? AND pen_holder_actor_id = ? AND pen_holder_client_id = ?
          `).run(now, documentId, current.penEpoch, current.sequence, actor.type, actor.id, request.clientId);
      if (Number(update.changes) !== 1) throw conflict("DOCUMENT_VERSION_CONFLICT", "Document changed");
      const changed = this.requireDocument(documentId);
      if (changed.sequence !== nextSequence) throw new Error("TASK_BOARD_DOCUMENT_SEQUENCE_INVALID");
      this.insertDocumentEvent(changed, actor, request.clientId, eventType, now);
    });
    const document = this.requireDocument(documentId);
    this.emitDocumentEvent(documentId, document.sequence);
    return document;
  }

  updateDocument(documentId: string, request: UpdateDocumentRequest, actor: Actor): DocumentSnapshot {
    const current = this.requireDocument(documentId);
    this.assertDocumentActor(current, actor);
    if (request.penEpoch !== current.penEpoch) {
      throw conflict("DOCUMENT_PEN_EPOCH_CONFLICT", "Document pen epoch changed");
    }
    if (request.contentVersion !== current.contentVersion) {
      throw conflict("DOCUMENT_CONTENT_VERSION_CONFLICT", "Document content version changed");
    }
    if (
      current.penHolder === null ||
      current.penHolder.actorType !== actor.type ||
      current.penHolder.actorId !== actor.id ||
      current.penHolder.clientId !== request.clientId
    ) {
      throw new TaskBoardError(403, "DOCUMENT_PEN_NOT_HELD", "The current actor and client do not hold the document pen");
    }
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.transaction(() => {
      const update = this.runtime.store.db.prepare(`
        UPDATE documents
        SET content = ?, content_version = content_version + 1, sequence = sequence + 1, updated_at = ?
        WHERE document_id = ? AND content_version = ? AND pen_epoch = ? AND sequence = ?
          AND pen_holder_actor_type = ? AND pen_holder_actor_id = ? AND pen_holder_client_id = ?
      `).run(
        request.content,
        now,
        documentId,
        current.contentVersion,
        current.penEpoch,
        current.sequence,
        actor.type,
        actor.id,
        request.clientId,
      );
      if (Number(update.changes) !== 1) throw conflict("DOCUMENT_VERSION_CONFLICT", "Document changed");
      this.insertDocumentEvent(this.requireDocument(documentId), actor, request.clientId, "document_updated", now);
    });
    const document = this.requireDocument(documentId);
    this.emitDocumentEvent(documentId, document.sequence);
    return document;
  }

  listDocumentEvents(documentId: string, after = 0): readonly DocumentEvent[] {
    this.requireDocument(documentId);
    return Object.freeze(this.runtime.store.db.prepare(`
      SELECT * FROM document_events
      WHERE document_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT 200
    `).all(documentId, after).map(documentEventFromRow));
  }

  subscribeDocumentEvents(documentId: string, listener: (event: DocumentEvent) => void): () => void {
    this.requireDocument(documentId);
    this.runtime.documentEvents.on(documentId, listener);
    return () => this.runtime.documentEvents.off(documentId, listener);
  }

  private requireDocument(documentId: string): DocumentSnapshot {
    const row = this.runtime.store.db.prepare("SELECT * FROM documents WHERE document_id = ?").get(documentId);
    if (!row) throw new TaskBoardError(404, "DOCUMENT_NOT_FOUND", "Document was not found");
    return documentFromRow(row);
  }

  private assertDocumentActor(document: DocumentSnapshot, actor: Actor): void {
    if (actor.type === "human") {
      if (actor.id !== this.runtime.config.humanPrincipal) {
        throw new TaskBoardError(403, "DOCUMENT_PROJECT_FORBIDDEN", "Actor cannot access this document");
      }
      return;
    }
    const agent = this.runtime.requireAgent(actor.id);
    if (agent.projectId !== document.projectId) {
      throw new TaskBoardError(403, "DOCUMENT_PROJECT_FORBIDDEN", "Agent belongs to another project");
    }
  }

  private insertDocumentEvent(
    document: DocumentSnapshot,
    actor: Actor,
    clientId: string,
    eventType: DocumentEventType,
    now: string,
  ): void {
    this.runtime.store.db.prepare(`
      INSERT INTO document_events(
        document_id, sequence, event_id, project_id, event_type, actor_type,
        actor_id, client_id, document_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      document.documentId,
      document.sequence,
      randomUUID(),
      document.projectId,
      eventType,
      actor.type,
      actor.id,
      clientId,
      canonicalJson(document),
      now,
    );
  }

  private emitDocumentEvent(documentId: string, sequence: number): void {
    const row = this.runtime.store.db.prepare(`
      SELECT * FROM document_events WHERE document_id = ? AND sequence = ?
    `).get(documentId, sequence);
    if (!row) throw new Error("TASK_BOARD_DATABASE_CORRUPT:document_event");
    const event = documentEventFromRow(row);
    for (const candidate of this.runtime.documentEvents.listeners(documentId)) {
      try {
        (candidate as (item: DocumentEvent) => void)(event);
      } catch {
        // A disconnected watcher cannot make a committed document mutation fail.
      }
    }
  }
}
