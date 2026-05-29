import assert from "node:assert/strict";
import test from "node:test";
import { getAuditSummary, getRiskClass, renderAuditEntries } from "../src/admin-ui/audit-render.js";

test("audit summary highlights reviewer result", () => {
  const entry = {
    event: "review_result",
    review: {
      risk: "high",
      action: "block",
      categories: ["dangerous_shell"],
      reason: "Dangerous shell command."
    }
  };

  assert.equal(getRiskClass(entry), "risk-high");
  assert.equal(getAuditSummary(entry), "high / block / dangerous_shell");
});

test("audit summary handles reviewer errors", () => {
  assert.equal(getRiskClass({ event: "review_error", message: "timeout" }), "");
  assert.equal(getAuditSummary({ event: "review_error", message: "timeout" }), "review_error / timeout");
});

test("renderAuditEntries renders reviewer reason and evidence", () => {
  const html = renderAuditEntries([
    {
      ts: "2026-01-01T00:00:00.000Z",
      event: "review_result",
      endpoint: "/v1/messages",
      provider: "local",
      model: "sonnet",
      review: {
        risk: "critical",
        action: "block",
        categories: ["secret_exposure"],
        reason: "Secret is exposed.",
        evidence: ["API key in output"]
      }
    }
  ]);

  assert.match(html, /risk-critical/);
  assert.match(html, /critical \/ block \/ secret_exposure/);
  assert.match(html, /Secret is exposed\./);
  assert.match(html, /API key in output/);
});

test("audit summary highlights guard decisions", () => {
  const entry = {
    event: "review_decision",
    decision: { outcome: "block", reason: "reviewer_block", statusCode: 403 },
    review: { risk: "critical", action: "block", categories: ["dangerous_shell"], reason: "danger" }
  };

  assert.equal(getRiskClass(entry), "risk-critical");
  assert.equal(getAuditSummary(entry), "guard block / reviewer_block / critical / block / dangerous_shell");
});

test("renderAuditEntries renders guard decision details", () => {
  const html = renderAuditEntries([
    {
      ts: "2026-01-01T00:00:00.000Z",
      event: "review_decision",
      endpoint: "/v1/chat/completions",
      provider: "local",
      model: "fast",
      decision: { outcome: "block", reason: "reviewer_block", statusCode: 403 },
      review: {
        risk: "critical",
        action: "block",
        categories: ["dangerous_shell"],
        reason: "Dangerous shell command.",
        evidence: ["rm -rf"]
      }
    }
  ]);

  assert.match(html, /guard block \/ reviewer_block/);
  assert.match(html, /决策:<\/strong> block/);
  assert.match(html, /rm -rf/);
});
