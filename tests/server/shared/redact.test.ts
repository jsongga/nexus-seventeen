import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_PATTERNS,
  CREDENTIAL_REJECTION_PATTERNS,
  redactForPersistence,
} from "../../../src/server/shared/redact.js";

const CREDENTIAL_SHAPES = ["privateKey", "urlCredential", "bearer", "prefixedToken", "awsAccessKey"] as const;

test("credential patterns are exported as one immutable named set", () => {
  assert.deepEqual(Object.keys(CREDENTIAL_PATTERNS), [...CREDENTIAL_SHAPES]);
  assert.equal(Object.isFrozen(CREDENTIAL_PATTERNS), true);
});

test("the rejection set covers the same shapes and narrows only where documented", () => {
  assert.deepEqual(Object.keys(CREDENTIAL_REJECTION_PATTERNS), [...CREDENTIAL_SHAPES]);
  assert.equal(Object.isFrozen(CREDENTIAL_REJECTION_PATTERNS), true);

  // Only `bearer` and `prefixedToken` are allowed to differ. Every other shape
  // is the redaction pattern with `g` removed, so a change to the PEM, URL or
  // AWS vocabulary cannot reach one policy and miss the other.
  const narrowed: readonly string[] = ["bearer", "prefixedToken"];
  for (const shape of CREDENTIAL_SHAPES) {
    const rejection = CREDENTIAL_REJECTION_PATTERNS[shape];
    // Rejection is `test`-only. A global pattern would carry `lastIndex` from
    // one call into the next and start matching mid-string.
    assert.equal(rejection.global, false, `${shape} must not be global`);
    const redaction = CREDENTIAL_PATTERNS[shape];
    if (narrowed.includes(shape)) assert.notEqual(rejection.source, redaction.source, `${shape} carries a narrowing`);
    else assert.equal(rejection.source, redaction.source, `${shape} must reuse the redaction shape`);
  }
});

test("the bearer rule rejects on a digit, so prose and identifiers survive", () => {
  const matches = (pattern: RegExp, value: string) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value);
  const rejects = (value: string) => matches(CREDENTIAL_REJECTION_PATTERNS.bearer, value);

  for (const prose of [
    "Bearer authentication",
    // Every one of these was rejected by a "contains a non-letter" rule: the
    // token character class holds `.` `-` `/` `_`, so ordinary punctuation
    // satisfied it. This is the regression the digit rule exists to prevent.
    "Bearer authentication.",
    "Bearer credentials.",
    "Bearer authentication-related",
    "Bearer authentication/authorization",
    "Bearer authentication.md",
    "Bearer authorization_header_name",
    // And these were rejected by a 24-character safety net, which cannot tell a
    // long token from a long class name.
    "Bearer AuthenticationMiddleware",
    "Bearer JwtBearerAuthenticationHandler",
  ]) {
    assert.equal(rejects(prose), false, `${prose} must reach the agent`);
    // Redaction still covers everything rejection lets through, so none of this
    // can be persisted even though it can be sent.
    assert.equal(matches(CREDENTIAL_PATTERNS.bearer, prose), true, `${prose} must still redact`);
  }

  for (const [name, credential] of [
    ["JWT", "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2ln"],
    ["hex", "Bearer 0123456789abcdef0123456789abcdef"],
    ["Google", "Bearer ya29.a0AfH6SMBx7kQ2mN"],
    ["base64 HMAC", "Bearer AQIC5wM2LY4Sfcy+RmoNbW9uZA=="],
  ] as const) {
    assert.equal(rejects(credential), true, `${name} must be rejected`);
  }

  // The two gaps, asserted so they stay decisions: an all-letter token of any
  // length passes, and an identifier carrying a digit does not.
  assert.equal(rejects("Bearer QwertyUiopAsdfghJklZxcvbnm"), false);
  assert.equal(rejects("Bearer OAuth2Middleware"), true);
});

test("rejection narrows exactly three axes, and redaction still covers all of them", () => {
  // Tested through non-global clones so these assertions cannot leave
  // `lastIndex` behind on a pattern the redaction path shares.
  const matches = (pattern: RegExp, value: string) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value);

  const narrowings = [
    // A length floor: prose is short after the marker word, a real token is not.
    ["bearer floor", "bearer", "Bearer abc._~+/="],
    ["prefixed-token floor", "prefixedToken", "sk-ant-key"],
    // A character class: with `~ + /` a path clears any floor by crossing `/`.
    ["path punctuation", "prefixedToken", "packages/sk-utils/index.ts"],
    // Weak prefixes: `sk_`/`xox_` with no vendor infix is ordinary snake_case.
    ["weak sk_ prefix", "prefixedToken", "sk_buff_alloc"],
    ["weak xox_ prefix", "prefixedToken", "xox_handler_state"],
  ] as const;

  for (const [name, shape, value] of narrowings) {
    assert.equal(matches(CREDENTIAL_PATTERNS[shape], value), true, `${name}: redaction must still cover it`);
    assert.equal(matches(CREDENTIAL_REJECTION_PATTERNS[shape], value), false, `${name}: rejection must let it pass`);
  }

  // The narrowings must not open a hole: the vendor forms of the same shapes
  // stay rejected.
  for (const [name, credential] of [
    ["Stripe", "sk_live_51H8examplekey0123"],
    ["Slack", "xoxb-1234-5678-abcdefghijkl"],
    ["GitHub", "ghp_abcdefghijklmnop"],
  ] as const) {
    assert.equal(
      matches(CREDENTIAL_REJECTION_PATTERNS.prefixedToken, credential),
      true,
      `${name} keys must stay rejected`
    );
  }
});

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
