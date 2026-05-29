import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";

function tempLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tinygateway-audit-"));
}

function auditConfig(directory, overrides = {}) {
  return {
    audit: {
      enabled: true,
      directory,
      retentionHours: 48,
      maxSizeMb: 20,
      ...overrides
    }
  };
}

function readLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("AuditLog prunes entries older than configured retention hours", () => {
  const directory = tempLogDir();
  const filePath = path.join(directory, "audit.jsonl");
  const oldEntry = { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: "old" };
  const freshEntry = { ts: new Date().toISOString(), event: "fresh" };
  fs.writeFileSync(filePath, `${JSON.stringify(oldEntry)}\n${JSON.stringify(freshEntry)}\n`, "utf8");

  const audit = new AuditLog(auditConfig(directory, { retentionHours: 1 }));
  audit.write({ event: "new" });

  const events = readLines(filePath).map((entry) => entry.event);
  assert.deepEqual(events, ["fresh", "new"]);
});

test("AuditLog keeps newest entries when max size is exceeded", () => {
  const directory = tempLogDir();
  const audit = new AuditLog(auditConfig(directory, { maxSizeMb: 0.001 }));
  for (let index = 0; index < 20; index += 1) {
    audit.write({ event: "item", index, payload: "x".repeat(120) });
  }

  const filePath = path.join(directory, "audit.jsonl");
  const entries = readLines(filePath);

  assert.ok(fs.statSync(filePath).size <= 0.001 * 1024 * 1024 + 256);
  assert.equal(entries.at(-1).index, 19);
  assert.ok(entries[0].index > 0);
});
