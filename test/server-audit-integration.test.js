import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createRequestHandler } from "../src/server.js";
import { ConfirmationQueue } from "../src/confirmations.js";

const REVIEW_ALLOW = {
  risk: "low",
  action: "allow",
  confidence: 1,
  categories: [],
  reason: "ok",
  evidence: [],
  requiresUserApproval: false,
  suggestedUserPrompt: ""
};

const REVIEW_BLOCK = {
  risk: "critical",
  action: "block",
  confidence: 1,
  categories: ["dangerous_shell"],
  reason: "dangerous command",
  evidence: ["rm -rf"],
  requiresUserApproval: true,
  suggestedUserPrompt: ""
};

const REVIEW_CONFIRM = {
  ...REVIEW_BLOCK,
  action: "confirm",
  reason: "needs approval",
  suggestedUserPrompt: "Approve this response?"
};

const REVIEW_REDACT = {
  risk: "high",
  action: "redact",
  confidence: 1,
  categories: ["secret_exposure"],
  reason: "secret should be redacted",
  evidence: ["sk-live-123"],
  requiresUserApproval: false,
  suggestedUserPrompt: "",
  redactions: [{ text: "sk-live-123", replacement: "[REDACTED_KEY]" }]
};

function makeState({ reviewer = {}, attackSimulators = [], attackSimulation = null } = {}) {
  const provider = {
    id: "openai-main",
    type: "openai",
    baseUrl: "https://upstream.test",
    apiKey: "upstream-secret"
  };
  const model = {
    id: "fast",
    upstreamId: "gpt-fast"
  };
  const attackSimulatorEntries = attackSimulators
    .filter((simulator) => simulator.enabled !== false)
    .map((simulator) => [
      simulator.id,
      {
        provider,
        model: {
          id: simulator.id,
          upstreamId: simulator.model,
          attackSimulator: simulator
        }
      }
    ]);
  if (attackSimulation?.enabled) {
    attackSimulatorEntries.push([
      attackSimulation.modelId,
      {
        provider,
        model: {
          id: attackSimulation.modelId,
          upstreamId: attackSimulation.model,
          attackSimulator: attackSimulation
        }
      }
    ]);
  }
  return {
    config: {
      server: { host: "127.0.0.1", port: 0 },
      audit: { enabled: true, directory: "logs" },
      reviewer: {
        enabled: true,
        mode: "audit",
        provider: "openai-main",
        model: "reviewer-model",
        timeoutMs: 1000,
        failBehavior: "allow",
        confirmBehavior: "queue",
        ...reviewer
      },
      providers: [provider],
      modelMappings: [],
      attackSimulation,
      attackSimulators
    },
    modelIndex: new Map([["fast", { provider, model }], ...attackSimulatorEntries]),
    lastError: null
  };
}

function makeRequest({ method = "POST", url = "/v1/chat/completions", headers = {}, body = {} } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      ...headers
    },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    }
  };
}

function makeResponse() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  response.statusCode = 200;
  response.headers = {};
  response.writeHead = (statusCode, headers = {}) => {
    response.statusCode = statusCode;
    response.headers = headers;
    return response;
  };
  response.bodyText = () => Buffer.concat(chunks).toString("utf8");
  response.bodyJson = () => JSON.parse(response.bodyText());
  return response;
}

function createPendingDetector() {
  let resolvePending;
  const pending = new Promise((resolve) => {
    resolvePending = resolve;
  });
  return {
    queue: new ConfirmationQueue(),
    pending,
    audit: {
      write(event) {
        if (event.event === "confirmation_created") {
          resolvePending(event.confirmationId);
        }
      }
    }
  };
}

async function invoke(handler, req) {
  const res = makeResponse();
  await handler(req, res);
  await new Promise((resolve) => {
    if (res.writableEnded) {
      resolve();
    } else {
      res.on("finish", resolve);
    }
  });
  return res;
}

async function invokePending(handler, req) {
  const res = makeResponse();
  const done = (async () => {
    await handler(req, res);
    await new Promise((resolve) => {
      if (res.writableEnded) {
        resolve();
      } else {
        res.on("finish", resolve);
      }
    });
    return res;
  })();
  return { res, done };
}

test("generic attack simulator model accepts allowed client parameters from request body", async () => {
  const events = [];
  const proxiedBodies = [];
  const state = makeState({
    reviewer: { mode: "guard" },
    attackSimulation: {
      enabled: true,
      modelId: "attack-sim",
      displayName: "通用攻击模拟",
      provider: "openai-main",
      model: "gpt-4.1-mini",
      allowClientParams: true,
      defaultScenario: "startup_poisoning",
      allowedScenarios: ["startup_poisoning", "data_exfiltration"],
      defaultIntensity: "low",
      allowedIntensities: ["low", "medium", "high"],
      defaultInsertionStyle: "obvious",
      allowedInsertionStyles: ["obvious", "natural", "hidden"],
      safeMode: "abstract"
    }
  });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async ({ body }) => {
      proxiedBodies.push(body);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "模拟响应：[模拟的数据外传动作]" } }] },
        rawText: '{"choices":[{"message":{"content":"模拟响应：[模拟的数据外传动作]"}}]}',
        isJson: true
      };
    },
    callReviewer: async () => REVIEW_ALLOW
  });

  const response = await invoke(
    handler,
    makeRequest({
      body: {
        model: "attack-sim",
        messages: [{ role: "user", content: "写一段报表导出说明" }],
        tinygateway: {
          attackSimulation: {
            scenario: "data_exfiltration",
            intensity: "high",
            insertionStyle: "hidden"
          }
        }
      }
    })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(proxiedBodies[0].model, "gpt-4.1-mini");
  assert.match(proxiedBodies[0].messages[0].content, /数据外传模拟/);
  assert.match(proxiedBodies[0].messages[0].content, /模拟强度：high/);
  assert.match(proxiedBodies[0].messages[0].content, /插入方式：hidden/);
  assert.equal(events.some((event) => event.event === "attack_simulation" && event.model === "attack-sim" && event.scenario === "data_exfiltration" && event.intensity === "high" && event.insertionStyle === "hidden" && event.clientParameterized === true), true);
});

test("generic attack simulator rejects disallowed client scenario before upstream call", async () => {
  let proxyCalled = false;
  const state = makeState({
    reviewer: { mode: "guard" },
    attackSimulation: {
      enabled: true,
      modelId: "attack-sim",
      provider: "openai-main",
      model: "gpt-4.1-mini",
      allowClientParams: true,
      defaultScenario: "startup_poisoning",
      allowedScenarios: ["startup_poisoning"],
      defaultIntensity: "low",
      allowedIntensities: ["low", "medium"],
      defaultInsertionStyle: "obvious",
      allowedInsertionStyles: ["obvious", "natural"],
      safeMode: "abstract"
    }
  });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => {
      proxyCalled = true;
      return { status: 200, headers: {}, body: {}, rawText: "{}", isJson: true };
    },
    callReviewer: async () => REVIEW_ALLOW
  });

  const response = await invoke(
    handler,
    makeRequest({
      body: {
        model: "attack-sim",
        messages: [{ role: "user", content: "hi" }],
        tinygateway: { attackSimulation: { scenario: "data_exfiltration" } }
      }
    })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.bodyJson().error.type, "bad_request");
  assert.match(response.bodyJson().error.message, /not allowed/);
  assert.equal(proxyCalled, false);
});

test("attack simulator virtual model wraps request with scenario prompt and passes result through reviewer", async () => {
  const events = [];
  const proxiedBodies = [];
  const state = makeState({
    reviewer: { mode: "guard" },
    attackSimulators: [
      {
        id: "attack-sim/startup-poisoning",
        displayName: "启动项投毒模拟",
        enabled: true,
        provider: "openai-main",
        model: "gpt-4.1-mini",
        scenario: "startup_poisoning"
      }
    ]
  });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async ({ body }) => {
      proxiedBodies.push(body);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "模拟响应：[模拟的启动项持久化动作]" } }] },
        rawText: '{"choices":[{"message":{"content":"模拟响应：[模拟的启动项持久化动作]"}}]}',
        isJson: true
      };
    },
    callReviewer: async () => REVIEW_ALLOW
  });

  const response = await invoke(
    handler,
    makeRequest({
      body: {
        model: "attack-sim/startup-poisoning",
        messages: [{ role: "user", content: "写一段安装说明" }]
      }
    })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.bodyJson().choices[0].message.content, "模拟响应：[模拟的启动项持久化动作]");
  assert.equal(proxiedBodies.length, 1);
  assert.equal(proxiedBodies[0].model, "gpt-4.1-mini");
  assert.match(proxiedBodies[0].messages[0].content, /安全测试用的攻击模拟器/);
  assert.match(proxiedBodies[0].messages[0].content, /启动项投毒/);
  assert.match(proxiedBodies[0].messages.at(-1).content, /写一段安装说明/);
  assert.equal(events.some((event) => event.event === "attack_simulation" && event.scenario === "startup_poisoning"), true);
  assert.equal(events.some((event) => event.event === "review_decision" && event.model === "attack-sim/startup-poisoning"), true);
});

test("attack simulator virtual model can be blocked by existing inbound guard", async () => {
  const state = makeState({
    reviewer: { mode: "guard" },
    attackSimulators: [
      {
        id: "attack-sim/startup-poisoning",
        enabled: true,
        provider: "openai-main",
        model: "gpt-4.1-mini",
        scenario: "startup_poisoning"
      }
    ]
  });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "risky simulated response" } }] },
      rawText: '{"choices":[{"message":{"content":"risky simulated response"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_BLOCK
  });

  const response = await invoke(
    handler,
    makeRequest({
      body: {
        model: "attack-sim/startup-poisoning",
        messages: [{ role: "user", content: "写一段安装说明" }]
      }
    })
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.bodyJson().error.type, "review_blocked");
});

test("model handler schedules audit review after non-stream upstream response", async () => {
  const events = [];
  const scheduled = [];
  const state = makeState();
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async ({ body }) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: `model=${body.model}` } }] },
      rawText: '{"ok":true}',
      isJson: true
    }),
    scheduleAuditReview: (payload) => scheduled.push(payload)
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  const responseBody = response.bodyJson();

  assert.equal(response.statusCode, 200);
  assert.equal(responseBody.choices[0].message.content, "model=gpt-fast");
  assert.equal(events.some((event) => event.event === "request"), true);
  assert.equal(events.some((event) => event.event === "response"), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].endpoint, "/v1/chat/completions");
  assert.equal(scheduled[0].target.provider.id, "openai-main");
  assert.equal(scheduled[0].upstream.status, 200);
});

test("responses endpoint converts request to chat completions and wraps response", async () => {
  const events = [];
  const proxiedBodies = [];
  const state = makeState();
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async ({ endpoint, body }) => {
      proxiedBodies.push({ endpoint, body });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          choices: [{ message: { role: "assistant", content: `model=${body.model}; input=${body.messages.at(-1).content}` } }],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
        },
        rawText: '{"ok":true}',
        isJson: true
      };
    },
    scheduleAuditReview: () => {}
  });

  const response = await invoke(
    handler,
    makeRequest({
      url: "/v1/responses",
      body: {
        model: "fast",
        instructions: "system text",
        input: "hello codex",
        max_output_tokens: 100
      }
    })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 200);
  assert.equal(proxiedBodies[0].endpoint, "/v1/chat/completions");
  assert.equal(proxiedBodies[0].body.model, "gpt-fast");
  assert.equal(proxiedBodies[0].body.max_tokens, 100);
  assert.deepEqual(proxiedBodies[0].body.messages, [
    { role: "system", content: "system text" },
    { role: "user", content: "hello codex" }
  ]);
  assert.equal(body.object, "response");
  assert.match(body.id, /^resp_/);
  assert.equal(body.output_text, "model=gpt-fast; input=hello codex");
  assert.equal(body.output[0].type, "message");
  assert.deepEqual(body.usage, { input_tokens: 5, output_tokens: 7, total_tokens: 12 });
  assert.equal(events.some((event) => event.event === "request" && event.endpoint === "/v1/responses"), true);
});

test("responses endpoint supports previous_response_id memory", async () => {
  const proxiedBodies = [];
  const state = makeState();
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async ({ body }) => {
      proxiedBodies.push(body);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: `answer ${proxiedBodies.length}` } }] },
        rawText: '{"ok":true}',
        isJson: true
      };
    },
    scheduleAuditReview: () => {}
  });

  const first = await invoke(handler, makeRequest({ url: "/v1/responses", body: { model: "fast", input: "first" } }));
  const firstId = first.bodyJson().id;
  const second = await invoke(
    handler,
    makeRequest({ url: "/v1/responses", body: { model: "fast", previous_response_id: firstId, input: "second" } })
  );

  assert.equal(second.statusCode, 200);
  assert.deepEqual(proxiedBodies[1].messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "second" }
  ]);
});

test("responses endpoint converts chat completion stream to response SSE", async () => {
  const state = makeState();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      stream,
      isStream: true
    }),
    scheduleAuditReview: () => {}
  });

  const response = await invoke(handler, makeRequest({ url: "/v1/responses", body: { model: "fast", input: "hi", stream: true } }));
  const text = response.bodyText();

  assert.equal(response.statusCode, 200);
  assert.match(text, /event: response.created/);
  assert.match(text, /event: response.output_text.delta/);
  assert.match(text, /"delta":"hel"/);
  assert.match(text, /event: response.completed/);
  assert.match(text, /"output_text":"hello"/);
  assert.match(text, /data: \[DONE\]/);
});

test("model handler skips audit scheduling for internal reviewer requests", async () => {
  const scheduled = [];
  const state = makeState();
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "reviewer response" } }] },
      rawText: '{"ok":true}',
      isJson: true
    }),
    scheduleAuditReview: (payload) => scheduled.push(payload)
  });

  const response = await invoke(
    handler,
    makeRequest({
      headers: { "x-tinygateway-reviewer": "1" },
      body: { model: "fast", messages: [{ role: "user", content: "review this" }] }
    })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(scheduled.length, 0);
});

test("guard mode allows non-stream upstream response when reviewer allows", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard" } });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "safe" } }] },
      rawText: '{"choices":[{"message":{"content":"safe"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_ALLOW
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.bodyJson().choices[0].message.content, "safe");
  assert.equal(events.some((event) => event.event === "review_result"), true);
  assert.equal(events.some((event) => event.event === "review_decision" && event.decision.outcome === "allow"), true);
  assert.equal(events.some((event) => event.event === "review_skipped"), false);
});

test("guard mode blocks non-stream upstream response when reviewer blocks", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard" } });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "run rm -rf" } }] },
      rawText: '{"choices":[{"message":{"content":"run rm -rf"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_BLOCK
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 403);
  assert.equal(body.error.type, "review_blocked");
  assert.match(body.error.message, /dangerous command/);
  assert.equal(events.some((event) => event.event === "response_blocked"), true);
  assert.equal(events.some((event) => event.event === "review_decision" && event.decision.outcome === "block"), true);
});

test("guard mode redacts non-stream upstream response when reviewer suggests redact", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard" } });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "token sk-live-123 is exposed" } }] },
      rawText: '{"choices":[{"message":{"content":"token sk-live-123 is exposed"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_REDACT
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 200);
  assert.equal(body.choices[0].message.content, "token [REDACTED_KEY] is exposed");
  assert.equal(JSON.stringify(body).includes("sk-live-123"), false);
  assert.equal(events.some((event) => event.event === "review_decision" && event.decision.outcome === "redact"), true);
  assert.equal(events.some((event) => event.event === "response_redacted" && event.direction === "inbound"), true);
});

test("guard mode queues confirm results and returns confirmation id", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard" } });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "needs confirmation" } }] },
      rawText: '{"choices":[{"message":{"content":"needs confirmation"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_CONFIRM
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 409);
  assert.equal(body.error.type, "confirmation_required");
  assert.match(body.error.confirmationId, /^conf_/);
  assert.equal(events.some((event) => event.event === "review_decision" && event.decision.outcome === "confirm"), true);
  assert.equal(events.some((event) => event.event === "confirmation_created" && event.confirmationId === body.error.confirmationId), true);

  const confirmations = await invoke(handler, makeRequest({ method: "GET", url: "/api/admin/confirmations" }));
  assert.equal(confirmations.statusCode, 200);
  assert.equal(confirmations.bodyJson().data[0].id, body.error.confirmationId);
  assert.equal(confirmations.bodyJson().data[0].status, "pending");
});

test("guard mode hold confirm waits for admin allow and returns original upstream response", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard", confirmBehavior: "hold", holdTimeoutMs: 1000 } });
  const detector = createPendingDetector();
  const handler = createRequestHandler({
    getState: () => state,
    audit: {
      write: (event) => {
        events.push(event);
        detector.audit.write(event);
      }
    },
    confirmations: detector.queue,
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "held response" } }] },
      rawText: '{"choices":[{"message":{"content":"held response"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_CONFIRM
  });

  const { done: pendingResponse } = await invokePending(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  await detector.pending;

  const confirmations = await invoke(handler, makeRequest({ method: "GET", url: "/api/admin/confirmations" }));
  const confirmation = confirmations.bodyJson().data[0];
  assert.equal(confirmation.status, "pending");
  assert.equal(confirmation.direction, "inbound");

  const allowed = await invoke(
    handler,
    makeRequest({ method: "POST", url: `/api/admin/confirmations/${confirmation.id}/allow` })
  );
  const response = await pendingResponse;

  assert.equal(allowed.statusCode, 200);
  assert.equal(response.statusCode, 200);
  assert.equal(response.bodyJson().choices[0].message.content, "held response");
  assert.equal(events.some((event) => event.event === "confirmation_created" && event.confirmationId === confirmation.id), true);
  assert.equal(events.some((event) => event.event === "confirmation_used" && event.confirmationId === confirmation.id && event.direction === "inbound"), true);
});

test("guard mode hold confirm waits for admin block and returns confirmation_blocked", async () => {
  const state = makeState({ reviewer: { mode: "guard", confirmBehavior: "hold", holdTimeoutMs: 1000 } });
  const detector = createPendingDetector();
  const handler = createRequestHandler({
    getState: () => state,
    audit: detector.audit,
    confirmations: detector.queue,
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "held response" } }] },
      rawText: '{"choices":[{"message":{"content":"held response"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_CONFIRM
  });

  const { done: pendingResponse } = await invokePending(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  await detector.pending;

  const confirmations = await invoke(handler, makeRequest({ method: "GET", url: "/api/admin/confirmations" }));
  const confirmation = confirmations.bodyJson().data[0];
  await invoke(handler, makeRequest({ method: "POST", url: `/api/admin/confirmations/${confirmation.id}/block` }));
  const response = await pendingResponse;

  assert.equal(response.statusCode, 403);
  assert.equal(response.bodyJson().error.type, "confirmation_blocked");
});

test("guard mode hold confirm times out with confirmation_timeout", async () => {
  const state = makeState({ reviewer: { mode: "guard", confirmBehavior: "hold", holdTimeoutMs: 1 } });
  const events = [];
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "held response" } }] },
      rawText: '{"choices":[{"message":{"content":"held response"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_CONFIRM
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );

  assert.equal(response.statusCode, 504);
  assert.equal(response.bodyJson().error.type, "confirmation_timeout");
  assert.equal(events.some((event) => event.event === "confirmation_timeout" && event.direction === "inbound"), true);
});

test("guard mode can downgrade confirm to allow with confirmBehavior allow", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard", confirmBehavior: "allow" } });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "needs confirmation" } }] },
      rawText: '{"choices":[{"message":{"content":"needs confirmation"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_CONFIRM
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(events.some((event) => event.event === "review_decision" && event.decision.reason === "confirm_downgraded_to_allow"), true);
});

test("allowed confirmation header lets a matching retry pass without another review", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard" } });
  let reviewerCalls = 0;
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "retry response" } }] },
      rawText: '{"choices":[{"message":{"content":"retry response"}}]}',
      isJson: true
    }),
    callReviewer: async () => {
      reviewerCalls += 1;
      return REVIEW_CONFIRM;
    }
  });
  const requestBody = { model: "fast", messages: [{ role: "user", content: "hi" }] };

  const initial = await invoke(handler, makeRequest({ body: requestBody }));
  const confirmationId = initial.bodyJson().error.confirmationId;
  const allowed = await invoke(
    handler,
    makeRequest({ method: "POST", url: `/api/admin/confirmations/${confirmationId}/allow` })
  );
  const retry = await invoke(
    handler,
    makeRequest({ headers: { "x-tinygateway-confirmation": confirmationId }, body: requestBody })
  );

  assert.equal(initial.statusCode, 409);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.bodyJson().data.status, "allowed");
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.bodyJson().choices[0].message.content, "retry response");
  assert.equal(reviewerCalls, 1);
  assert.equal(events.some((event) => event.event === "confirmation_used" && event.confirmationId === confirmationId), true);
});

test("blocked confirmation header returns 403 on retry", async () => {
  const state = makeState({ reviewer: { mode: "guard" } });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "retry response" } }] },
      rawText: '{"choices":[{"message":{"content":"retry response"}}]}',
      isJson: true
    }),
    callReviewer: async () => REVIEW_CONFIRM
  });
  const requestBody = { model: "fast", messages: [{ role: "user", content: "hi" }] };

  const initial = await invoke(handler, makeRequest({ body: requestBody }));
  const confirmationId = initial.bodyJson().error.confirmationId;
  const blocked = await invoke(
    handler,
    makeRequest({ method: "POST", url: `/api/admin/confirmations/${confirmationId}/block` })
  );
  const retry = await invoke(
    handler,
    makeRequest({ headers: { "x-tinygateway-confirmation": confirmationId }, body: requestBody })
  );

  assert.equal(blocked.statusCode, 200);
  assert.equal(blocked.bodyJson().data.status, "blocked");
  assert.equal(retry.statusCode, 403);
  assert.equal(retry.bodyJson().error.type, "confirmation_blocked");
});

test("legacy full config blocks outbound request before proxying upstream when reviewer blocks", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "full" } });
  let upstreamCalls = 0;
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "should not call" } }] },
        rawText: '{"ok":true}',
        isJson: true
      };
    },
    callReviewer: async ({ job }) => {
      assert.equal(job.direction, "outbound");
      assert.equal(job.response, undefined);
      assert.equal(job.mode, "guard");
      assert.equal(job.context, "full");
      return REVIEW_BLOCK;
    }
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "delete files" }] } })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 403);
  assert.equal(body.error.type, "review_blocked");
  assert.equal(body.error.direction, "outbound");
  assert.equal(upstreamCalls, 0);
  assert.equal(events.some((event) => event.event === "review_result" && event.direction === "outbound"), true);
  assert.equal(events.some((event) => event.event === "review_decision" && event.direction === "outbound" && event.decision.outcome === "block"), true);
  assert.equal(events.some((event) => event.event === "request_blocked" && event.direction === "outbound"), true);
});

test("outbound guard queues confirm before proxying upstream", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard", context: "full", outboundReview: "guard" } });
  const seenDirections = [];
  let upstreamCalls = 0;
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "should wait for approval" } }] },
        rawText: '{"ok":true}',
        isJson: true
      };
    },
    callReviewer: async ({ job }) => {
      seenDirections.push(job.direction);
      return REVIEW_CONFIRM;
    }
  });

  const requestBody = { model: "fast", messages: [{ role: "user", content: "delete files" }] };
  const response = await invoke(handler, makeRequest({ body: requestBody }));
  const body = response.bodyJson();
  const confirmations = await invoke(handler, makeRequest({ method: "GET", url: "/api/admin/confirmations" }));
  const confirmation = confirmations.bodyJson().data[0];

  assert.equal(response.statusCode, 409);
  assert.equal(body.error.type, "confirmation_required");
  assert.equal(body.error.direction, "outbound");
  assert.match(body.error.confirmationId, /^conf_/);
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(seenDirections, ["outbound"]);
  assert.equal(confirmation.id, body.error.confirmationId);
  assert.equal(confirmation.status, "pending");
  assert.equal(confirmation.direction, "outbound");
  assert.match(confirmation.requestSummary.rawText, /delete files/);
  assert.equal(events.some((event) => event.event === "confirmation_created" && event.direction === "outbound"), true);
});

test("outbound guard hold confirm waits for admin allow before proxying upstream", async () => {
  const events = [];
  const state = makeState({
    reviewer: { mode: "guard", context: "full", outboundReview: "guard", confirmBehavior: "hold", holdTimeoutMs: 1000 }
  });
  const detector = createPendingDetector();
  let upstreamCalls = 0;
  const seenDirections = [];
  const handler = createRequestHandler({
    getState: () => state,
    audit: {
      write: (event) => {
        events.push(event);
        detector.audit.write(event);
      }
    },
    confirmations: detector.queue,
    proxyProviderRequest: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "approved after hold" } }] },
        rawText: '{"choices":[{"message":{"content":"approved after hold"}}]}',
        isJson: true
      };
    },
    callReviewer: async ({ job }) => {
      seenDirections.push(job.direction);
      return job.direction === "outbound" ? REVIEW_CONFIRM : REVIEW_ALLOW;
    }
  });
  const requestBody = { model: "fast", messages: [{ role: "user", content: "delete files" }] };

  const { done: pendingResponse } = await invokePending(handler, makeRequest({ body: requestBody }));
  await detector.pending;

  const confirmations = await invoke(handler, makeRequest({ method: "GET", url: "/api/admin/confirmations" }));
  const confirmation = confirmations.bodyJson().data[0];
  assert.equal(confirmation.status, "pending");
  assert.equal(confirmation.direction, "outbound");
  assert.equal(upstreamCalls, 0);

  await invoke(handler, makeRequest({ method: "POST", url: `/api/admin/confirmations/${confirmation.id}/allow` }));
  const response = await pendingResponse;

  assert.equal(response.statusCode, 200);
  assert.equal(response.bodyJson().choices[0].message.content, "approved after hold");
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(seenDirections, ["outbound", "inbound"]);
  assert.equal(events.some((event) => event.event === "confirmation_used" && event.confirmationId === confirmation.id && event.direction === "outbound"), true);
});

test("outbound guard hold confirm waits for admin block without proxying upstream", async () => {
  const state = makeState({
    reviewer: { mode: "guard", context: "full", outboundReview: "guard", confirmBehavior: "hold", holdTimeoutMs: 1000 }
  });
  const detector = createPendingDetector();
  let upstreamCalls = 0;
  const handler = createRequestHandler({
    getState: () => state,
    audit: detector.audit,
    confirmations: detector.queue,
    proxyProviderRequest: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "should not call" } }] },
        rawText: '{"ok":true}',
        isJson: true
      };
    },
    callReviewer: async ({ job }) => (job.direction === "outbound" ? REVIEW_CONFIRM : REVIEW_ALLOW)
  });
  const requestBody = { model: "fast", messages: [{ role: "user", content: "delete files" }] };

  const { done: pendingResponse } = await invokePending(handler, makeRequest({ body: requestBody }));
  await detector.pending;

  const confirmations = await invoke(handler, makeRequest({ method: "GET", url: "/api/admin/confirmations" }));
  const confirmation = confirmations.bodyJson().data[0];
  assert.equal(upstreamCalls, 0);
  await invoke(handler, makeRequest({ method: "POST", url: `/api/admin/confirmations/${confirmation.id}/block` }));
  const response = await pendingResponse;

  assert.equal(response.statusCode, 403);
  assert.equal(response.bodyJson().error.type, "confirmation_blocked");
  assert.equal(upstreamCalls, 0);
});

test("outbound guard hold confirm times out without proxying upstream", async () => {
  const state = makeState({
    reviewer: { mode: "guard", context: "full", outboundReview: "guard", confirmBehavior: "hold", holdTimeoutMs: 1 }
  });
  const events = [];
  let upstreamCalls = 0;
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "should not call" } }] },
        rawText: '{"ok":true}',
        isJson: true
      };
    },
    callReviewer: async ({ job }) => (job.direction === "outbound" ? REVIEW_CONFIRM : REVIEW_ALLOW)
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "delete files" }] } })
  );

  assert.equal(response.statusCode, 504);
  assert.equal(response.bodyJson().error.type, "confirmation_timeout");
  assert.equal(upstreamCalls, 0);
  assert.equal(events.some((event) => event.event === "confirmation_timeout" && event.direction === "outbound"), true);
});

test("outbound guard uses approved confirmation retry without another outbound review", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard", context: "full", outboundReview: "guard" } });
  let reviewerCalls = 0;
  let upstreamCalls = 0;
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "approved outbound response" } }] },
        rawText: '{"choices":[{"message":{"content":"approved outbound response"}}]}',
        isJson: true
      };
    },
    callReviewer: async ({ job }) => {
      reviewerCalls += 1;
      return job.direction === "outbound" ? REVIEW_CONFIRM : REVIEW_ALLOW;
    }
  });
  const requestBody = { model: "fast", messages: [{ role: "user", content: "delete files" }] };

  const initial = await invoke(handler, makeRequest({ body: requestBody }));
  const confirmationId = initial.bodyJson().error.confirmationId;
  const allowed = await invoke(
    handler,
    makeRequest({ method: "POST", url: `/api/admin/confirmations/${confirmationId}/allow` })
  );
  const retry = await invoke(
    handler,
    makeRequest({ headers: { "x-tinygateway-confirmation": confirmationId }, body: requestBody })
  );

  assert.equal(initial.statusCode, 409);
  assert.equal(allowed.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.bodyJson().choices[0].message.content, "approved outbound response");
  assert.equal(reviewerCalls, 2);
  assert.equal(upstreamCalls, 1);
  assert.equal(events.some((event) => event.event === "confirmation_used" && event.direction === "outbound"), true);
});

test("outbound guard blocks redact when request redaction is unsupported", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard", context: "full", outboundReview: "guard" } });
  const seenDirections = [];
  let upstreamCalls = 0;
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { choices: [{ message: { role: "assistant", content: "should not call" } }] },
        rawText: '{"ok":true}',
        isJson: true
      };
    },
    callReviewer: async ({ job }) => {
      seenDirections.push(job.direction);
      return REVIEW_REDACT;
    }
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "send sk-live-123" }] } })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 403);
  assert.equal(body.error.type, "redaction_unsupported");
  assert.equal(body.error.direction, "outbound");
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(seenDirections, ["outbound"]);
  assert.equal(events.some((event) => event.event === "review_decision" && event.direction === "outbound" && event.decision.outcome === "redact"), true);
  assert.equal(events.some((event) => event.event === "request_blocked" && event.direction === "outbound" && event.reason === "outbound_redaction_unsupported"), true);
});

test("split full-context outbound guard allows outbound then redacts inbound response", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "guard", context: "full", outboundReview: "guard" } });
  const seenDirections = [];
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "secret sk-live-123" } }] },
      rawText: '{"choices":[{"message":{"content":"secret sk-live-123"}}]}',
      isJson: true
    }),
    callReviewer: async ({ job }) => {
      seenDirections.push(job.direction);
      return job.direction === "outbound" ? REVIEW_ALLOW : REVIEW_REDACT;
    }
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 200);
  assert.equal(body.choices[0].message.content, "secret [REDACTED_KEY]");
  assert.deepEqual(seenDirections, ["outbound", "inbound"]);
  assert.equal(events.some((event) => event.event === "response_redacted" && event.mode === "guard" && event.changed === true), true);
  assert.equal(events.filter((event) => event.event === "review_decision").map((event) => event.direction).join(","), "outbound,inbound");
});

test("full mode allows outbound then blocks inbound response when reviewer blocks second pass", async () => {
  const events = [];
  const state = makeState({ reviewer: { mode: "full" } });
  const seenDirections = [];
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: (event) => events.push(event) },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "run rm -rf" } }] },
      rawText: '{"choices":[{"message":{"content":"run rm -rf"}}]}',
      isJson: true
    }),
    callReviewer: async ({ job }) => {
      seenDirections.push(job.direction);
      return job.direction === "outbound" ? REVIEW_ALLOW : REVIEW_BLOCK;
    }
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.bodyJson().error.type, "review_blocked");
  assert.deepEqual(seenDirections, ["outbound", "inbound"]);
  assert.equal(events.some((event) => event.event === "response_blocked" && event.direction === "inbound"), true);
  assert.equal(events.filter((event) => event.event === "review_decision").map((event) => event.direction).join(","), "outbound,inbound");
});

test("full mode queues inbound confirmation after outbound allow", async () => {
  const state = makeState({ reviewer: { mode: "full" } });
  const seenDirections = [];
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { choices: [{ message: { role: "assistant", content: "needs confirmation" } }] },
      rawText: '{"choices":[{"message":{"content":"needs confirmation"}}]}',
      isJson: true
    }),
    callReviewer: async ({ job }) => {
      seenDirections.push(job.direction);
      return job.direction === "outbound" ? REVIEW_ALLOW : REVIEW_CONFIRM;
    }
  });

  const response = await invoke(
    handler,
    makeRequest({ body: { model: "fast", messages: [{ role: "user", content: "hi" }] } })
  );
  const body = response.bodyJson();

  assert.equal(response.statusCode, 409);
  assert.equal(body.error.type, "confirmation_required");
  assert.match(body.error.confirmationId, /^conf_/);
  assert.deepEqual(seenDirections, ["outbound", "inbound"]);
});

test("model handler schedules audit review after stream response completes", async () => {
  const scheduled = [];
  const state = makeState();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n"));
      controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n"));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      stream,
      isStream: true
    }),
    scheduleAuditReview: (payload) => scheduled.push(payload)
  });

  const response = await invoke(handler, makeRequest({ body: { model: "fast", stream: true, messages: [] } }));
  const text = response.bodyText();

  assert.equal(response.statusCode, 200);
  assert.match(text, /data: .*hel/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].upstream.isStream, true);
  assert.equal(scheduled[0].upstream.status, 200);
  assert.match(scheduled[0].upstream.rawText, /hel/);
  assert.match(scheduled[0].upstream.rawText, /\[DONE\]/);
  assert.equal(scheduled[0].upstream.reviewMetadata.source, "stream_buffer");
  assert.equal(scheduled[0].upstream.reviewMetadata.truncated, false);
});

test("model handler truncates captured stream audit buffer", async () => {
  const scheduled = [];
  const state = makeState();
  const longPayload = "x".repeat(80);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(longPayload));
      controller.close();
    }
  });
  const handler = createRequestHandler({
    getState: () => state,
    audit: { write: () => {} },
    proxyProviderRequest: async () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      stream,
      isStream: true
    }),
    scheduleAuditReview: (payload) => scheduled.push(payload),
    streamReviewMaxBytes: 16
  });

  const response = await invoke(handler, makeRequest({ body: { model: "fast", stream: true, messages: [] } }));

  assert.equal(response.bodyText(), longPayload);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].upstream.rawText.length, 16);
  assert.equal(scheduled[0].upstream.reviewMetadata.truncated, true);
  assert.equal(scheduled[0].upstream.reviewMetadata.capturedBytes, 16);
});
