import assert from "node:assert/strict";
import fs from "node:fs";
import { Writable } from "node:stream";
import test from "node:test";
import { routeAdminRequest } from "../src/admin.js";

const CURRENT_VERSION = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

test("admin attack simulation report aggregates audit events", async () => {
  const entries = [
    {
      ts: "2026-05-29T01:00:00.000Z",
      requestId: "req_1",
      event: "attack_simulation",
      model: "attack-sim",
      provider: "anthropic-main",
      upstreamModel: "claude",
      scenario: "startup_poisoning",
      intensity: "high",
      insertionStyle: "natural",
      safeMode: "tool-intent",
      clientParameterized: true
    },
    {
      ts: "2026-05-29T01:00:01.000Z",
      requestId: "req_1",
      event: "review_decision",
      review: {
        risk: "high",
        action: "confirm",
        categories: ["dangerous_shell"],
        reason: "tool intent"
      },
      decision: {
        outcome: "confirm",
        reason: "confirmation_hold",
        statusCode: 409
      }
    }
  ];
  const response = await invokeAdmin("/api/admin/attack-simulations/report", {
    audit: {
      readRecent: () => entries
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.length, 1);
  assert.deepEqual(response.body.data[0], {
    requestId: "req_1",
    ts: "2026-05-29T01:00:00.000Z",
    model: "attack-sim",
    provider: "anthropic-main",
    upstreamModel: "claude",
    scenario: "startup_poisoning",
    intensity: "high",
    insertionStyle: "natural",
    safeMode: "tool-intent",
    clientParameterized: true,
    reviews: [
      {
        event: "review_decision",
        risk: "high",
        action: "confirm",
        categories: ["dangerous_shell"],
        reason: "tool intent"
      }
    ],
    decisions: [
      {
        event: "review_decision",
        outcome: "confirm",
        reason: "confirmation_hold",
        statusCode: 409
      }
    ],
    status: "confirm"
  });
});

test("admin shutdown endpoint requires loopback and calls shutdown handler", async () => {
  let called = false;
  const response = await invokeAdmin("/api/admin/shutdown", {
    method: "POST",
    remoteAddress: "127.0.0.1",
    shutdown: () => {
      called = true;
    },
    audit: {
      readRecent: () => [],
      write: () => {}
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(called, true);
});

test("admin shutdown endpoint rejects non-loopback clients", async () => {
  let called = false;
  const response = await invokeAdmin("/api/admin/shutdown", {
    method: "POST",
    remoteAddress: "192.168.1.20",
    shutdown: () => {
      called = true;
    },
    audit: {
      readRecent: () => [],
      write: () => {}
    }
  });

  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
});

test("admin update check compares local VERSION with latest GitHub release", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    tag_name: "v9.9.9",
    html_url: "https://github.com/HereisFrank9527/TinyGateway/releases/tag/v9.9.9",
    published_at: "2026-05-29T00:00:00Z",
    body: "release notes",
    assets: [{ name: "TinyGateway-portable.zip" }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const response = await invokeAdmin("/api/admin/update/check", {
      audit: {
        readRecent: () => [],
        write: () => {}
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.currentVersion, CURRENT_VERSION);
    assert.equal(response.body.latestVersion, "9.9.9");
    assert.equal(response.body.updateAvailable, true);
    assert.equal(response.body.assetName, "TinyGateway-portable.zip");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin status exposes local version", async () => {
  const response = await invokeAdmin("/api/admin/status", {
    state: {
      lastError: null,
      config: {
        server: { host: "127.0.0.1", port: 8787 },
        providers: [{ id: "main", type: "openai", baseUrl: "https://main.test", apiKey: "secret", models: [{ id: "gpt-test", aliases: [] }] }],
        modelMappings: [],
        attackSimulation: { enabled: false },
        attackSimulators: []
      }
    },
    audit: {
      readRecent: () => [],
      write: () => {}
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.version, CURRENT_VERSION);
});

async function invokeAdmin(path, deps) {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.setHeader = () => {};
  res.writeHead = (statusCode) => {
    res.statusCode = statusCode;
  };
  const req = {
    method: deps.method || "GET",
    url: path,
    headers: { host: "localhost" },
    socket: { remoteAddress: deps.remoteAddress || "127.0.0.1" }
  };
  const url = new URL(path, "http://localhost");
  await routeAdminRequest({
    req,
    res,
    url,
    state: deps.state || { config: { server: { host: "127.0.0.1", port: 8787 }, providers: [] } },
    configStore: {},
    audit: deps.audit,
    shutdown: deps.shutdown
  });
  return {
    statusCode: res.statusCode,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
  };
}
