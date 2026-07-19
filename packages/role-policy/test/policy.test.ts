import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_ROLES,
  AUTHORITY_BOUNDARY,
  OPERATION_EFFECTS,
  POLICY_OPERATIONS,
  ROLE_ALLOWED_OPERATIONS,
  evaluateRoleAction,
  evaluateToolCall,
  type AgentRole,
  type PolicyOperation,
  type ToolBinding,
} from "../src/index.js";

const EXPECTED_ALLOWED = Object.freeze({
  engineer: new Set<PolicyOperation>([
    "context.read",
    "research.perform",
    "plan.record",
    "workspace.modify",
    "tests.run",
    "progress.record",
  ]),
  verifier: new Set<PolicyOperation>([
    "context.read",
    "tests.run",
    "verification.record",
    "progress.record",
  ]),
  manager: new Set<PolicyOperation>([
    "context.read",
    "review.record",
    "task.create",
    "task.route",
    "human_handoff.create",
    "progress.record",
  ]),
  impact_observer: new Set<PolicyOperation>(["impact.summarize"]),
}) satisfies Readonly<Record<AgentRole, ReadonlySet<PolicyOperation>>>;

const PRODUCTION = new Set<PolicyOperation>([
  "production.approve",
  "production.deploy",
]);

test("the complete role and operation matrix is deny-by-default", () => {
  for (const role of AGENT_ROLES) {
    for (const operation of POLICY_OPERATIONS) {
      const decision = evaluateRoleAction({ role, operation });
      if (PRODUCTION.has(operation)) {
        assert.equal(decision.disposition, "human_required", `${role}/${operation}`);
        if (decision.disposition === "human_required") {
          assert.equal(decision.reason, "production_authority_reserved_for_authenticated_human");
          assert.equal(decision.effect, OPERATION_EFFECTS[operation]);
        }
      } else if (EXPECTED_ALLOWED[role].has(operation)) {
        assert.equal(decision.disposition, "allow", `${role}/${operation}`);
        if (decision.disposition === "allow") {
          assert.equal(decision.effect, OPERATION_EFFECTS[operation]);
          assert.equal(decision.reason, "fixed_role_capability");
        }
      } else {
        assert.equal(decision.disposition, "deny", `${role}/${operation}`);
        if (decision.disposition === "deny") {
          assert.equal(decision.reason, "role_operation_not_allowed");
        }
      }
      assert.equal(Object.isFrozen(decision), true);
    }
  }
});

test("published allowlists match the intended matrix and are immutable", () => {
  assert.deepEqual(AUTHORITY_BOUNDARY, {
    agentsMayApproveProduction: false,
    agentsMayDeployProduction: false,
    authenticatedHumanRequired: true,
  });
  assert.equal(Object.isFrozen(AUTHORITY_BOUNDARY), true);
  assert.equal(Object.isFrozen(ROLE_ALLOWED_OPERATIONS), true);
  for (const role of AGENT_ROLES) {
    const published = ROLE_ALLOWED_OPERATIONS[role];
    assert.equal(Object.isFrozen(published), true, role);
    assert.deepEqual(new Set(published), EXPECTED_ALLOWED[role], role);
    assert.equal(new Set(published).size, published.length, `${role} duplicates`);
  }
  assert.equal(new Set(POLICY_OPERATIONS).size, POLICY_OPERATIONS.length);
  assert.deepEqual(Object.keys(OPERATION_EFFECTS).sort(), [...POLICY_OPERATIONS].sort());
});

test("malformed and forged role actions fail closed without throwing", () => {
  const invalid: readonly unknown[] = [
    null,
    undefined,
    [],
    "engineer",
    {},
    { role: "engineer" },
    { operation: "tests.run" },
    { role: "root", operation: "workspace.modify" },
    { role: "engineer", operation: "shell.unrestricted" },
    { role: "engineer", operation: "tests.run", approved: true },
    Object.create({ role: "engineer", operation: "tests.run" }) as unknown,
  ];
  for (const request of invalid) {
    const decision = evaluateRoleAction(request);
    assert.equal(decision.disposition, "deny");
    if (decision.disposition === "deny") assert.equal(decision.reason, "invalid_request");
  }
});

test("concrete tool evaluation uses only own trusted bindings", () => {
  const bindings: ToolBinding = Object.freeze({
    read_file: "context.read",
    write_file: "workspace.modify",
    run_tests: "tests.run",
    deploy: "production.deploy",
  });

  assert.equal(
    evaluateToolCall({ role: "verifier", tool: "read_file" }, bindings).disposition,
    "allow",
  );
  assert.equal(
    evaluateToolCall({ role: "verifier", tool: "run_tests" }, bindings).disposition,
    "allow",
  );
  assert.equal(
    evaluateToolCall({ role: "verifier", tool: "write_file" }, bindings).disposition,
    "deny",
  );
  assert.equal(
    evaluateToolCall({ role: "engineer", tool: "write_file" }, bindings).disposition,
    "allow",
  );
  const deployment = evaluateToolCall({ role: "manager", tool: "deploy" }, bindings);
  assert.equal(deployment.disposition, "human_required");
  assert.equal(deployment.tool, "deploy");

  const inherited = Object.create({ inherited_tool: "context.read" }) as ToolBinding;
  assert.equal(
    evaluateToolCall({ role: "engineer", tool: "inherited_tool" }, inherited).disposition,
    "deny",
  );
});

test("unknown, malformed, and ambiguously bound tools fail closed", () => {
  const invalidBinding = { unsafe: "workspace.delete_everything" } as unknown as ToolBinding;
  const cases: readonly [unknown, ToolBinding][] = [
    [{ role: "engineer", tool: "read_file" }, null as unknown as ToolBinding],
    [{ role: "engineer", tool: "missing" }, Object.freeze({})],
    [{ role: "root", tool: "read_file" }, Object.freeze({ read_file: "context.read" })],
    [{ role: "engineer", tool: "" }, Object.freeze({ "": "context.read" })],
    [{ role: "engineer", tool: "bad\nname" }, Object.freeze({ "bad\nname": "context.read" })],
    [{ role: "engineer", tool: "x".repeat(129) }, Object.freeze({})],
    [{ role: "engineer", tool: "read_file", extra: true }, Object.freeze({ read_file: "context.read" })],
    [{ role: "engineer", tool: "unsafe" }, invalidBinding],
  ];
  for (const [request, binding] of cases) {
    assert.equal(evaluateToolCall(request, binding).disposition, "deny");
  }
});
