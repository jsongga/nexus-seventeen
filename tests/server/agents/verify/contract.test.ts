import assert from "node:assert/strict";
import test from "node:test";
import { loadVerifyContract, parseVerifyContract, VerifyContractError } from "#server/agents/verify";

test("parses the real repo contract from docs/workflow.md", async () => {
  const contract = await loadVerifyContract(process.cwd());
  assert.equal(contract.version, 1);
  assert.deepEqual(contract.compile, ["npm run build:runtime:fast", "npm run build:tests:fast"]);
  assert.deepEqual(contract.full, ["npm run typecheck:all", "npm run test:all", "npm run test:container"]);
  assert.equal(contract.rules[0]?.match, "tests/container/**");
  assert.equal(contract.rules[0]?.action.kind, "escalate");
  assert.ok(contract.rules.length >= 10);
});

test("rejects malformed contracts closed-world", () => {
  const wrap = (json: string) => "# t\n\n```json\n" + json + "\n```\n";
  assert.throws(() => parseVerifyContract("# no block here"), VerifyContractError);
  assert.throws(() => parseVerifyContract(wrap("{}") + wrap("{}")), /multiple fenced json blocks/u);
  assert.throws(() => parseVerifyContract(wrap("not json")), VerifyContractError);
  assert.throws(() => parseVerifyContract(wrap('{"version":2,"compile":["x"],"rules":[{"match":"a","action":{"kind":"none"}}],"full":["y"]}')), /version/u);
  assert.throws(() => parseVerifyContract(wrap('{"version":1,"compile":["x"],"rules":[{"match":"a","action":{"kind":"none"}}],"full":["y"],"extra":1}')), /unknown field/iu);
  assert.throws(() => parseVerifyContract(wrap('{"version":1,"compile":["x"],"rules":[{"match":"a","action":{"kind":"fixed"}}],"full":["y"]}')), /fixed/u);
  assert.throws(() => parseVerifyContract(wrap('{"version":1,"compile":[],"rules":[{"match":"a","action":{"kind":"none"}}],"full":["y"]}')), /compile/u);
});
