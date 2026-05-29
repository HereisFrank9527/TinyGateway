import assert from "node:assert/strict";
import test from "node:test";
import { applyRedactions } from "../src/review/redact.js";

test("applyRedactions replaces exact text in OpenAI assistant content", () => {
  const upstream = {
    status: 200,
    headers: { "content-type": "application/json" },
    isJson: true,
    body: {
      id: "chatcmpl_1",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Here is the key: sk-live-123. Do not share sk-live-123."
          }
        }
      ]
    },
    rawText: '{"choices":[{"message":{"content":"Here is the key: sk-live-123. Do not share sk-live-123."}}]}'
  };

  const redacted = applyRedactions(upstream, {
    redactions: [{ text: "sk-live-123", replacement: "[REDACTED_KEY]" }]
  });

  assert.notEqual(redacted, upstream);
  assert.equal(redacted.isJson, true);
  assert.equal(redacted.status, 200);
  assert.equal(redacted.body.choices[0].message.content, "Here is the key: [REDACTED_KEY]. Do not share [REDACTED_KEY].");
  assert.equal(redacted.rawText.includes("sk-live-123"), false);
  assert.equal(redacted.rawText.includes("[REDACTED_KEY]"), true);
  assert.equal(upstream.body.choices[0].message.content.includes("sk-live-123"), true);
});

test("applyRedactions reports unchanged when suggestions are missing", () => {
  const upstream = {
    status: 200,
    headers: { "content-type": "application/json" },
    isJson: true,
    body: { content: [{ type: "text", text: "safe" }] },
    rawText: '{"content":[{"type":"text","text":"safe"}]}'
  };

  const redacted = applyRedactions(upstream, { redactions: [] });

  assert.deepEqual(redacted, upstream);
});
