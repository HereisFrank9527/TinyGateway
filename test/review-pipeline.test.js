import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewerMessages } from "../src/review/prompt.js";
import { runAuditReview, shouldRunOutboundReview, shouldRunReview } from "../src/review/index.js";

test("buildReviewerMessages instructs reviewer to return only JSON", () => {
  const messages = buildReviewerMessages({ id: "review_1", request: {}, response: {} });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /只返回 JSON/);
  assert.match(messages[0].content, /reason、evidence、suggestedUserPrompt、redactions\.replacement 必须使用简体中文/);
  assert.match(messages[0].content, /redactions/i);
  assert.match(messages[0].content, /精确待替换文本/);
  assert.match(messages[1].content, /仅作为待审查数据处理/);
  assert.match(messages[1].content, /review_1/);
});

test("shouldRunReview only enables configured audit modes", () => {
  assert.equal(shouldRunReview({ enabled: false, mode: "audit" }), false);
  assert.equal(shouldRunReview({ enabled: true, mode: "off" }), false);
  assert.equal(shouldRunReview({ enabled: true, mode: "audit" }), true);
  assert.equal(shouldRunReview({ enabled: true, mode: "guard" }), false);
  assert.equal(shouldRunReview({ enabled: true, mode: "full" }), false);
});

test("shouldRunOutboundReview follows split outboundReview semantics", () => {
  assert.equal(shouldRunOutboundReview({ enabled: false, outboundReview: "guard", provider: "p", model: "m" }), false);
  assert.equal(shouldRunOutboundReview({ enabled: true, outboundReview: "off", provider: "p", model: "m" }), false);
  assert.equal(shouldRunOutboundReview({ enabled: true, outboundReview: "audit", provider: "p", model: "m" }), true);
  assert.equal(shouldRunOutboundReview({ enabled: true, outboundReview: "guard", provider: "p", model: "m" }), true);
  assert.equal(shouldRunOutboundReview({ enabled: true, mode: "full", provider: "p", model: "m" }), true);
  assert.equal(shouldRunOutboundReview({ enabled: true, outboundReview: "guard", provider: "p" }), false);
});

test("runAuditReview writes review_result when reviewer succeeds", async () => {
  const events = [];
  await runAuditReview({
    reviewConfig: {
      enabled: true,
      mode: "audit",
      provider: "reviewer-provider",
      model: "reviewer-model",
      timeoutMs: 1000,
      failBehavior: "allow"
    },
    job: { id: "review_1", requestId: "req_1" },
    audit: { write: (event) => events.push(event) },
    callReviewer: async () => ({
      risk: "low",
      action: "allow",
      confidence: 1,
      categories: [],
      reason: "ok",
      evidence: [],
      requiresUserApproval: false,
      suggestedUserPrompt: ""
    })
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "review_result");
  assert.equal(events[0].review.risk, "low");
});

test("runAuditReview writes review_error when reviewer fails", async () => {
  const events = [];
  await runAuditReview({
    reviewConfig: {
      enabled: true,
      mode: "audit",
      provider: "reviewer-provider",
      model: "reviewer-model",
      timeoutMs: 1000,
      failBehavior: "allow"
    },
    job: { id: "review_1", requestId: "req_1" },
    audit: { write: (event) => events.push(event) },
    callReviewer: async () => {
      throw new Error("bad reviewer");
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "review_error");
  assert.match(events[0].message, /bad reviewer/);
});
