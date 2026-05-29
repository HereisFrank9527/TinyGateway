import assert from "node:assert/strict";
import test from "node:test";
import { renderConfirmationEntries } from "../src/admin-ui/confirmation-render.js";

test("confirmation renderer shows pending review details and actions", () => {
  const html = renderConfirmationEntries([
    {
      id: "conf_123",
      requestId: "req_1",
      endpoint: "/v1/chat/completions",
      provider: "openai-main",
      model: "fast",
      upstreamModel: "gpt-fast",
      status: "pending",
      direction: "outbound",
      createdAt: "2026-05-27T10:00:00.000Z",
      review: {
        risk: "high",
        action: "confirm",
        categories: ["dangerous_shell"],
        reason: "needs approval",
        suggestedUserPrompt: "Approve this response?"
      },
      requestSummary: {
        rawText: '{"messages":[{"content":"delete files"}]}'
      },
      responseSummary: {
        rawText: "assistant suggests a command"
      }
    }
  ]);

  assert.match(html, /conf_123/);
  assert.match(html, /pending/);
  assert.match(html, /outbound/);
  assert.match(html, /high \/ confirm/);
  assert.match(html, /dangerous_shell/);
  assert.match(html, /needs approval/);
  assert.match(html, /Approve this response\?/);
  assert.match(html, /delete files/);
  assert.match(html, /assistant suggests a command/);
  assert.match(html, /data-confirmation-allow="conf_123"/);
  assert.match(html, /data-confirmation-block="conf_123"/);
});

test("confirmation renderer hides actions for resolved entries", () => {
  const html = renderConfirmationEntries([
    {
      id: "conf_456",
      status: "allowed",
      review: { risk: "medium", action: "confirm", categories: [], reason: "already approved" },
      responseSummary: { rawText: "approved response" }
    }
  ]);

  assert.match(html, /conf_456/);
  assert.match(html, /allowed/);
  assert.doesNotMatch(html, /data-confirmation-allow/);
  assert.doesNotMatch(html, /data-confirmation-block/);
});

test("confirmation renderer escapes untrusted text", () => {
  const html = renderConfirmationEntries([
    {
      id: "conf_<script>",
      status: "pending",
      review: { risk: "high", action: "confirm", categories: ["unknown"], reason: "<img src=x>" },
      responseSummary: { rawText: "<script>alert(1)</script>" }
    }
  ]);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
});
