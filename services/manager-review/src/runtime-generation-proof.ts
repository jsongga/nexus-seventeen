import { AsyncLocalStorage } from "node:async_hooks";
import { ReviewServiceError } from "./errors.js";

const RUNTIME_GENERATION_PROOF_PATTERN = /^rgp_[A-Za-z0-9_-]{43}$/u;
const proofScope = new AsyncLocalStorage<string>();

export function withRuntimeGenerationProof<T>(
  proof: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!RUNTIME_GENERATION_PROOF_PATTERN.test(proof)) {
    throw new ReviewServiceError(
      400,
      "INVALID_RUNTIME_GENERATION_PROOF",
      "Runtime generation proof is malformed",
    );
  }
  return proofScope.run(proof, operation);
}

export function currentRuntimeGenerationProof(): string {
  const proof = proofScope.getStore();
  if (proof === undefined) {
    throw new ReviewServiceError(
      500,
      "RUNTIME_GENERATION_PROOF_CONTEXT_MISSING",
      "Manager-review permit consumption requires a runtime-bound request context",
    );
  }
  return proof;
}

export function optionalRuntimeGenerationProof(): string | undefined {
  return proofScope.getStore();
}
