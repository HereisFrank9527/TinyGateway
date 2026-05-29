import assert from "node:assert/strict";
import test from "node:test";
import { chatResponseToResponses, previousMessagesFor, rememberResponse, responsesRequestToChat } from "../src/responses.js";

test("responsesRequestToChat converts string input and instructions", () => {
  const chat = responsesRequestToChat({
    model: "fast",
    instructions: "You are concise.",
    input: "hello",
    max_output_tokens: 100,
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }
    ],
    tinygateway: { attackSimulation: { scenario: "prompt_injection" } }
  });

  assert.equal(chat.model, "fast");
  assert.deepEqual(chat.messages, [
    { role: "system", content: "You are concise." },
    { role: "user", content: "hello" }
  ]);
  assert.equal(chat.max_tokens, 100);
  assert.equal(chat.tools[0].function.name, "read_file");
  assert.equal(chat.tinygateway.attackSimulation.scenario, "prompt_injection");
});

test("responsesRequestToChat converts message array input", () => {
  const chat = responsesRequestToChat({
    model: "fast",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "first" },
          { type: "input_text", text: "second" }
        ]
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: { ok: true }
      }
    ]
  });

  assert.deepEqual(chat.messages, [
    { role: "user", content: "first\nsecond" },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" }
  ]);
});

test("chatResponseToResponses wraps assistant text", () => {
  const response = chatResponseToResponses({
    request: { model: "fast" },
    responseId: "resp_test",
    createdAt: 123,
    body: {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }
  });

  assert.equal(response.id, "resp_test");
  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "hello");
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[0].content[0].text, "hello");
  assert.deepEqual(response.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
});

test("response store carries previous response messages", () => {
  const store = new Map();
  const responseBody = chatResponseToResponses({
    request: { model: "fast" },
    responseId: "resp_prev",
    body: { choices: [{ message: { content: "previous answer" } }] }
  });

  rememberResponse(store, "resp_prev", [{ role: "user", content: "previous question" }], responseBody);
  const chat = responsesRequestToChat({ model: "fast", input: "next" }, previousMessagesFor(store, "resp_prev"));

  assert.deepEqual(chat.messages, [
    { role: "user", content: "previous question" },
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "next" }
  ]);
});
