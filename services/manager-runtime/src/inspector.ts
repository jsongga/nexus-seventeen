import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseInspectionResult } from "./schema.js";
import type {
  EvidenceInspectionRequest,
  EvidenceInspectionResult,
  ReadOnlyManagerInspector,
} from "./types.js";

export interface FrozenEvidenceFileInspectorOptions {
  readonly evidenceDirectory: string;
  readonly maxBytes?: number;
}

function integer(value: number | undefined): number {
  const parsed = value ?? 64 * 1_024;
  if (!Number.isSafeInteger(parsed) || parsed < 1_024 || parsed > 1024 * 1_024) {
    throw new Error("maxBytes is outside its safe range");
  }
  return parsed;
}

/**
 * Reads an immutable review bundle through O_RDONLY/O_NOFOLLOW. It has no API
 * for writing to the developer workspace or executing a command.
 */
export class FrozenEvidenceFileInspector implements ReadOnlyManagerInspector {
  readonly #directory: string;
  readonly #maxBytes: number;

  constructor(options: FrozenEvidenceFileInspectorOptions) {
    this.#directory = resolve(options.evidenceDirectory);
    this.#maxBytes = integer(options.maxBytes);
  }

  async inspect(request: EvidenceInspectionRequest, signal?: AbortSignal): Promise<EvidenceInspectionResult> {
    if (signal?.aborted) throw new Error("Manager inspection was canceled");
    if (!/^[0-9a-f-]{36}$/u.test(request.evidence.evidenceId)) throw new Error("Evidence identifier is invalid");
    const path = resolve(this.#directory, `${request.evidence.evidenceId}.review.json`);
    if (!path.startsWith(`${this.#directory}${sep}`)) throw new Error("Evidence path escapes its read-only directory");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > this.#maxBytes) {
        throw new Error("Frozen evidence bundle size is invalid");
      }
      const bytes = await handle.readFile();
      if (signal?.aborted) throw new Error("Manager inspection was canceled");
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Frozen evidence bundle is invalid");
      }
      const bundle = value as Record<string, unknown>;
      const keys = Object.keys(bundle).sort();
      const expected = [
        "version", "evidenceId", "state", "evidenceDigest", "testEvidenceDigest", "releaseArtifactDigest",
        "releaseManifestDigest", "summary", "remainingRisks",
      ].sort();
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new Error("Frozen evidence bundle has unexpected or missing fields");
      }
      if (bundle.version !== 1 || bundle.evidenceId !== request.evidence.evidenceId) {
        throw new Error("Frozen evidence bundle does not match the assigned evidence");
      }
      const result = parseInspectionResult({
        state: bundle.state,
        evidenceDigest: bundle.evidenceDigest,
        testEvidenceDigest: bundle.testEvidenceDigest,
        releaseArtifactDigest: bundle.releaseArtifactDigest,
        releaseManifestDigest: bundle.releaseManifestDigest,
        summary: bundle.summary,
        remainingRisks: bundle.remainingRisks,
      });
      return result;
    } finally {
      await handle.close();
    }
  }
}
