import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationQueue } from "../src/confirmations.js";

function makeQueue() {
  return new ConfirmationQueue({
    now: () => new Date("2026-05-28T08:00:00.000Z"),
    idFactory: () => "conf_hold"
  });
}

function createPending(queue = makeQueue()) {
  return queue.create({
    requestId: "req_1",
    endpoint: "/v1/chat/completions",
    target: {
      provider: { id: "openai-main" },
      model: { id: "fast", upstreamId: "gpt-fast" }
    },
    requestBody: { model: "fast", messages: [{ role: "user", content: "hi" }] },
    upstream: { status: 200, headers: { "content-type": "application/json" }, isJson: true, body: { ok: true } },
    review: { action: "confirm", risk: "high", reason: "needs approval" },
    decision: { outcome: "confirm", reason: "confirmation_hold", statusCode: 202 },
    direction: "inbound"
  });
}

test("confirmation queue waitForResolution resolves when pending item is allowed", async () => {
  const queue = makeQueue();
  const pending = createPending(queue);
  const wait = queue.waitForResolution(pending.id, { timeoutMs: 1000 });

  const allowed = queue.resolve(pending.id, "allowed");
  const result = await wait;

  assert.equal(allowed.status, "allowed");
  assert.equal(result.outcome, "allowed");
  assert.equal(result.confirmation.id, pending.id);
  assert.equal(result.confirmation.status, "allowed");
});

test("confirmation queue waitForResolution resolves when pending item is blocked", async () => {
  const queue = makeQueue();
  const pending = createPending(queue);
  const wait = queue.waitForResolution(pending.id, { timeoutMs: 1000 });

  queue.resolve(pending.id, "blocked");
  const result = await wait;

  assert.equal(result.outcome, "blocked");
  assert.equal(result.confirmation.id, pending.id);
  assert.equal(result.confirmation.status, "blocked");
});

test("confirmation queue waitForResolution returns immediately for already resolved and missing items", async () => {
  const queue = makeQueue();
  const pending = createPending(queue);
  queue.resolve(pending.id, "allowed");

  const allowed = await queue.waitForResolution(pending.id, { timeoutMs: 1000 });
  const missing = await queue.waitForResolution("conf_missing", { timeoutMs: 1000 });

  assert.equal(allowed.outcome, "allowed");
  assert.equal(allowed.confirmation.status, "allowed");
  assert.deepEqual(missing, { outcome: "missing" });
});

test("confirmation queue waitForResolution reports timeout and clears waiter", async () => {
  const queue = makeQueue();
  const pending = createPending(queue);

  const result = await queue.waitForResolution(pending.id, { timeoutMs: 1 });
  const allowedAfterTimeout = queue.resolve(pending.id, "allowed");

  assert.equal(result.outcome, "timeout");
  assert.equal(result.confirmation.id, pending.id);
  assert.equal(result.confirmation.status, "pending");
  assert.equal(allowedAfterTimeout.status, "allowed");
});