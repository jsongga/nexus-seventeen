import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewServiceError, ManagerReviewWorkflow } from "../src/index.js";
import {
  FakeHandoffRegistrar,
  FakeManagerRuntimeAuthorizer,
  MANAGER_ONE,
  MANAGER_ONE_RUNTIME,
  MANAGER_TWO_RUNTIME,
  WORKSPACE_ID,
  managerReview,
  passingEvidence,
  temporaryStore,
} from "./helpers.js";

const NOW = () => new Date("2026-07-19T19:04:00.000Z");

async function workflow(
  storePath: string,
  registrar: FakeHandoffRegistrar,
  authorizer: FakeManagerRuntimeAuthorizer = new FakeManagerRuntimeAuthorizer(),
): Promise<ManagerReviewWorkflow> {
  return ManagerReviewWorkflow.open({
    workspaceId: WORKSPACE_ID,
    storePath,
    evidenceIssuerPrincipal: "service:control-plane-projection",
    handoffRegistrar: registrar,
    managerRuntimeAuthorizer: authorizer,
    now: NOW,
  });
}

test("a different fixed manager accepts exact passing evidence and creates only a human check", async () => {
  const registrar = new FakeHandoffRegistrar();
  const reviewWorkflow = await workflow(await temporaryStore(), registrar);
  try {
    const registered = await reviewWorkflow.registerEvidence(passingEvidence(), "evidence-register-0001");
    assert.equal(registered.duplicate, false);
    assert.equal((await reviewWorkflow.listManagerQueue(MANAGER_ONE_RUNTIME)).length, 1);

    await assert.rejects(
      reviewWorkflow.recordManagerReview(
        registered.evidence.evidenceId,
        managerReview(registered.evidence.evidenceDigest),
        { ...MANAGER_ONE_RUNTIME, agentId: registered.evidence.engineerAgentId },
        "self-review-0001",
      ),
      (error: unknown) => error instanceof ReviewServiceError && error.code === "SELF_REVIEW_FORBIDDEN",
    );

    const accepted = await reviewWorkflow.recordManagerReview(
      registered.evidence.evidenceId,
      managerReview(registered.evidence.evidenceDigest),
      MANAGER_ONE_RUNTIME,
      "manager-review-0001",
    );
    assert.equal(accepted.review.decision, "accepted");
    assert.equal(accepted.review.managerRuntimeInstanceId, MANAGER_ONE_RUNTIME.runtimeInstanceId);
    assert.equal(accepted.review.managerRuntimeEpoch, MANAGER_ONE_RUNTIME.runtimeEpoch);
    assert.equal(accepted.productionCheck?.status, "pending_human_review");
    assert.equal(accepted.productionCheck?.handoffId, registrar.calls.length === 1 ? accepted.productionCheck.handoffId : null);
    assert.equal((await reviewWorkflow.listManagerQueue(MANAGER_ONE_RUNTIME)).length, 0);
    assert.equal(registrar.calls.length, 1);
    assert.equal(registrar.calls[0]!.request.releaseArtifactDigest, registered.evidence.releaseArtifactDigest);
    assert.equal(registrar.calls[0]!.request.releaseManifestDigest, registered.evidence.releaseManifestDigest);
    assert.equal(registrar.calls[0]!.request.managerAgentId, MANAGER_ONE.agentId);

    const checks = reviewWorkflow.listProductionChecks(WORKSPACE_ID);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.managerReviewId, accepted.review.managerReviewId);
    assert.equal(checks[0]!.releaseManifestDigest, registered.evidence.releaseManifestDigest);
    assert.equal(checks[0]!.managerRuntimeInstanceId, MANAGER_ONE_RUNTIME.runtimeInstanceId);
    assert.equal(checks[0]!.managerRuntimeEpoch, MANAGER_ONE_RUNTIME.runtimeEpoch);
    assert.equal("createGrant" in reviewWorkflow, false);
    assert.equal("consumeGrant" in reviewWorkflow, false);
    assert.equal("deploy" in reviewWorkflow, false);

    const replay = await reviewWorkflow.recordManagerReview(
      registered.evidence.evidenceId,
      managerReview(registered.evidence.evidenceDigest),
      MANAGER_ONE_RUNTIME,
      "manager-review-0001",
    );
    assert.equal(replay.duplicate, true);
    assert.equal(replay.review.managerReviewId, accepted.review.managerReviewId);

    await assert.rejects(
      reviewWorkflow.recordManagerReview(
        registered.evidence.evidenceId,
        managerReview(registered.evidence.evidenceDigest),
        MANAGER_TWO_RUNTIME,
        "manager-two-review-0001",
      ),
      (error: unknown) => error instanceof ReviewServiceError && error.code === "EVIDENCE_ALREADY_REVIEWED",
    );
  } finally {
    await reviewWorkflow.close();
  }
});

test("a committed exact replay survives fencing while new work and queue reads require live authority", async () => {
  const registrar = new FakeHandoffRegistrar();
  const runtimeAuthorizer = new FakeManagerRuntimeAuthorizer();
  const reviewWorkflow = await workflow(await temporaryStore(), registrar, runtimeAuthorizer);
  try {
    const registered = await reviewWorkflow.registerEvidence(
      passingEvidence(),
      "evidence-fenced-replay-0001",
    );
    const request = managerReview(registered.evidence.evidenceDigest);
    const accepted = await reviewWorkflow.recordManagerReview(
      registered.evidence.evidenceId,
      request,
      MANAGER_ONE_RUNTIME,
      "manager-fenced-replay-0001",
    );
    assert.equal(accepted.duplicate, false);
    assert.equal(runtimeAuthorizer.calls.length, 1);

    runtimeAuthorizer.reject = true;
    const replacementRuntime = {
      ...MANAGER_ONE_RUNTIME,
      runtimeInstanceId: "manager-runtime-one-replacement",
      runtimeEpoch: MANAGER_ONE_RUNTIME.runtimeEpoch + 1,
    };
    const replay = await reviewWorkflow.recordManagerReview(
      registered.evidence.evidenceId,
      request,
      replacementRuntime,
      "manager-fenced-replay-0001",
    );
    assert.equal(replay.duplicate, true);
    assert.equal(replay.review.managerReviewId, accepted.review.managerReviewId);
    assert.equal(runtimeAuthorizer.calls.length, 1);

    await assert.rejects(
      reviewWorkflow.recordManagerReview(
        registered.evidence.evidenceId,
        { ...request, summary: "A conflicting replay must not bypass idempotency." },
        MANAGER_ONE_RUNTIME,
        "manager-fenced-replay-0001",
      ),
      (error: unknown) => error instanceof ReviewServiceError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(runtimeAuthorizer.calls.length, 1);

    const pending = await reviewWorkflow.registerEvidence(
      passingEvidence({
        taskId: "task-fenced-new-work",
        completionEventId: "completion-event-fenced-new-work",
      }),
      "evidence-fenced-new-work-0001",
    );
    await assert.rejects(
      reviewWorkflow.recordManagerReview(
        pending.evidence.evidenceId,
        managerReview(pending.evidence.evidenceDigest),
        MANAGER_ONE_RUNTIME,
        "manager-fenced-new-work-0001",
      ),
      /simulated fenced manager runtime/u,
    );
    assert.equal(runtimeAuthorizer.calls.length, 2);
    assert.equal(reviewWorkflow.listProductionChecks(WORKSPACE_ID).length, 1);

    await assert.rejects(
      reviewWorkflow.listManagerQueue(MANAGER_ONE_RUNTIME),
      /simulated fenced manager runtime/u,
    );
    assert.equal(runtimeAuthorizer.calls.length, 3);
  } finally {
    await reviewWorkflow.close();
  }
});

test("evidence and review text reject carriage returns at the durable boundary", async () => {
  const registrar = new FakeHandoffRegistrar();
  const reviewWorkflow = await workflow(await temporaryStore(), registrar);
  try {
    await assert.rejects(
      reviewWorkflow.registerEvidence(
        passingEvidence({ resultOverview: "Customer result\rInjected line" }),
        "evidence-carriage-return-0001",
      ),
      (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_REQUEST",
    );

    const registered = await reviewWorkflow.registerEvidence(
      passingEvidence(),
      "evidence-carriage-return-valid-0001",
    );
    await assert.rejects(
      reviewWorkflow.recordManagerReview(
        registered.evidence.evidenceId,
        {
          ...managerReview(registered.evidence.evidenceDigest),
          summary: "Valid-looking review\rInjected line",
        },
        MANAGER_ONE_RUNTIME,
        "review-carriage-return-0001",
      ),
      (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_REQUEST",
    );
  } finally {
    await reviewWorkflow.close();
  }
});

test("changes requested returns to humans no production check and never contacts the broker", async () => {
  const registrar = new FakeHandoffRegistrar();
  const reviewWorkflow = await workflow(await temporaryStore(), registrar);
  try {
    const registered = await reviewWorkflow.registerEvidence(passingEvidence(), "evidence-changes-0001");
    const result = await reviewWorkflow.recordManagerReview(
      registered.evidence.evidenceId,
      managerReview(registered.evidence.evidenceDigest, "changes_requested"),
      MANAGER_ONE_RUNTIME,
      "manager-changes-0001",
    );
    assert.equal(result.productionCheck, null);
    assert.equal(reviewWorkflow.listProductionChecks(WORKSPACE_ID).length, 0);
    const feedback = reviewWorkflow.listEngineerFeedback(WORKSPACE_ID);
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]!.status, "changes_requested");
    assert.equal(feedback[0]!.engineerAgentId, registered.evidence.engineerAgentId);
    assert.equal(feedback[0]!.managerRuntimeInstanceId, MANAGER_ONE_RUNTIME.runtimeInstanceId);
    assert.equal(feedback[0]!.managerRuntimeEpoch, MANAGER_ONE_RUNTIME.runtimeEpoch);
    assert.equal(feedback[0]!.reviewSummary, result.review.summary);
    assert.equal(registrar.calls.length, 0);
  } finally {
    await reviewWorkflow.close();
  }
});

test("concurrent managers cannot review the same evidence twice", async () => {
  const registrar = new FakeHandoffRegistrar();
  const runtimeAuthorizer = new FakeManagerRuntimeAuthorizer();
  const reviewWorkflow = await workflow(await temporaryStore(), registrar, runtimeAuthorizer);
  try {
    const registered = await reviewWorkflow.registerEvidence(passingEvidence(), "evidence-race-0001");
    const attempts = await Promise.allSettled([
      reviewWorkflow.recordManagerReview(
        registered.evidence.evidenceId,
        managerReview(registered.evidence.evidenceDigest),
        MANAGER_ONE_RUNTIME,
        "manager-race-one-0001",
      ),
      reviewWorkflow.recordManagerReview(
        registered.evidence.evidenceId,
        managerReview(registered.evidence.evidenceDigest),
        MANAGER_TWO_RUNTIME,
        "manager-race-two-0001",
      ),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.equal(runtimeAuthorizer.calls.length, 1);
    assert.equal(reviewWorkflow.listProductionChecks(WORKSPACE_ID).length, 1);
    assert.equal(registrar.calls.length, 1);
  } finally {
    await reviewWorkflow.close();
  }
});

test("a lost broker response remains visible and retries the same immutable handoff after restart", async () => {
  const storePath = await temporaryStore();
  const registrar = new FakeHandoffRegistrar();
  registrar.failuresRemaining = 1;
  const first = await workflow(storePath, registrar);
  let reviewId: string;
  try {
    const registered = await first.registerEvidence(passingEvidence(), "evidence-restart-0001");
    const reviewed = await first.recordManagerReview(
      registered.evidence.evidenceId,
      managerReview(registered.evidence.evidenceDigest),
      MANAGER_ONE_RUNTIME,
      "manager-restart-0001",
    );
    reviewId = reviewed.review.managerReviewId;
    assert.equal(reviewed.productionCheck?.status, "handoff_registration_pending");
    assert.equal(first.listProductionChecks(WORKSPACE_ID)[0]!.handoffId, null);
  } finally {
    await first.close();
  }

  const restarted = await workflow(storePath, registrar);
  try {
    await restarted.deliverPendingHandoffs();
    const check = restarted.listProductionChecks(WORKSPACE_ID)[0]!;
    assert.equal(check.managerReviewId, reviewId!);
    assert.equal(check.status, "pending_human_review");
    assert.ok(check.handoffId);
    assert.equal(registrar.calls.length, 2);
    assert.equal(registrar.calls[0]!.idempotencyKey, registrar.calls[1]!.idempotencyKey);
    assert.deepEqual(registrar.calls[0]!.request, registrar.calls[1]!.request);
  } finally {
    await restarted.close();
  }
});

test("one poison handoff cannot starve later pending reviews", async () => {
  const registrar = new FakeHandoffRegistrar();
  registrar.failAll = true;
  const reviewWorkflow = await workflow(await temporaryStore(), registrar);
  try {
    const firstEvidence = await reviewWorkflow.registerEvidence(
      passingEvidence(),
      "evidence-starvation-one-0001",
    );
    const firstReview = await reviewWorkflow.recordManagerReview(
      firstEvidence.evidence.evidenceId,
      managerReview(firstEvidence.evidence.evidenceDigest),
      MANAGER_ONE_RUNTIME,
      "manager-starvation-one-0001",
    );
    const secondEvidence = await reviewWorkflow.registerEvidence(
      passingEvidence({
        taskId: "task-checkout-retry-two",
        completionEventId: "completion-event-0002",
      }),
      "evidence-starvation-two-0001",
    );
    const secondReview = await reviewWorkflow.recordManagerReview(
      secondEvidence.evidence.evidenceId,
      managerReview(secondEvidence.evidence.evidenceDigest),
      MANAGER_TWO_RUNTIME,
      "manager-starvation-two-0001",
    );
    assert.equal(firstReview.productionCheck?.status, "handoff_registration_pending");
    assert.equal(secondReview.productionCheck?.status, "handoff_registration_pending");

    registrar.failAll = false;
    registrar.permanentFailures.add(firstReview.review.managerReviewId);
    await reviewWorkflow.deliverPendingHandoffs();

    const checks = reviewWorkflow.listProductionChecks(WORKSPACE_ID);
    assert.equal(
      checks.find((check) => check.managerReviewId === firstReview.review.managerReviewId)?.status,
      "handoff_registration_pending",
    );
    assert.equal(
      checks.find((check) => check.managerReviewId === secondReview.review.managerReviewId)?.status,
      "pending_human_review",
    );
  } finally {
    await reviewWorkflow.close();
  }
});
