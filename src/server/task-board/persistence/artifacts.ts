import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ArtifactMediaType,
  CreateProjectArtifactRequest,
  ProjectArtifact,
} from "#shared/task-board-contract";
import { TaskBoardError } from "../errors.js";

type Row = Record<string, unknown>;
const MEDIA = new Set<ArtifactMediaType>([
  "text/markdown", "text/vnd.mermaid", "image/png", "image/jpeg", "image/webp",
]);
const MAX_ARTIFACT_BYTES = 192 * 1_024;

function fromRow(row: Row): ProjectArtifact {
  return Object.freeze({
    apiVersion: "steward.task-board/v1",
    artifactId: String(row.artifact_id),
    projectId: String(row.project_id),
    nodeId: row.node_id === null ? null : String(row.node_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    mediaType: row.media_type as ArtifactMediaType,
    byteSize: Number(row.byte_size),
    digest: String(row.digest) as `sha256:${string}`,
    caption: String(row.caption),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  });
}

export class ArtifactStore {
  constructor(
    readonly db: DatabaseSync,
    readonly root: string,
    readonly now: () => Date,
  ) {}

  async create(projectId: string, request: CreateProjectArtifactRequest, actor: string): Promise<ProjectArtifact> {
    if (!MEDIA.has(request.mediaType) || typeof request.caption !== "string" || request.caption.trim() !== request.caption || request.caption.length < 1 || request.caption.length > 1_000) {
      throw new TaskBoardError(400, "ARTIFACT_INVALID", "Artifact metadata is invalid");
    }
    let bytes: Buffer;
    try {
      if (typeof request.contentBase64 !== "string" || request.contentBase64.length < 1) throw new Error();
      bytes = Buffer.from(request.contentBase64, "base64");
      if (bytes.toString("base64") !== request.contentBase64) throw new Error();
    } catch {
      throw new TaskBoardError(400, "ARTIFACT_INVALID", "Artifact content must be canonical base64");
    }
    if (bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES) throw new TaskBoardError(413, "ARTIFACT_TOO_LARGE", "Artifact is outside the supported size");
    const validContent =
      request.mediaType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
      request.mediaType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 :
      request.mediaType === "image/webp" ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" :
      !bytes.includes(0x00) && Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
    if (!validContent) throw new TaskBoardError(400, "ARTIFACT_MEDIA_MISMATCH", "Artifact content does not match its declared media type");
    if (!this.db.prepare("SELECT 1 FROM projects WHERE project_id=?").get(projectId)) throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    if (request.nodeId !== null && !this.db.prepare("SELECT 1 FROM work_nodes WHERE node_id=? AND project_id=?").get(request.nodeId, projectId)) {
      throw new TaskBoardError(400, "ARTIFACT_INVALID", "Artifact node is invalid");
    }
    if (request.taskId !== null && !this.db.prepare("SELECT 1 FROM tasks WHERE task_id=? AND project_id=?").get(request.taskId, projectId)) {
      throw new TaskBoardError(400, "ARTIFACT_INVALID", "Artifact task is invalid");
    }
    const artifactId = `artifact_${randomUUID()}`;
    const storageKey = `${artifactId}.blob`;
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const createdAt = this.now().toISOString();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, storageKey);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    try {
      this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
        artifactId, projectId, request.nodeId, request.taskId, request.mediaType, bytes.length,
        digest, storageKey, request.caption, actor, createdAt,
      );
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return this.require(artifactId);
  }

  list(projectId: string): readonly ProjectArtifact[] {
    return Object.freeze((this.db.prepare("SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at,artifact_id").all(projectId) as Row[]).map(fromRow));
  }

  require(artifactId: string): ProjectArtifact {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id=?").get(artifactId) as Row | undefined;
    if (!row) throw new TaskBoardError(404, "ARTIFACT_NOT_FOUND", "Artifact was not found");
    return fromRow(row);
  }

  async content(artifactId: string): Promise<{ artifact: ProjectArtifact; bytes: Buffer }> {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id=?").get(artifactId) as Row | undefined;
    if (!row) throw new TaskBoardError(404, "ARTIFACT_NOT_FOUND", "Artifact was not found");
    return { artifact: fromRow(row), bytes: await readFile(join(this.root, String(row.storage_key))) };
  }
}
