import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_ROLES,
  WORKFLOW_SIGNALS,
  WORKFLOW_STATES,
  WORKFLOW_TRANSITIONS,
  validateWorkflowTransition,
  type AgentRole,
  type WorkflowActor,
  type WorkflowSignal,
  type WorkflowState,
} from "../src/index.js";

type ExpectedActor = AgentRole | "authenticated_human";
type ExpectedRule = readonly [WorkflowState, WorkflowState, WorkflowSignal, ExpectedActor];

const EXPECTED_RULES: readonly ExpectedRule[] = [
  ["queued", "engineer_research", "work_started", "engineer"],
  ["engineer_research", "engineer_plan", "research_complete", "engineer"],
  ["engineer_plan", "engineer_execute", "plan_complete", "engineer"],
  ["engineer_execute", "engineer_test", "implementation_complete", "engineer"],
  ["engineer_test", "engineer_research", "test_failed", "engineer"],
  ["engineer_test", "verifier_review", "test_passed", "engineer"],
  ["verifier_review", "engineer_research", "verification_changes_requested", "verifier"],
  ["verifier_review", "manager_review", "verification_passed", "verifier"],
  ["manager_review", "engineer_research", "manager_changes_requested", "manager"],
  ["manager_review", "human_review_pending", "human_handoff_created", "manager"],
  ["human_review_pending", "engineer_research", "human_changes_requested", "authenticated_human"],
  ["human_review_pending", "human_approved", "human_approved", "authenticated_human"],
  ["human_approved", "deployed", "human_deployed", "authenticated_human"],
];

const ACTORS: readonly Readonly<{ label: string; value: WorkflowActor }>[] = [
  ...AGENT_ROLES.map((role) => ({ label: role, value: { kind: "agent", role } as const })),
  { label: "authenticated_human", value: { kind: "human", authenticated: true } },
  { label: "unauthenticated_human", value: { kind: "human", authenticated: false } },
];

test("the complete state, signal, and actor matrix allows only fixed transitions", () => {
  for (const from of WORKFLOW_STATES) {
    for (const to of WORKFLOW_STATES) {
      for (const signal of WORKFLOW_SIGNALS) {
        const expected = EXPECTED_RULES.find(
          (rule) => rule[0] === from && rule[1] === to && rule[2] === signal,
        );
        for (const actor of ACTORS) {
          const decision = validateWorkflowTransition({ from, to, signal, actor: actor.value });
          const label = `${from}/${to}/${signal}/${actor.label}`;
          if (expected === undefined) {
            assert.equal(decision.disposition, "deny", label);
            continue;
          }

          if (expected[3] === "authenticated_human") {
            if (actor.label === "authenticated_human") {
              assert.equal(decision.disposition, "allow", label);
            } else if (
              actor.label === "unauthenticated_human" ||
              to === "human_approved" ||
              to === "deployed"
            ) {
              assert.equal(decision.disposition, "human_required", label);
            } else {
              assert.equal(decision.disposition, "deny", label);
            }
          } else if (actor.label === expected[3]) {
            assert.equal(decision.disposition, "allow", label);
          } else {
            assert.equal(decision.disposition, "deny", label);
          }
          assert.equal(Object.isFrozen(decision), true, label);
        }
      }
    }
  }
});

test("published workflow rules exactly match the RPET and oversight path", () => {
  assert.equal(Object.isFrozen(WORKFLOW_TRANSITIONS), true);
  assert.deepEqual(
    WORKFLOW_TRANSITIONS.map((rule) => [rule.from, rule.to, rule.signal, rule.actor]),
    EXPECTED_RULES,
  );
  assert.equal(
    new Set(WORKFLOW_TRANSITIONS.map((rule) => `${rule.from}|${rule.to}|${rule.signal}`)).size,
    WORKFLOW_TRANSITIONS.length,
  );
  assert.equal(
    WORKFLOW_TRANSITIONS.some((rule) => rule.from === "engineer_test" && rule.signal === "test_failed" && rule.to === "engineer_research"),
    true,
  );
  assert.equal(
    WORKFLOW_TRANSITIONS.some((rule) => (rule.from as WorkflowState) === "deployed"),
    false,
  );
});

test("production approval and deployment cannot be performed by an agent", () => {
  for (const role of AGENT_ROLES) {
    const approval = validateWorkflowTransition({
      from: "human_review_pending",
      to: "human_approved",
      signal: "human_approved",
      actor: { kind: "agent", role },
    });
    assert.equal(approval.disposition, "human_required", role);

    const deployment = validateWorkflowTransition({
      from: "human_approved",
      to: "deployed",
      signal: "human_deployed",
      actor: { kind: "agent", role },
    });
    assert.equal(deployment.disposition, "human_required", role);
  }
});

test("malformed transitions fail closed without throwing", () => {
  const invalid: readonly unknown[] = [
    null,
    [],
    {},
    { from: "queued", to: "engineer_research", signal: "work_started" },
    {
      from: "unknown",
      to: "engineer_research",
      signal: "work_started",
      actor: { kind: "agent", role: "engineer" },
    },
    {
      from: "queued",
      to: "engineer_research",
      signal: "skip_controls",
      actor: { kind: "agent", role: "engineer" },
    },
    {
      from: "queued",
      to: "engineer_research",
      signal: "work_started",
      actor: { kind: "agent", role: "root" },
    },
    {
      from: "queued",
      to: "engineer_research",
      signal: "work_started",
      actor: { kind: "human", authenticated: "yes" },
    },
    {
      from: "queued",
      to: "engineer_research",
      signal: "work_started",
      actor: { kind: "agent", role: "engineer", authenticated: true },
    },
    {
      from: "queued",
      to: "engineer_research",
      signal: "work_started",
      actor: { kind: "agent", role: "engineer" },
      force: true,
    },
  ];

  for (const request of invalid) {
    const decision = validateWorkflowTransition(request);
    assert.equal(decision.disposition, "deny");
    if (decision.disposition === "deny") assert.equal(decision.reason, "invalid_request");
  }
});
