import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, SerialExecutor } from "./fs-utils.js";

interface RuntimeStateFile {
  version: 2;
  lastRuntimeEpoch: number;
  lastServerSequence: number;
  runtimeGenerationProof: string | null;
}

const RUNTIME_STATE_FILENAME = "runtime-state.json";

function parseRuntimeState(value: unknown): RuntimeStateFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Runtime state must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    !Number.isSafeInteger(record.lastRuntimeEpoch) ||
    (record.lastRuntimeEpoch as number) < 0 ||
    !Number.isSafeInteger(record.lastServerSequence) ||
    (record.lastServerSequence as number) < 0
  ) {
    throw new Error("Runtime state file is invalid");
  }
  const runtimeGenerationProof =
    record.version === 1 ? null : record.runtimeGenerationProof;
  if (
    runtimeGenerationProof !== null &&
    (typeof runtimeGenerationProof !== "string" ||
      !/^rgp_[A-Za-z0-9_-]{43}$/u.test(runtimeGenerationProof))
  ) {
    throw new Error("Runtime state proof is invalid");
  }
  return {
    version: 2,
    lastRuntimeEpoch: record.lastRuntimeEpoch as number,
    lastServerSequence: record.lastServerSequence as number,
    runtimeGenerationProof,
  };
}

export class RuntimeStateStore {
  readonly #path: string;
  readonly #serial = new SerialExecutor();
  #state: RuntimeStateFile = {
    version: 2,
    lastRuntimeEpoch: 0,
    lastServerSequence: 0,
    runtimeGenerationProof: null,
  };

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, RUNTIME_STATE_FILENAME);
  }

  get runtimeEpoch(): number {
    return this.#state.lastRuntimeEpoch;
  }

  get lastServerSequence(): number {
    return this.#state.lastServerSequence;
  }

  get runtimeGenerationProof(): string | null {
    return this.#state.runtimeGenerationProof;
  }

  async load(): Promise<void> {
    try {
      this.#state = parseRuntimeState(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  recordRuntimeEpoch(runtimeEpoch: number): Promise<void> {
    return this.#serial.run(async () => {
      if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 1) {
        throw new Error("Server-issued runtime epoch must be a positive safe integer");
      }
      if (runtimeEpoch < this.#state.lastRuntimeEpoch) {
        throw new Error("Server-issued runtime epoch cannot move backwards");
      }
      if (runtimeEpoch === this.#state.lastRuntimeEpoch) return;
      this.#state = {
        ...this.#state,
        lastRuntimeEpoch: runtimeEpoch,
        runtimeGenerationProof: null,
      };
      await this.#persist();
    });
  }

  recordRuntimeRegistration(
    runtimeEpoch: number,
    runtimeGenerationProof: string | null,
  ): Promise<void> {
    return this.#serial.run(async () => {
      if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 1) {
        throw new Error("Server-issued runtime epoch must be a positive safe integer");
      }
      if (runtimeEpoch < this.#state.lastRuntimeEpoch) {
        throw new Error("Server-issued runtime epoch cannot move backwards");
      }
      if (
        runtimeGenerationProof !== null &&
        !/^rgp_[A-Za-z0-9_-]{43}$/u.test(runtimeGenerationProof)
      ) {
        throw new Error("Server-issued runtime generation proof is malformed");
      }
      if (
        runtimeEpoch === this.#state.lastRuntimeEpoch &&
        runtimeGenerationProof === this.#state.runtimeGenerationProof
      ) {
        return;
      }
      this.#state = {
        ...this.#state,
        lastRuntimeEpoch: runtimeEpoch,
        runtimeGenerationProof,
      };
      await this.#persist();
    });
  }

  recordServerSequence(sequence: number): Promise<void> {
    return this.#serial.run(async () => {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Server sequence is invalid");
      if (sequence <= this.#state.lastServerSequence) return;
      this.#state = { ...this.#state, lastServerSequence: sequence };
      await this.#persist();
    });
  }

  flush(): Promise<void> {
    return this.#serial.idle();
  }

  async #persist(): Promise<void> {
    await atomicWriteFile(this.#path, `${JSON.stringify(this.#state)}\n`);
  }
}
