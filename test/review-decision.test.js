import assert from "node:assert/strict";
import test from "node:test";
import { decideGuardAction, shouldRunGuard } from "../src/review/decision.js";

test("shouldRunGuard only enables configured guard runtime mode", () => {
  assert.equal(shouldRunGuard({ enabled: false, mode: "guard", provider: "p", model: "m" }), false);
  assert.equal(shouldRunGuard({ enabled: true, mode: "audit", provider: "p", model: "m" }), false);
  assert.equal(shouldRunGuard({ enabled: true, mode: "guard" }), false);
  assert.equal(shouldRunGuard({ enabled: true, mode: "guard", provider: "p", model: "m" }), true);
  assert.equal(shouldRunGuard({ enabled: true, mode: "full", provider: "p", model: "m" }), true);
});

test("decideGuardAction allows low-risk allow and audit results", () => {
  assert.deepEqual(
    decideGuardAction({ review: { action: "allow", risk: "low" }, reviewConfig: { confirmBehavior: "block" } }),
    { outcome: "allow", reason: "reviewer_allow", statusCode: 200 }
  );
  assert.deepEqual(
    decideGuardAction({ review: { action: "audit", risk: "medium" }, reviewConfig: { confirmBehavior: "block" } }),
    { outcome: "allow", reason: "reviewer_audit", statusCode: 200 }
  );
});

test("decideGuardAction blocks reviewer block results", () => {
  const decision = decideGuardAction({
    review: { action: "block", risk: "critical", reason: "danger" },
    reviewConfig: { confirmBehavior: "allow" }
  });

  assert.equal(decision.outcome, "block");
  assert.equal(decision.reason, "reviewer_block");
  assert.equal(decision.statusCode, 403);
});

test("decideGuardAction applies confirmBehavior for confirm results", () => {
  assert.deepEqual(
    decideGuardAction({ review: { action: "confirm", risk: "high" }, reviewConfig: { confirmBehavior: "queue" } }),
    { outcome: "confirm", reason: "confirmation_required", statusCode: 409 }
  );
  assert.deepEqual(
    decideGuardAction({ review: { action: "confirm", risk: "high" }, reviewConfig: { confirmBehavior: "retry" } }),
    { outcome: "confirm", reason: "confirmation_required", statusCode: 409 }
  );
  assert.deepEqual(
    decideGuardAction({ review: { action: "confirm", risk: "high" }, reviewConfig: { confirmBehavior: "hold" } }),
    { outcome: "confirm", reason: "confirmation_hold", statusCode: 202 }
  );
  assert.deepEqual(
    decideGuardAction({ review: { action: "confirm", risk: "high" }, reviewConfig: { confirmBehavior: "allow" } }),
    { outcome: "allow", reason: "confirm_downgraded_to_allow", statusCode: 200 }
  );
  assert.deepEqual(
    decideGuardAction({ review: { action: "confirm", risk: "high" }, reviewConfig: { confirmBehavior: "block" } }),
    { outcome: "block", reason: "confirm_downgraded_to_block", statusCode: 403 }
  );
});

test("decideGuardAction returns redact decision when reviewer suggests redaction", () => {
  const decision = decideGuardAction({
    review: { action: "redact", risk: "high", redactions: [{ text: "secret", replacement: "[REDACTED]" }] },
    reviewConfig: { confirmBehavior: "allow" }
  });

  assert.equal(decision.outcome, "redact");
  assert.equal(decision.reason, "reviewer_redact");
  assert.equal(decision.statusCode, 200);
});
