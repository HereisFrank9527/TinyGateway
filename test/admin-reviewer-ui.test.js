import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../src/admin-ui/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/admin-ui/app.js", import.meta.url), "utf8");

test("reviewer admin form exposes split reviewer controls without legacy full mode option", () => {
  assert.match(html, /id="reviewerContext"/);
  assert.match(html, /id="reviewerOutboundReview"/);
  assert.match(html, /id="reviewerConfirmBehavior"/);
  assert.match(html, /id="reviewerHoldTimeoutMs"/);
  assert.match(html, /<option value="hold">hold：挂起原请求，确认后自动继续<\/option>/);
  assert.match(html, /<option value="retry">retry：返回确认 ID，由客户端重试<\/option>/);
  assert.match(html, /<select id="reviewerMode">/);
  assert.match(html, /<option value="off">关闭：不调用检查模型<\/option>/);
  assert.doesNotMatch(html, /id="reviewerEnabled"/);
  assert.doesNotMatch(html, /<option value="full">full: outbound and inbound review<\/option>/);
});

test("saveReviewer derives enabled state from reviewer mode", () => {
  assert.match(app, /enabled:\s*\$\("#reviewerMode"\)\.value !== "off"/);
  assert.doesNotMatch(app, /\$\("#reviewerEnabled"\)/);
  assert.match(app, /context:\s*\$\("#reviewerContext"\)\.value/);
  assert.match(app, /outboundReview:\s*\$\("#reviewerOutboundReview"\)\.value/);
  assert.match(app, /confirmBehavior:\s*\$\("#reviewerConfirmBehavior"\)\.value/);
  assert.match(app, /holdTimeoutMs:\s*Number\(\$\("#reviewerHoldTimeoutMs"\)\.value \|\| 120000\)/);
});

test("admin UI supports manual provider model lists and reviewer model selection", () => {
  assert.match(app, /data-provider-models/);
  assert.match(app, /mergeManualModels/);
  assert.match(app, /renderReviewerModelControl/);
  assert.match(html, /id="reviewerModelControl"/);
  assert.match(app, /selectedProviderModels/);
});

test("admin UI exposes attack simulator route configuration", () => {
  assert.match(html, /data-tab="attack-simulators"/);
  assert.match(html, /id="attackSimulatorsList"/);
  assert.match(html, /id="addAttackSimulator"/);
  assert.match(app, /renderAttackSimulators\(\)/);
  assert.match(app, /data-attack-simulator-field="scenario"/);
  assert.match(app, /startup_poisoning/);
  assert.match(app, /prompt_injection/);
  assert.match(app, /data_exfiltration/);
  assert.match(app, /saveAttackSimulator/);
});

test("admin UI exposes client parameter controls for attack simulation", () => {
  assert.match(app, /allowClientParams/);
  assert.match(app, /allowedScenarios/);
  assert.match(app, /allowedIntensities/);
  assert.match(app, /allowedInsertionStyles/);
  assert.match(app, /safeMode/);
  assert.match(app, /tool-intent/);
  assert.match(app, /lab/);
  assert.match(app, /defaultIntensity/);
  assert.match(app, /defaultInsertionStyle/);
  assert.match(app, /client_parameterized/);
});

test("admin UI exposes attack simulation report", () => {
  assert.match(html, /id="attackReportList"/);
  assert.match(html, /id="refreshAttackReport"/);
  assert.match(app, /loadAttackReport/);
  assert.match(app, /\/api\/admin\/attack-simulations\/report/);
  assert.match(html, /模式说明/);
});
