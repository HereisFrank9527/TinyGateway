import { normalizeReviewerRuntimeConfig } from "../config.js";

export function shouldRunGuard(reviewer = {}) {
  const runtime = normalizeReviewerRuntimeConfig(reviewer);
  return Boolean(runtime.enabled && runtime.mode === "guard" && reviewer.provider && reviewer.model);
}

export function decideGuardAction({ review, reviewConfig = {} }) {
  const action = review?.action || "audit";

  if (action === "allow") {
    return { outcome: "allow", reason: "reviewer_allow", statusCode: 200 };
  }

  if (action === "audit") {
    return { outcome: "allow", reason: "reviewer_audit", statusCode: 200 };
  }

  if (action === "block") {
    return { outcome: "block", reason: "reviewer_block", statusCode: 403 };
  }

  if (action === "confirm") {
    if (reviewConfig.confirmBehavior === "allow") {
      return { outcome: "allow", reason: "confirm_downgraded_to_allow", statusCode: 200 };
    }
    if (reviewConfig.confirmBehavior === "block") {
      return { outcome: "block", reason: "confirm_downgraded_to_block", statusCode: 403 };
    }
    if (reviewConfig.confirmBehavior === "hold") {
      return { outcome: "confirm", reason: "confirmation_hold", statusCode: 202 };
    }
    return { outcome: "confirm", reason: "confirmation_required", statusCode: 409 };
  }

  if (action === "redact") {
    return { outcome: "redact", reason: "reviewer_redact", statusCode: 200 };
  }

  return { outcome: "allow", reason: "reviewer_unknown_action", statusCode: 200 };
}

export function decideReviewAction({ mode, review, reviewConfig = {} }) {
  if (mode === "audit") {
    return {
      action: "record_only",
      shouldBlock: false,
      shouldReturnOriginalResponse: true,
      reason: "Audit mode records reviewer decisions without blocking."
    };
  }

  if (mode === "guard") {
    const decision = decideGuardAction({ review, reviewConfig });
    return {
      action: decision.reason,
      shouldBlock: decision.outcome === "block",
      shouldReturnOriginalResponse: decision.outcome !== "block",
      reason: review?.reason || decision.reason
    };
  }

  return {
    action: "allow",
    shouldBlock: false,
    shouldReturnOriginalResponse: true,
    reason: review?.reason
  };
}
