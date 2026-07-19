import {
  evaluateRoleAction,
  type PolicyOperation,
} from "@cicada/steward-role-policy";
import type { AgentRole } from "@cicada/steward-protocol";
import type { RpetPhase } from "./checkpoint.js";

const PHASE_OPERATIONS = Object.freeze({
  research: Object.freeze([
    "context.read",
    "research.perform",
    "progress.record",
  ] as const),
  plan: Object.freeze([
    "context.read",
    "plan.record",
    "progress.record",
  ] as const),
  execute: Object.freeze([
    "context.read",
    "workspace.modify",
    "progress.record",
  ] as const),
  test: Object.freeze([
    "context.read",
    "tests.run",
    "progress.record",
  ] as const),
} as const) satisfies Readonly<Record<RpetPhase, readonly PolicyOperation[]>>;

export interface ProviderPhaseAuthorization {
  readonly role: AgentRole;
  readonly phase: RpetPhase;
  readonly operations: readonly PolicyOperation[];
}

export class ProviderPolicyDeniedError extends Error {
  readonly role: AgentRole;
  readonly phase: RpetPhase;

  constructor(role: AgentRole, phase: RpetPhase, detail: string) {
    super(`Provider policy denied ${role} ${phase}: ${detail}`);
    this.name = "ProviderPolicyDeniedError";
    this.role = role;
    this.phase = phase;
  }
}

/**
 * The RPET runner is the modifying engineer workflow. Verifier and manager
 * work needs a separate, narrower runner rather than inheriting this one.
 */
export function assertEngineerRpetRole(role: AgentRole, phase: RpetPhase = "research"): void {
  if (role !== "engineer") {
    throw new ProviderPolicyDeniedError(
      role,
      phase,
      "only engineers may enter the modifying RPET workflow",
    );
  }
}

/** Host-owned mapping. Provider output cannot add or rename operations. */
export function authorizeProviderPhase(
  role: AgentRole,
  phase: RpetPhase,
): ProviderPhaseAuthorization {
  const operations = PHASE_OPERATIONS[phase];
  for (const operation of operations) {
    const decision = evaluateRoleAction({ role, operation });
    if (decision.disposition !== "allow") {
      const detail = decision.disposition === "deny"
        ? decision.detail
        : `${operation} requires authenticated human authority`;
      throw new ProviderPolicyDeniedError(role, phase, detail);
    }
  }
  return Object.freeze({
    role,
    phase,
    operations: Object.freeze([...operations]),
  });
}

export function operationsForProviderPhase(phase: RpetPhase): readonly PolicyOperation[] {
  return PHASE_OPERATIONS[phase];
}
