import assert from "node:assert/strict";
import test from "node:test";
import { redactForPersistence } from "../../../src/server/shared/redact.js";

const cases = [
  {
    name: "PEM private-key blocks",
    input: "before -----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY----- after",
    expected: "before [redacted:pem] after",
  },
  {
    name: "truncated PEM private-key blocks",
    input: "before -----BEGIN PRIVATE KEY-----\nprivate-material\nstill-private",
    expected: "before [redacted:pem]",
  },
  {
    name: "Bearer credentials",
    input: "Authorization: Bearer abc123._~+/=-",
    expected: "Authorization: [redacted:bearer]",
  },
  ...[
    "sk-secret",
    "sk-ant-secret",
    "sk-proj-secret",
    "sk_secret",
    "github_pat_secret",
    "ghp_secret",
    "gho_secret",
    "ghu_secret",
    "ghs_secret",
    "ghr_secret",
    "glpat-secret",
    "npm_secret",
    "xoxa-secret",
    "xoxz-secret",
    "xox_secret",
    "AKIA1234567890ABCDEF",
  ].map((secret) => ({
    name: `${secret.split(/[0-9]/u, 1)[0]} token`,
    input: `credential=${secret}`,
    expected: "credential=[redacted:token]",
  })),
  {
    name: "URL credentials",
    input: "Fetch https://build-user:pass1234@example.com/private",
    expected: "Fetch [redacted:url-credential]example.com/private",
  },
] as const;

for (const { name, input, expected } of cases) {
  test(`redacts ${name} with a typed persistence marker`, () => {
    assert.equal(redactForPersistence(input), expected);
  });
}

test("strips control characters without adding a marker", () => {
  assert.equal(redactForPersistence("safe\u0000\u001f\u007ftext"), "safetext");
});

test("strips control characters before recognizing credentials", () => {
  assert.equal(redactForPersistence("credential=sk-ant-\u0000secret"), "credential=[redacted:token]");
});

test("leaves ordinary prose and the standalone word token unchanged", () => {
  const prose = "The token budget is ordinary prose, with punctuation and spaces.";
  assert.equal(redactForPersistence(prose), prose);
});

test("applies an optional maximum length after redaction", () => {
  assert.equal(redactForPersistence("sk-ant-secret trailing text", 18), "[redacted:token] t");
});

test("never truncates inside a redaction marker", () => {
  const redacted = redactForPersistence("123456789 sk-ant-secret trailing text", 20);
  assert.equal(redacted, "1234[redacted:token]");
  assert.doesNotMatch(redacted, /\[redacted(?::[^\]]*)?$/u);
});
