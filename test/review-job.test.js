import assert from "node:assert/strict";
import test from "node:test";
import { buildInboundReviewJob, buildOutboundReviewJob, detectClientProtocol, extractRequestForReview, extractResponseForReview } from "../src/review/job.js";

test("detectClientProtocol maps known endpoints", () => {
  assert.equal(detectClientProtocol("/v1/messages"), "anthropic");
  assert.equal(detectClientProtocol("/v1/chat/completions"), "openai");
  assert.equal(detectClientProtocol("/other"), "unknown");
});

test("extractRequestForReview keeps useful fields but removes secrets", () => {
  const request = extractRequestForReview({
    model: "sonnet",
    system: "system text",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
    apiKey: "secret",
    authorization: "Bearer secret"
  });

  assert.deepEqual(request, {
    model: "sonnet",
    system: "system text",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read_file", input_schema: { type: "object" } }]
  });
});

test("extractResponseForReview extracts OpenAI message content and tool calls", () => {
  const response = extractResponseForReview({
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "hello",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }]
          }
        }
      ]
    },
    rawText: "raw response"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.content, [{ type: "text", text: "hello" }]);
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.rawText, "raw response");
});

test("buildInboundReviewJob creates safe unified job", () => {
  const job = buildInboundReviewJob({
    requestId: "req_1",
    mode: "audit",
    endpoint: "/v1/messages",
    provider: {
      id: "deepseek",
      type: "openai",
      apiKey: "secret",
      baseUrl: "https://api.deepseek.com"
    },
    model: {
      id: "sonnet",
      upstreamId: "deepseek-chat"
    },
    requestBody: {
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }]
    },
    upstream: {
      status: 200,
      body: { content: [{ type: "text", text: "ok" }] },
      rawText: "ok"
    }
  });

  assert.equal(job.requestId, "req_1");
  assert.equal(job.direction, "inbound");
  assert.equal(job.clientProtocol, "anthropic");
  assert.equal(job.provider, "deepseek");
  assert.equal(job.providerProtocol, "openai");
  assert.equal(job.localModel, "sonnet");
  assert.equal(job.upstreamModel, "deepseek-chat");
  assert.equal(JSON.stringify(job).includes("secret"), false);
});

test("buildInboundReviewJob carries stream capture metadata", () => {
  const job = buildInboundReviewJob({
    requestId: "req_stream",
    mode: "audit",
    endpoint: "/v1/chat/completions",
    provider: { id: "openai-main", type: "openai" },
    model: { id: "fast", upstreamId: "gpt-fast" },
    requestBody: { model: "fast", stream: true, messages: [] },
    upstream: {
      status: 200,
      isStream: true,
      rawText: "data: hello\n\n",
      reviewMetadata: {
        source: "stream_buffer",
        truncated: true,
        capturedBytes: 16
      }
    }
  });

  assert.equal(job.stream, true);
  assert.deepEqual(job.metadata.streamCapture, {
    source: "stream_buffer",
    truncated: true,
    capturedBytes: 16
  });
  assert.equal(job.metadata.truncated, true);
  assert.equal(job.response.rawText, "data: hello\n\n");
});

test("buildInboundReviewJob omits request body in response context", () => {
  const job = buildInboundReviewJob({
    requestId: "req_response_context",
    mode: "guard",
    context: "response",
    endpoint: "/v1/chat/completions",
    provider: { id: "openai-main", type: "openai" },
    model: { id: "fast", upstreamId: "gpt-fast" },
    requestBody: { model: "fast", messages: [{ role: "user", content: "private input" }] },
    upstream: { status: 200, body: { choices: [{ message: { content: "safe response" } }] }, rawText: "safe response" }
  });

  assert.equal(job.context, "response");
  assert.equal(job.request, undefined);
  assert.equal(job.response.content[0].text, "safe response");
});

test("buildInboundReviewJob includes request body in full context", () => {
  const job = buildInboundReviewJob({
    requestId: "req_full_context",
    mode: "guard",
    context: "full",
    endpoint: "/v1/chat/completions",
    provider: { id: "openai-main", type: "openai" },
    model: { id: "fast", upstreamId: "gpt-fast" },
    requestBody: { model: "fast", messages: [{ role: "user", content: "important input" }] },
    upstream: { status: 200, body: { choices: [{ message: { content: "safe response" } }] }, rawText: "safe response" }
  });

  assert.equal(job.context, "full");
  assert.equal(job.request.messages[0].content, "important input");
  assert.equal(job.response.content[0].text, "safe response");
});

test("buildOutboundReviewJob creates safe outbound job without response", () => {
  const job = buildOutboundReviewJob({
    requestId: "req_out",
    mode: "guard",
    context: "full",
    endpoint: "/v1/chat/completions",
    provider: {
      id: "openai-main",
      type: "openai",
      apiKey: "secret",
      baseUrl: "https://api.openai.test"
    },
    model: {
      id: "fast",
      upstreamId: "gpt-fast"
    },
    requestBody: {
      model: "fast",
      messages: [{ role: "user", content: "run a shell command" }],
      apiKey: "request-secret"
    }
  });

  assert.equal(job.requestId, "req_out");
  assert.equal(job.direction, "outbound");
  assert.equal(job.mode, "guard");
  assert.equal(job.context, "full");
  assert.equal(job.clientProtocol, "openai");
  assert.equal(job.provider, "openai-main");
  assert.equal(job.localModel, "fast");
  assert.equal(job.upstreamModel, "gpt-fast");
  assert.equal(job.response, undefined);
  assert.equal(JSON.stringify(job).includes("secret"), false);
});
