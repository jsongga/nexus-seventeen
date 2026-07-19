import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  parseAgentTaskProjection,
  type AgentTaskProjection,
  type Sha256Digest,
} from "@cicada/steward-protocol";
import { ManagerRuntime } from "../src/runner.js";
import { createManagerRuntimeInstanceId } from "../src/process-identity.js";
import type {
  EvidenceInspectionRequest,
  EvidenceInspectionResult,
  ReadOnlyManagerInspector,
} from "../src/types.js";
import {
  FakeControl,
  FakeReviews,
  GENERATION_PROOF,
  MANIFEST_DIGEST,
  NOW,
  REVIEW_TASK,
  SequenceInspector,
  command,
  evidence,
  identity,
  inspection,
  reviewTask,
  tempRoot,
} from "./helpers.js";

async function makeRuntime(
  root: string,
  control: FakeControl,
  reviews: FakeReviews,
  inspector: ReadOnlyManagerInspector,
  options: Readonly<{ runtimeInstanceId?: string; now?: () => Date; maxReviewIterations?: number }> = {},
): Promise<ManagerRuntime> {
  return ManagerRuntime.create({
    identity: identity(options.runtimeInstanceId),
    statePath: join(root, "state", "manager.json"),
    control,
    reviews,
    inspector,
    now: options.now ?? (() => new Date(NOW)),
    ...(options.maxReviewIterations === undefined ? {} : { maxReviewIterations: options.maxReviewIterations }),
  });
}

async function assign(runtime: ManagerRuntime, task = reviewTask()): Promise<void> {
  await runtime.handleCommand(command(1, { type: "assign_task", task }));
}

async function completeOnePass(runtime: ManagerRuntime): Promise<void> {
  await runtime.workOnce();
  await runtime.workOnce();
  await runtime.workOnce();
}

function runningReviewTask(): AgentTaskProjection {
  return parseAgentTaskProjection({
    ...reviewTask(),
    status: "running",
    startedAt: NOW,
  });
}

test("executes an exact manager review and lets the review permit complete the task", async () => {
  const root = await tempRoot();
  const control = new FakeControl();
  const reviews = new FakeReviews();
  const runtime = await makeRuntime(root, control, reviews, new SequenceInspector([inspection("accepted")]));
  try {
    await runtime.start();
    await assign(runtime);
    reviews.beforeRecord = () => {
      const heartbeat = control.uploaded.at(-1)?.payload;
      assert.equal(heartbeat?.type, "heartbeat");
      assert.notEqual(heartbeat.type === "heartbeat" ? heartbeat.currentAction : null, null);
    };

    await completeOnePass(runtime);
    await runtime.flushEvents();

    assert.equal(reviews.calls.length, 1);
    assert.equal(reviews.calls[0]?.request.reviewTaskId, REVIEW_TASK);
    assert.equal(reviews.calls[0]?.claim.runtimeGenerationProof, GENERATION_PROOF);
    assert.equal(runtime.snapshot.active, null);
    assert.deepEqual(
      control.uploaded.flatMap((event) => event.payload.type === "progress" ? [event.payload.phase] : []),
      ["research", "plan", "execute", "test"],
    );
    assert.equal(control.uploaded.some((event) => event.payload.type === "task_completed"), false);
  } finally {
    await runtime.close();
  }
});

test("runs a bounded research-plan-execute-test loop until review evidence is conclusive", async () => {
  const root = await tempRoot();
  const control = new FakeControl();
  const reviews = new FakeReviews();
  const inspector = new SequenceInspector([inspection("continue"), inspection("accepted")]);
  const runtime = await makeRuntime(root, control, reviews, inspector, { maxReviewIterations: 2 });
  try {
    await runtime.start();
    await assign(runtime);
    await runtime.workOnce();
    await runtime.workOnce();
    assert.equal(runtime.snapshot.active?.iteration, 2);
    await runtime.workOnce();
    await runtime.workOnce();
    await runtime.flushEvents();

    assert.equal(inspector.calls.length, 2);
    assert.equal(reviews.calls[0]?.request.decision, "accepted");
    assert.deepEqual(
      control.uploaded.flatMap((event) => event.payload.type === "progress"
        ? [`${event.payload.phase}:${event.payload.iteration}`]
        : []),
      ["research:1", "plan:1", "execute:1", "test:1", "research:2", "plan:2", "execute:2", "test:2"],
    );
  } finally {
    await runtime.close();
  }
});

test("fails closed to changes requested when any frozen digest is different", async () => {
  const root = await tempRoot();
  const control = new FakeControl();
  const reviews = new FakeReviews();
  const otherManifest = `sha256:${"e".repeat(64)}` as const;
  const runtime = await makeRuntime(
    root,
    control,
    reviews,
    new SequenceInspector([inspection("accepted", { releaseManifestDigest: otherManifest })]),
  );
  try {
    await runtime.start();
    await assign(runtime);
    await completeOnePass(runtime);
    assert.equal(reviews.calls[0]?.request.decision, "changes_requested");
    assert.match(reviews.calls[0]?.request.remainingRisks ?? "", /manifest binding remains unverified/u);
  } finally {
    await runtime.close();
  }
});

test("interrupts in-flight inspection, honors hold, resumes, and preserves queued work", async () => {
  let inspectionCalls = 0;
  let inspectionStarted!: () => void;
  const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
  const blockingInspector: ReadOnlyManagerInspector = {
    inspect(_request: EvidenceInspectionRequest, signal?: AbortSignal): Promise<EvidenceInspectionResult> {
      inspectionCalls += 1;
      inspectionStarted();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
      });
    },
  };
  const root = await tempRoot();
  const control = new FakeControl();
  const reviews = new FakeReviews();
  const runtime = await makeRuntime(root, control, reviews, blockingInspector);
  try {
    await runtime.start();
    await assign(runtime);
    await runtime.handleCommand(command(2, { type: "assign_task", task: reviewTask("task_manager_review_next") }));
    await runtime.workOnce();
    const work = runtime.workOnce();
    await started;
    await runtime.handleCommand(command(3, { type: "request_interrupt", reason: "Human inspection requested" }));
    await work;
    assert.equal(runtime.snapshot.desiredState, "paused");
    assert.equal(runtime.snapshot.active?.phase, "inspect");
    assert.equal(runtime.snapshot.queuedTasks[0]?.taskId, "task_manager_review_next");

    await runtime.handleCommand(command(4, { type: "hold", reason: "Freeze manager execution" }));
    await runtime.workOnce();
    assert.equal(inspectionCalls, 1);
    assert.equal(runtime.snapshot.desiredState, "held");
    await runtime.handleCommand(command(5, { type: "resume", taskId: reviewTask().taskId, checkpointRef: null }));
    assert.equal(runtime.snapshot.desiredState, "active");
    await runtime.flushEvents();
    const lifecycle = control.uploaded.map((event) => event.payload.type);
    assert.ok(lifecycle.includes("interrupt_acknowledged"));
    assert.ok(lifecycle.includes("interrupt_settled"));
    assert.ok(lifecycle.includes("hold_acknowledged"));
    assert.ok(lifecycle.includes("hold_settled"));
  } finally {
    await runtime.close();
  }
});

test("fresh recovery suppresses duplicate RPET progress but still records the review", async () => {
  const root = await tempRoot();
  const control = new FakeControl();
  const reviews = new FakeReviews();
  const runtime = await makeRuntime(root, control, reviews, new SequenceInspector([inspection("accepted")]));
  try {
    await runtime.start();
    await runtime.handleCommand(command(1, { type: "recover_task", task: runningReviewTask() }));
    assert.equal(runtime.snapshot.active?.progressMode, "suppress");
    await completeOnePass(runtime);
    await runtime.flushEvents();
    assert.equal(reviews.calls.length, 1);
    assert.equal(control.uploaded.some((event) => event.payload.type === "progress"), false);
    assert.equal(control.uploaded.some((event) => event.payload.type === "task_completed"), false);
  } finally {
    await runtime.close();
  }
});

test("recovery of a known local task preserves its phase and progress cursor", async () => {
  const root = await tempRoot();
  const runtime = await makeRuntime(root, new FakeControl(), new FakeReviews(), new SequenceInspector([]));
  try {
    await runtime.start();
    await assign(runtime);
    await runtime.workOnce();
    assert.equal(runtime.snapshot.active?.phase, "inspect");
    await runtime.handleCommand(command(2, { type: "recover_task", task: runningReviewTask() }));
    assert.equal(runtime.snapshot.active?.phase, "inspect");
    assert.equal(runtime.snapshot.active?.iteration, 1);
    assert.equal(runtime.snapshot.active?.progressMode, "emit");
  } finally {
    await runtime.close();
  }
});

test("renews the runtime lease near its midpoint instead of on every poll", async () => {
  let clock = new Date("2026-07-19T20:00:20.000Z");
  const root = await tempRoot();
  const control = new FakeControl();
  const runtime = await makeRuntime(root, control, new FakeReviews(), new SequenceInspector([]), { now: () => clock });
  try {
    await runtime.start();
    await runtime.controlOnce();
    assert.equal(control.renewCalls, 0);
    clock = new Date("2026-07-19T20:00:31.000Z");
    await runtime.controlOnce();
    assert.equal(control.renewCalls, 1);
    clock = new Date("2026-07-19T20:00:40.000Z");
    await runtime.controlOnce();
    assert.equal(control.renewCalls, 1);
  } finally {
    await runtime.close();
  }
});

test("durably retries an identical registration intent after a lost response", async () => {
  const root = await tempRoot();
  const path = join(root, "state", "manager.json");
  const control = new FakeControl();
  control.registrationFailures = 1;
  const first = await makeRuntime(root, control, new FakeReviews(), new SequenceInspector([]));
  await assert.rejects(first.start(), /lost registration response/u);
  await first.close();
  const intentOnDisk = JSON.parse(await readFile(path, "utf8")) as {
    registrationIntent: { runtimeProofChallenge: string; request: unknown };
  };
  assert.match(intentOnDisk.registrationIntent.runtimeProofChallenge, /^rgc_[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(intentOnDisk.registrationIntent.request, control.registrations[0]?.request);

  const retry = await makeRuntime(root, control, new FakeReviews(), new SequenceInspector([]));
  try {
    await retry.start();
    assert.equal(control.registrations.length, 2);
    assert.deepEqual(control.registrations[1]?.request, control.registrations[0]?.request);
    assert.equal(control.registrations[1]?.challenge, control.registrations[0]?.challenge);
    assert.equal(control.registrations[1]?.replacementProof, control.registrations[0]?.replacementProof);
  } finally {
    await retry.close();
  }
});

test("persists the generation proof owner-only and presents it for replacement", async () => {
  const root = await tempRoot();
  const path = join(root, "state", "manager.json");
  const firstControl = new FakeControl();
  const first = await makeRuntime(root, firstControl, new FakeReviews(), new SequenceInspector([]));
  await first.start();
  await first.close();

  const secondControl = new FakeControl();
  secondControl.generationProof = `rgp_${"B".repeat(43)}`;
  const freshRuntimeInstanceId = createManagerRuntimeInstanceId();
  assert.notEqual(freshRuntimeInstanceId, firstControl.registrations[0]?.request.runtimeInstanceId);
  const second = await makeRuntime(
    root,
    secondControl,
    new FakeReviews(),
    new SequenceInspector([]),
    { runtimeInstanceId: freshRuntimeInstanceId },
  );
  try {
    await second.start();
    assert.equal(secondControl.registrations[0]?.request.expectedRuntimeEpoch, 1);
    assert.equal(secondControl.registrations[0]?.request.runtimeInstanceId, freshRuntimeInstanceId);
    assert.equal(secondControl.registrations[0]?.replacementProof, GENERATION_PROOF);
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      runtimeGenerationProof: string;
      identity: { runtimeInstanceId: string };
    };
    assert.equal(stored.runtimeGenerationProof, secondControl.generationProof);
    assert.equal(stored.identity.runtimeInstanceId, freshRuntimeInstanceId);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await second.close();
  }
});

test("mints distinct process-generation IDs for normal service restarts", () => {
  const first = createManagerRuntimeInstanceId();
  const second = createManagerRuntimeInstanceId();
  assert.match(first, /^runtime-[0-9a-f-]{36}$/u);
  assert.notEqual(first, second);
});

test("rejects a pre-existing state capability file with loose permissions", async () => {
  const root = await tempRoot();
  const path = join(root, "state", "manager.json");
  const runtime = await makeRuntime(root, new FakeControl(), new FakeReviews(), new SequenceInspector([]));
  await runtime.start();
  await runtime.close();
  await chmod(path, 0o644);
  await assert.rejects(
    makeRuntime(root, new FakeControl(), new FakeReviews(), new SequenceInspector([])),
    /private bounded process-owned file/u,
  );
});

test("rejects symlinked state and non-private state directories before reading", async () => {
  const symlinkRoot = await tempRoot();
  const symlinkDirectory = join(symlinkRoot, "state");
  await mkdir(symlinkDirectory, { mode: 0o700 });
  const target = join(symlinkRoot, "target.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, join(symlinkDirectory, "manager.json"));
  await assert.rejects(
    makeRuntime(symlinkRoot, new FakeControl(), new FakeReviews(), new SequenceInspector([])),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP",
  );

  const publicRoot = await tempRoot();
  const publicDirectory = join(publicRoot, "state");
  await mkdir(publicDirectory, { mode: 0o700 });
  await chmod(publicDirectory, 0o755);
  await assert.rejects(
    makeRuntime(publicRoot, new FakeControl(), new FakeReviews(), new SequenceInspector([])),
    /private process-owned directory/u,
  );
});

test("drops already accepted outbox events before rebasing a replacement epoch", async () => {
  const root = await tempRoot();
  const first = await makeRuntime(root, new FakeControl(), new FakeReviews(), new SequenceInspector([]));
  await first.start();
  await assign(first);
  await first.workOnce();
  assert.equal(first.snapshot.pendingEvents, 4);
  await first.close();

  const replacementControl = new FakeControl();
  replacementControl.lastAcceptedLocalSequence = 2;
  const replacement = await makeRuntime(
    root,
    replacementControl,
    new FakeReviews(),
    new SequenceInspector([]),
    { runtimeInstanceId: "manager-process-rebased" },
  );
  try {
    await replacement.start();
    assert.equal(replacement.snapshot.pendingEvents, 2);
    await replacement.flushEvents();
    assert.deepEqual(replacementControl.uploaded.map((event) => event.localSequence), [3, 4]);
    assert.ok(replacementControl.uploaded.every((event) => event.runtimeEpoch === 2));
    assert.ok(replacementControl.uploaded.every((event) => event.runtimeInstanceId === "manager-process-rebased"));
  } finally {
    await replacement.close();
  }
});

test("review idempotency hashes the full immutable evidence binding", async () => {
  async function keyFor(manifestDigest: Sha256Digest): Promise<string> {
    const root = await tempRoot();
    const reviews = new FakeReviews();
    reviews.queue = [evidence({ releaseManifestDigest: manifestDigest })];
    const runtime = await makeRuntime(
      root,
      new FakeControl(),
      reviews,
      new SequenceInspector([inspection("accepted", { releaseManifestDigest: manifestDigest })]),
    );
    try {
      await runtime.start();
      await assign(runtime);
      await completeOnePass(runtime);
      return reviews.calls[0]?.idempotencyKey ?? "";
    } finally {
      await runtime.close();
    }
  }

  const first = await keyFor(MANIFEST_DIGEST as Sha256Digest);
  const second = await keyFor(`sha256:${"f".repeat(64)}` as Sha256Digest);
  assert.match(first, /^manager-review:[a-f0-9]{64}$/u);
  assert.ok(first.length <= 128);
  assert.notEqual(first, second);
});
