import assert from "node:assert/strict";
import test from "node:test";
import { callReviewerProvider } from "../src/review/reviewer.js";

const REVIEW_JSON = {
  risk: "low",
  action: "allow",
  confidence: 1,
  categories: [],
  reason: "ok",
  evidence: [],
  requiresUserApproval: false,
  suggestedUserPrompt: ""
};

test("OpenAI reviewer calls include internal reviewer header", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(REVIEW_JSON) } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const output = await callReviewerProvider({
      provider: { id: "reviewer", type: "openai", baseUrl: "https://reviewer.test", apiKey: "secret" },
      model: "reviewer-model",
      messages: [{ role: "user", content: "review" }]
    });
    assert.equal(JSON.parse(output).action, "allow");
    assert.equal(calls[0].init.headers["x-tinygateway-reviewer"], "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic reviewer calls include internal reviewer header", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(REVIEW_JSON) }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const output = await callReviewerProvider({
      provider: { id: "reviewer", type: "anthropic", baseUrl: "https://reviewer.test", apiKey: "secret" },
      model: "reviewer-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "review" }
      ]
    });
    assert.equal(JSON.parse(output).action, "allow");
    assert.equal(calls[0].init.headers["x-tinygateway-reviewer"], "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
