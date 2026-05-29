import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewResult, normalizeReviewResult, extractJsonObject } from "../src/review/schema.js";

test("extractJsonObject parses fenced reviewer JSON", () => {
  const text = "```json\n{\"risk\":\"low\",\"action\":\"allow\",\"reason\":\"ok\"}\n```";
  assert.deepEqual(extractJsonObject(text), {
    risk: "low",
    action: "allow",
    reason: "ok"
  });
});

test("normalizeReviewResult fills safe defaults", () => {
  const result = normalizeReviewResult({
    risk: "medium",
    action: "confirm",
    confidence: 0.7,
    categories: ["dangerous_shell"],
    reason: "Command may be destructive."
  });

  assert.equal(result.risk, "medium");
  assert.equal(result.action, "confirm");
  assert.equal(result.confidence, 0.7);
  assert.deepEqual(result.categories, ["dangerous_shell"]);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.requiresUserApproval, true);
  assert.equal(result.suggestedUserPrompt, "");
});

test("normalizeReviewResult preserves redact suggestions", () => {
  const result = normalizeReviewResult({
    risk: "high",
    action: "redact",
    confidence: 0.9,
    categories: ["secret_exposure"],
    reason: "secret in response",
    redactions: [
      { text: "sk-live-123", replacement: "[REDACTED_KEY]" },
      { path: "$.choices[0].message.content", text: "token", replacement: "[REDACTED]" },
      { text: "", replacement: "ignored" },
      { text: "missing replacement" }
    ]
  });

  assert.deepEqual(result.redactions, [
    { text: "sk-live-123", replacement: "[REDACTED_KEY]" },
    { path: "$.choices[0].message.content", text: "token", replacement: "[REDACTED]" },
    { text: "missing replacement", replacement: "[REDACTED]" }
  ]);
});

test("parseReviewResult rejects invalid risk", () => {
  assert.throws(
    () => parseReviewResult('{"risk":"severe","action":"allow","reason":"bad"}'),
    /Invalid review risk/
  );
});

test("parseReviewResult rejects invalid action", () => {
  assert.throws(
    () => parseReviewResult('{"risk":"low","action":"delete","reason":"bad"}'),
    /Invalid review action/
  );
});

test("parseReviewResult rejects invalid category", () => {
  assert.throws(
    () => parseReviewResult('{"risk":"low","action":"allow","categories":["made_up"],"reason":"bad"}'),
    /Invalid review category/
  );
});
