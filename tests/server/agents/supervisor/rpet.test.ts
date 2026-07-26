import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeProviderAdapter, type ProviderAdapter } from "#server/agents/supervisor/provider";
import { RpetRunner } from "#server/agents/supervisor/rpet";
import { taskFixture } from "./helpers.js";

test("engineer RPET returns to research after a failed test and loops until passing", async () => {
  const provider = new FakeProviderAdapter({ testOutcomes: ["failed", "passed"] });
  const runner = new RpetRunner(taskFixture(), { role: "engineer" });
  const controller = new AbortController();
  const firstIteration = [];

  for (let step = 0; step < 4; step += 1) {
    firstIteration.push(await runner.step(provider, controller.signal));
  }
  assert.deepEqual(provider.calls.map((call) => `${call.iteration}:${call.phase}`), [
    "1:research",
    "1:plan",
    "1:execute",
    "1:test",
  ]);
  assert.equal(firstIteration[3]!.completed, false);
  assert.equal(firstIteration[3]!.progress.type, "progress");
  assert.deepEqual(runner.state, {
    task: taskFixture(),
    iteration: 2,
    phase: "research",
  });

  let finalResult = firstIteration[3]!;
  for (let step = 0; step < 4; step += 1) {
    finalResult = await runner.step(provider, controller.signal);
  }
  assert.equal(finalResult.completed, true);
  assert.match(finalResult.resultOverview ?? "", /passing checks/i);
  assert.equal(runner.completed, true);
  assert.deepEqual(provider.calls.slice(4).map((call) => `${call.iteration}:${call.phase}`), [
    "2:research",
    "2:plan",
    "2:execute",
    "2:test",
  ]);
});

test("provider actions, journals, and result overviews containing credentials are rejected before progress", async () => {
  const cases = [
    {
      phase: "research" as const,
      action: "Using api_key=secret-value-12345",
      journal: "Safe journal.",
    },
    {
      phase: "research" as const,
      action: "Safe action.",
      journal: "Authorization Bearer abcdefghijklmnop",
    },
    {
      phase: "test" as const,
      action: "Safe action.",
      journal: "Checks passed safely.",
      testOutcome: "passed" as const,
      resultOverview: "credential=secret-value-12345",
    },
  ];
  for (const fixture of cases) {
    const provider: ProviderAdapter = {
      providerName: "codex",
      model: "secret-fixture",
      async executeStep(input) {
        await input.reportCurrentAction(fixture.action);
        return {
          journal: fixture.journal,
          ...(fixture.testOutcome ? { testOutcome: fixture.testOutcome } : {}),
          ...(fixture.resultOverview ? { resultOverview: fixture.resultOverview } : {}),
        };
      },
      async settleInterrupt() {},
      async shutdown() {},
    };
    const runner = new RpetRunner(taskFixture(), {
      role: "engineer",
      initialPhase: fixture.phase,
    });
    await assert.rejects(
      runner.step(provider, new AbortController().signal),
      /credentials or secrets/i,
    );
  }
});
