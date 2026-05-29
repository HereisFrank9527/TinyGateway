import { buildInboundReviewJob, buildOutboundReviewJob } from "./job.js";
import { normalizeReviewerRuntimeConfig } from "../config.js";
import { shouldRunGuard } from "./decision.js";
import { callReviewer as defaultCallReviewer, withTimeout } from "./reviewer.js";

export function shouldRunReview(reviewer = {}) {
  const runtime = normalizeReviewerRuntimeConfig(reviewer);
  return Boolean(runtime.enabled && runtime.mode === "audit");
}

export function shouldRunOutboundReview(reviewer = {}) {
  const runtime = normalizeReviewerRuntimeConfig(reviewer);
  return Boolean(runtime.enabled && runtime.outboundReview !== "off" && reviewer.provider && reviewer.model);
}

export { shouldRunGuard };

function canCallReviewer(reviewer = {}) {
  return Boolean(shouldRunReview(reviewer) && reviewer.provider && reviewer.model);
}

function runtimeReviewer(reviewer = {}) {
  return {
    ...reviewer,
    ...normalizeReviewerRuntimeConfig(reviewer)
  };
}

export async function runGuardReview({
  state,
  requestId,
  endpoint,
  target,
  requestBody,
  upstream,
  direction = "inbound",
  audit,
  callReviewer = defaultCallReviewer
}) {
  const reviewer = runtimeReviewer(state.config.reviewer);
  const job = direction === "outbound"
    ? buildOutboundReviewJob({
        requestId,
        mode: reviewer.mode,
        context: reviewer.context,
        endpoint,
        provider: target.provider,
        model: target.model,
        requestBody
      })
    : buildInboundReviewJob({
        requestId,
        mode: reviewer.mode,
        context: reviewer.context,
        endpoint,
        provider: target.provider,
        model: target.model,
        requestBody,
        upstream
      });

  const started = Date.now();
  try {
    const review = await withTimeout((signal) => callReviewer({ config: state.config, job, signal }), reviewer.timeoutMs);
    audit.write({
      requestId: job.requestId,
      reviewId: job.id,
      event: "review_result",
      mode: reviewer.mode,
      direction: job.direction,
      endpoint: job.endpoint,
      provider: job.provider,
      model: job.localModel,
      upstreamModel: job.upstreamModel,
      reviewerProvider: reviewer.provider,
      reviewerModel: reviewer.model,
      latencyMs: Date.now() - started,
      review
    });
    return review;
  } catch (error) {
    audit.write({
      requestId: job.requestId,
      reviewId: job.id,
      event: "review_error",
      mode: reviewer.mode,
      direction: job.direction,
      endpoint: job.endpoint,
      provider: job.provider,
      model: job.localModel,
      upstreamModel: job.upstreamModel,
      reviewerProvider: reviewer.provider,
      reviewerModel: reviewer.model,
      latencyMs: Date.now() - started,
      failBehavior: reviewer.failBehavior,
      message: error.message
    });
    if (reviewer.failBehavior === "block") {
      return {
        risk: "unknown",
        action: "block",
        confidence: 0,
        categories: ["unknown"],
        reason: `Reviewer failed: ${error.message}`,
        evidence: [],
        requiresUserApproval: true,
        suggestedUserPrompt: ""
      };
    }
    return {
      risk: "unknown",
      action: "audit",
      confidence: 0,
      categories: ["unknown"],
      reason: `Reviewer failed: ${error.message}`,
      evidence: [],
      requiresUserApproval: false,
      suggestedUserPrompt: ""
    };
  }
}

export function scheduleAuditReview({ state, requestId, endpoint, target, requestBody, upstream, audit }) {
  const reviewer = runtimeReviewer(state.config.reviewer);
  if (!canCallReviewer(reviewer)) {
    if (reviewer?.enabled && reviewer.mode !== "off") {
      audit.write({
        requestId,
        event: "review_skipped",
        mode: reviewer.mode,
        reason: reviewer.mode === "audit" ? "reviewer_provider_or_model_not_configured" : "mode_not_supported_for_audit_scheduler"
      });
    }
    return;
  }

  const job = buildInboundReviewJob({
    requestId,
    mode: reviewer.mode,
    context: reviewer.context,
    endpoint,
    provider: target.provider,
    model: target.model,
    requestBody,
    upstream
  });

  void runAuditReview({
    reviewConfig: reviewer,
    config: state.config,
    job,
    audit
  });
}

export async function runAuditReview({ reviewConfig, config, job, audit, callReviewer = defaultCallReviewer }) {
  const started = Date.now();
  try {
    const review = await withTimeout(
      (signal) => callReviewer({ config, job, signal }),
      reviewConfig.timeoutMs
    );
    audit.write({
      requestId: job.requestId,
      reviewId: job.id,
      event: "review_result",
      mode: reviewConfig.mode,
      direction: job.direction,
      endpoint: job.endpoint,
      provider: job.provider,
      model: job.localModel,
      upstreamModel: job.upstreamModel,
      reviewerProvider: reviewConfig.provider,
      reviewerModel: reviewConfig.model,
      latencyMs: Date.now() - started,
      review
    });
  } catch (error) {
    audit.write({
      requestId: job.requestId,
      reviewId: job.id,
      event: "review_error",
      mode: reviewConfig.mode,
      direction: job.direction,
      endpoint: job.endpoint,
      provider: job.provider,
      model: job.localModel,
      upstreamModel: job.upstreamModel,
      reviewerProvider: reviewConfig.provider,
      reviewerModel: reviewConfig.model,
      latencyMs: Date.now() - started,
      failBehavior: reviewConfig.failBehavior,
      message: error.message
    });
  }
}
