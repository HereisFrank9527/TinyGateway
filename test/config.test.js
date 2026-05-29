import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, normalizeReviewerRuntimeConfig } from "../src/config.js";

function baseConfig(reviewer = {}) {
  return {
    server: { host: "127.0.0.1", port: 8787 },
    audit: { enabled: true, directory: "logs" },
    reviewer,
    modelMappings: [{ id: "fast", provider: "main", upstreamModel: "gpt-fast" }],
    providers: [{ id: "main", type: "openai", baseUrl: "https://main.test", apiKey: "secret" }]
  };
}

test("parseConfig defaults reviewer confirmBehavior to queue", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard" })));

  assert.equal(config.reviewer.confirmBehavior, "queue");
});

test("parseConfig defaults audit retention to 48 hours and 20 MB", () => {
  const config = parseConfig(JSON.stringify(baseConfig()));

  assert.equal(config.audit.retentionHours, 48);
  assert.equal(config.audit.maxSizeMb, 20);
});

test("parseConfig keeps valid audit retention settings", () => {
  const raw = baseConfig();
  raw.audit.retentionHours = 72;
  raw.audit.maxSizeMb = 64;
  const config = parseConfig(JSON.stringify(raw));

  assert.equal(config.audit.retentionHours, 72);
  assert.equal(config.audit.maxSizeMb, 64);
});

test("parseConfig keeps valid reviewer confirmBehavior", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", confirmBehavior: "allow" })));

  assert.equal(config.reviewer.confirmBehavior, "allow");
});

test("parseConfig keeps queue reviewer confirmBehavior", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", confirmBehavior: "queue" })));

  assert.equal(config.reviewer.confirmBehavior, "queue");
});

test("parseConfig keeps hold reviewer confirmBehavior", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", confirmBehavior: "hold" })));

  assert.equal(config.reviewer.confirmBehavior, "hold");
});

test("parseConfig normalizes reviewer holdTimeoutMs with safe defaults", () => {
  const configured = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", holdTimeoutMs: 45000 })));
  const invalid = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", holdTimeoutMs: "later" })));
  const tooSmall = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", holdTimeoutMs: 0 })));

  assert.equal(configured.reviewer.holdTimeoutMs, 45000);
  assert.equal(invalid.reviewer.holdTimeoutMs, 120000);
  assert.equal(tooSmall.reviewer.holdTimeoutMs, 120000);
});

test("parseConfig keeps retry reviewer confirmBehavior as retry queue mode", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", confirmBehavior: "retry" })));

  assert.equal(config.reviewer.confirmBehavior, "retry");
});

test("parseConfig normalizes invalid reviewer confirmBehavior to queue", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard", confirmBehavior: "pause" })));

  assert.equal(config.reviewer.confirmBehavior, "queue");
});

test("parseConfig defaults reviewer context and outboundReview", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "guard" })));

  assert.equal(config.reviewer.context, "response");
  assert.equal(config.reviewer.outboundReview, "off");
});

test("parseConfig keeps valid reviewer context and outboundReview", () => {
  const config = parseConfig(
    JSON.stringify(baseConfig({ enabled: true, mode: "guard", context: "full", outboundReview: "audit" }))
  );

  assert.equal(config.reviewer.context, "full");
  assert.equal(config.reviewer.outboundReview, "audit");
});

test("parseConfig normalizes invalid reviewer context and outboundReview", () => {
  const config = parseConfig(
    JSON.stringify(baseConfig({ enabled: true, mode: "guard", context: "everything", outboundReview: "maybe" }))
  );

  assert.equal(config.reviewer.context, "response");
  assert.equal(config.reviewer.outboundReview, "off");
});

test("normalizeReviewerRuntimeConfig maps old full mode to guard full-context outbound guard", () => {
  const config = parseConfig(JSON.stringify(baseConfig({ enabled: true, mode: "full" })));

  assert.deepEqual(normalizeReviewerRuntimeConfig(config.reviewer), {
    enabled: true,
    mode: "guard",
    context: "full",
    outboundReview: "guard",
    confirmBehavior: "queue",
    holdTimeoutMs: 120000,
    failBehavior: "allow"
  });
});

test("normalizeReviewerRuntimeConfig preserves split reviewer semantics", () => {
  const config = parseConfig(
    JSON.stringify(
      baseConfig({
        enabled: true,
        mode: "audit",
        context: "full",
        outboundReview: "audit",
        confirmBehavior: "hold",
        failBehavior: "block"
      })
    )
  );

  assert.deepEqual(normalizeReviewerRuntimeConfig(config.reviewer), {
    enabled: true,
    mode: "audit",
    context: "full",
    outboundReview: "audit",
    confirmBehavior: "hold",
    holdTimeoutMs: 120000,
    failBehavior: "block"
  });
});
