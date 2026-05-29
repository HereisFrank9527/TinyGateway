import http from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { ConfigStore } from "./config-store.js";
import { AuditLog } from "./audit.js";
import { readJson, sendJson, sendText, getRequestId } from "./http.js";
import { listModels } from "./models.js";
import { proxyProviderRequest as defaultProxyProviderRequest } from "./provider.js";
import { routeAdminRequest } from "./admin.js";
import {
  runGuardReview as defaultRunGuardReview,
  scheduleAuditReview as defaultScheduleAuditReview,
  shouldRunGuard,
  shouldRunOutboundReview
} from "./review/index.js";
import { normalizeReviewerRuntimeConfig } from "./config.js";
import { decideGuardAction } from "./review/decision.js";
import { applyRedactions } from "./review/redact.js";
import { ConfirmationQueue } from "./confirmations.js";
import { buildAttackSimulationBody, isAttackSimulatorModel, resolveAttackSimulationParams } from "./attack-simulator.js";

const DEFAULT_STREAM_REVIEW_MAX_BYTES = 64 * 1024;

if (isMainModule()) {
  const configStore = new ConfigStore();
  const audit = new AuditLog(configStore.current().config);
  let server;
  const handler = createRequestHandler({
    getState: () => configStore.current(),
    configStore,
    audit,
    shutdown: () => shutdownServer(server)
  });
  server = http.createServer(handler);
  const startupConfig = configStore.current().config;
  server.listen(startupConfig.server.port, startupConfig.server.host, () => {
    console.log(`TinyGateway listening on http://${startupConfig.server.host}:${startupConfig.server.port}`);
  });
}

export function createRequestHandler({
  getState,
  configStore,
  audit,
  proxyProviderRequest = defaultProxyProviderRequest,
  scheduleAuditReview = defaultScheduleAuditReview,
  callReviewer,
  runGuardReview = callReviewer
    ? (payload) => defaultRunGuardReview({ ...payload, callReviewer })
    : defaultRunGuardReview,
  streamReviewMaxBytes = DEFAULT_STREAM_REVIEW_MAX_BYTES,
  confirmations = new ConfirmationQueue(),
  shutdown
}) {
  return async function requestHandler(req, res) {
    const requestId = getRequestId();

    try {
      await routeRequest(req, res, requestId, {
        getState,
        configStore,
        audit,
        proxyProviderRequest,
        scheduleAuditReview,
        runGuardReview,
        streamReviewMaxBytes,
        confirmations,
        shutdown
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      audit.write({
        requestId,
        event: "error",
        method: req.method,
        url: req.url,
        statusCode,
        message: error.message
      });
      sendJson(res, statusCode, {
        error: {
          type: statusCode >= 500 ? "gateway_error" : "bad_request",
          message: error.message
        }
      });
    }
  };
}

function shutdownServer(server) {
  setTimeout(() => {
    server.close(() => {
      process.exit(0);
    });
  }, 50);
}

async function routeRequest(req, res, requestId, deps) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const state = deps.getState();
  const config = state.config;

  if (await routeAdminRequest({ req, res, url, state, configStore: deps.configStore, audit: deps.audit, confirmations: deps.confirmations })) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: !state.lastError,
      configError: state.lastError?.message || null
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, listModels(config));
    return;
  }

  if (req.method === "POST" && ["/v1/messages", "/v1/chat/completions"].includes(url.pathname)) {
    await handleModelRequest(req, res, requestId, url.pathname, state, deps);
    return;
  }

  sendJson(res, 404, {
    error: {
      type: "not_found",
      message: `No route for ${req.method} ${url.pathname}.`
    }
  });
}

function runtimeReviewer(reviewer = {}) {
  return {
    ...reviewer,
    ...normalizeReviewerRuntimeConfig(reviewer)
  };
}

async function handleModelRequest(req, res, requestId, endpoint, state, deps) {
  const { modelIndex } = state;
  const body = await readJson(req);
  const target = resolveTarget(body, modelIndex);
  ensureEndpointMatchesProvider(endpoint, target.provider);

  deps.audit.write({
    requestId,
    event: "request",
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    requestedModel: body.model
  });

  const confirmationId = String(req.headers["x-tinygateway-confirmation"] || "").trim();
  let skipOutboundReviewForConfirmation = false;
  if (confirmationId && !isInternalReviewerRequest(req.headers)) {
    const match = deps.confirmations.matchForRequest(confirmationId, body);
    if (match.outcome === "allowed" && match.confirmation.direction === "outbound") {
      skipOutboundReviewForConfirmation = true;
      writeConfirmationUsedAudit({
        requestId,
        endpoint,
        target,
        deps,
        confirmationId,
        direction: "outbound",
        status: match.confirmation.status
      });
    } else if (match.confirmation?.direction === "outbound") {
      writeConfirmationFailure({ req, res, requestId, endpoint, target, deps, confirmationId, match });
      return;
    }
  }

  if (!skipOutboundReviewForConfirmation) {
    if (await handleOutboundReviewIfNeeded({ req, res, requestId, endpoint, state, target, requestBody: body, deps })) {
      return;
    }
  }

  const attackSimulationParams = isAttackSimulatorModel(target)
    ? resolveAttackSimulationParams({ requestBody: body, simulator: target.model.attackSimulator })
    : null;
  const upstreamBody = isAttackSimulatorModel(target)
    ? buildAttackSimulationBody({ requestBody: body, simulator: target.model.attackSimulator })
    : {
        ...body,
        model: target.model.upstreamId || target.model.id
      };
  if (isAttackSimulatorModel(target)) {
    deps.audit.write({
      requestId,
      event: "attack_simulation",
      endpoint,
      model: target.model.id,
      provider: target.provider.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      scenario: attackSimulationParams.scenario,
      intensity: attackSimulationParams.intensity,
      insertionStyle: attackSimulationParams.insertionStyle,
      safeMode: attackSimulationParams.safeMode,
      clientParameterized: attackSimulationParams.clientParameterized
    });
  }
  const upstream = await deps.proxyProviderRequest({
    provider: target.provider,
    endpoint,
    body: upstreamBody,
    sourceHeaders: normalizeHeaders(req.headers)
  });

  if (upstream.isStream) {
    deps.audit.write({
      requestId,
      event: "response_stream",
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      statusCode: upstream.status,
      note: "Streaming response passed through."
    });
    writeHeaders(res, upstream.status, upstream.headers);
    const streamCapture = createStreamCapture(upstream, deps.streamReviewMaxBytes);
    Readable.fromWeb(streamCapture.stream).pipe(res);
    if (!isInternalReviewerRequest(req.headers)) {
      res.once("finish", () => {
        deps.scheduleAuditReview({
          state,
          requestId,
          endpoint,
          target,
          requestBody: body,
          upstream: streamCapture.toReviewUpstream(),
          audit: deps.audit
        });
      });
    }
    return;
  }

  deps.audit.write({
    requestId,
    event: "response",
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    statusCode: upstream.status
  });

  if (await handleApprovedConfirmationIfPresent({ req, res, requestId, endpoint, state, target, requestBody: body, upstream, deps })) {
    return;
  }

  if (await handleGuardReviewIfNeeded({ req, res, requestId, endpoint, state, target, requestBody: body, upstream, deps })) {
    return;
  }

  if (upstream.isJson) {
    sendJson(res, upstream.status, upstream.body, upstream.headers);
  } else {
    sendText(res, upstream.status, upstream.body, upstream.headers);
  }

  if (!isInternalReviewerRequest(req.headers) && !shouldRunGuard(state.config.reviewer)) {
    deps.scheduleAuditReview({
      state,
      requestId,
      endpoint,
      target,
      requestBody: body,
      upstream,
      audit: deps.audit
    });
  }
}

async function handleOutboundReviewIfNeeded({ req, res, requestId, endpoint, state, target, requestBody, deps }) {
  if (isInternalReviewerRequest(req.headers) || !shouldRunOutboundReview(state.config.reviewer)) {
    return false;
  }

  const reviewer = runtimeReviewer(state.config.reviewer);
  const review = await deps.runGuardReview({
    state,
    requestId,
    endpoint,
    target,
    requestBody,
    direction: "outbound",
    audit: deps.audit
  });
  const decision = reviewer.outboundReview === "guard"
    ? decideGuardAction({ review, reviewConfig: reviewer })
    : { outcome: "allow", reason: "outbound_audit_only", statusCode: 200 };

  deps.audit.write({
    requestId,
    event: "review_decision",
    mode: reviewer.mode,
    direction: "outbound",
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    upstreamModel: target.model.upstreamId || target.model.id,
    review,
    decision
  });

  if (decision.outcome === "confirm") {
    const confirmation = deps.confirmations.create({
      requestId,
      endpoint,
      target,
      requestBody,
      upstream: null,
      review,
      decision,
      direction: "outbound"
    });
    deps.audit.write({
      requestId,
      event: "confirmation_created",
      confirmationId: confirmation.id,
      mode: reviewer.mode,
      direction: "outbound",
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      statusCode: decision.statusCode,
      review,
      decision
    });

    if (isHoldConfirmation(decision, reviewer)) {
      const result = await deps.confirmations.waitForResolution(confirmation.id, { timeoutMs: reviewer.holdTimeoutMs });
      if (result.outcome === "allowed") {
        writeConfirmationUsedAudit({ requestId, endpoint, target, deps, confirmationId: confirmation.id, direction: "outbound", status: result.confirmation.status });
        return false;
      }
      writeHeldConfirmationFailure({ res, requestId, endpoint, target, deps, confirmationId: confirmation.id, direction: "outbound", result });
      return true;
    }

    sendJson(res, 409, {
      error: {
        type: "confirmation_required",
        direction: "outbound",
        message: review.suggestedUserPrompt || review.reason || "Request requires user confirmation.",
        confirmationId: confirmation.id,
        review,
        decision
      }
    });
    return true;
  }

  if (decision.outcome === "redact") {
    const blockedDecision = { ...decision, statusCode: 403, reason: "outbound_redaction_unsupported" };
    deps.audit.write({
      requestId,
      event: "request_blocked",
      mode: reviewer.mode,
      direction: "outbound",
      reason: "outbound_redaction_unsupported",
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      statusCode: blockedDecision.statusCode,
      review,
      decision: blockedDecision
    });
    sendJson(res, blockedDecision.statusCode, {
      error: {
        type: "redaction_unsupported",
        direction: "outbound",
        message: "Outbound request redaction is not supported yet; request was blocked instead.",
        review,
        decision: blockedDecision
      }
    });
    return true;
  }

  if (decision.outcome !== "block") {
    return false;
  }

  deps.audit.write({
    requestId,
    event: "request_blocked",
    mode: reviewer.mode,
    direction: "outbound",
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    upstreamModel: target.model.upstreamId || target.model.id,
    statusCode: decision.statusCode,
    review,
    decision
  });

  sendJson(res, decision.statusCode, {
    error: {
      type: "review_blocked",
      direction: "outbound",
      message: review.reason || "Request blocked by reviewer.",
      review,
      decision
    }
  });
  return true;
}

async function handleApprovedConfirmationIfPresent({ req, res, requestId, endpoint, state, target, requestBody, upstream, deps }) {
  const confirmationId = String(req.headers["x-tinygateway-confirmation"] || "").trim();
  if (!confirmationId || isInternalReviewerRequest(req.headers) || !shouldRunGuard(state.config.reviewer)) {
    return false;
  }

  const match = deps.confirmations.matchForRequest(confirmationId, requestBody);
  if (match.outcome === "allowed") {
    if (match.confirmation.direction === "outbound") {
      return false;
    }
    writeConfirmationUsedAudit({
      requestId,
      endpoint,
      target,
      deps,
      confirmationId,
      direction: "inbound",
      status: match.confirmation.status
    });
    if (upstream.isJson) {
      sendJson(res, upstream.status, upstream.body, upstream.headers);
    } else {
      sendText(res, upstream.status, upstream.body, upstream.headers);
    }
    return true;
  }

  writeConfirmationFailure({ req, res, requestId, endpoint, target, deps, confirmationId, match });
  return true;
}

function writeConfirmationUsedAudit({ requestId, endpoint, target, deps, confirmationId, direction, status }) {
  deps.audit.write({
    requestId,
    event: "confirmation_used",
    confirmationId,
    direction,
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    upstreamModel: target.model.upstreamId || target.model.id,
    status
  });
}

function isHoldConfirmation(decision, reviewer) {
  return decision.outcome === "confirm" && (decision.reason === "confirmation_hold" || reviewer.confirmBehavior === "hold");
}

function writeHeldConfirmationFailure({ res, requestId, endpoint, target, deps, confirmationId, direction, result }) {
  if (result.outcome === "blocked") {
    deps.audit.write({
      requestId,
      event: "confirmation_blocked",
      confirmationId,
      direction,
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      statusCode: 403
    });
    sendJson(res, 403, {
      error: {
        type: "confirmation_blocked",
        direction,
        message: "This confirmation was blocked by the user.",
        confirmationId
      }
    });
    return;
  }

  if (result.outcome === "timeout") {
    deps.audit.write({
      requestId,
      event: "confirmation_timeout",
      confirmationId,
      direction,
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      statusCode: 504
    });
    sendJson(res, 504, {
      error: {
        type: "confirmation_timeout",
        direction,
        message: "Timed out while waiting for user confirmation.",
        confirmationId
      }
    });
    return;
  }

  deps.audit.write({
    requestId,
    event: "confirmation_rejected",
    confirmationId,
    direction,
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    upstreamModel: target.model.upstreamId || target.model.id,
    reason: result.outcome
  });
  sendJson(res, 409, {
    error: {
      type: "confirmation_not_allowed",
      direction,
      message: "Confirmation is missing, pending, or does not match this request.",
      confirmationId,
      status: result.confirmation?.status || result.outcome
    }
  });
}

function writeConfirmationFailure({ req, res, requestId, endpoint, target, deps, confirmationId, match }) {
  if (match.outcome === "blocked") {
    deps.audit.write({
      requestId,
      event: "confirmation_blocked",
      confirmationId,
      direction: match.confirmation.direction || "inbound",
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      statusCode: 403
    });
    sendJson(res, 403, {
      error: {
        type: "confirmation_blocked",
        message: "This confirmation was blocked by the user.",
        confirmationId
      }
    });
    return;
  }

  deps.audit.write({
    requestId,
    event: "confirmation_rejected",
    confirmationId,
    direction: match.confirmation?.direction || "unknown",
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    upstreamModel: target.model.upstreamId || target.model.id,
    reason: match.outcome
  });
  sendJson(res, 409, {
    error: {
      type: "confirmation_not_allowed",
      message: "Confirmation is missing, pending, or does not match this request.",
      confirmationId,
      status: match.confirmation?.status || match.outcome
    }
  });
}

async function handleGuardReviewIfNeeded({ req, res, requestId, endpoint, state, target, requestBody, upstream, deps }) {
  if (isInternalReviewerRequest(req.headers) || !shouldRunGuard(state.config.reviewer)) {
    return false;
  }

  const reviewer = runtimeReviewer(state.config.reviewer);
  const review = await deps.runGuardReview({
    state,
    requestId,
    endpoint,
    target,
    requestBody,
    upstream,
    audit: deps.audit
  });
  const decision = decideGuardAction({ review, reviewConfig: reviewer });

  deps.audit.write({
    requestId,
    event: "review_decision",
    mode: reviewer.mode,
    direction: "inbound",
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    upstreamModel: target.model.upstreamId || target.model.id,
    review,
    decision
  });

  if (decision.outcome === "confirm") {
    const confirmation = deps.confirmations.create({ requestId, endpoint, target, requestBody, upstream, review, decision, direction: "inbound" });
    deps.audit.write({
      requestId,
      event: "confirmation_created",
      confirmationId: confirmation.id,
      direction: "inbound",
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      statusCode: decision.statusCode,
      review,
      decision
    });

    if (isHoldConfirmation(decision, reviewer)) {
      const result = await deps.confirmations.waitForResolution(confirmation.id, { timeoutMs: reviewer.holdTimeoutMs });
      if (result.outcome === "allowed") {
        writeConfirmationUsedAudit({ requestId, endpoint, target, deps, confirmationId: confirmation.id, direction: "inbound", status: result.confirmation.status });
        if (upstream.isJson) {
          sendJson(res, upstream.status, upstream.body, upstream.headers);
        } else {
          sendText(res, upstream.status, upstream.body, upstream.headers);
        }
        return true;
      }
      writeHeldConfirmationFailure({ res, requestId, endpoint, target, deps, confirmationId: confirmation.id, direction: "inbound", result });
      return true;
    }

    sendJson(res, 409, {
      error: {
        type: "confirmation_required",
        message: review.suggestedUserPrompt || review.reason || "Response requires user confirmation.",
        confirmationId: confirmation.id,
        review,
        decision
      }
    });
    return true;
  }

  if (decision.outcome === "redact") {
    const redacted = applyRedactions(upstream, review);
    deps.audit.write({
      requestId,
      event: "response_redacted",
      mode: reviewer.mode,
      direction: "inbound",
      endpoint,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      statusCode: decision.statusCode,
      changed: redacted !== upstream,
      redactionCount: review.redactions?.length || 0,
      review,
      decision
    });
    if (redacted.isJson) {
      sendJson(res, redacted.status, redacted.body, redacted.headers);
    } else {
      sendText(res, redacted.status, redacted.body, redacted.headers);
    }
    return true;
  }

  if (decision.outcome !== "block") {
    return false;
  }

  deps.audit.write({
    requestId,
    event: "response_blocked",
    mode: reviewer.mode,
    direction: "inbound",
    endpoint,
    provider: target.provider.id,
    model: target.model.id,
    upstreamModel: target.model.upstreamId || target.model.id,
    statusCode: decision.statusCode,
    review,
    decision
  });

  sendJson(res, decision.statusCode, {
    error: {
      type: "review_blocked",
      message: review.reason || "Response blocked by reviewer.",
      review,
      decision
    }
  });
  return true;
}

function isInternalReviewerRequest(headers) {
  return String(headers["x-tinygateway-reviewer"] || "") === "1";
}

function createStreamCapture(upstream, maxBytes) {
  const captureLimit = Math.max(0, Number(maxBytes) || 0);
  const chunks = [];
  let capturedBytes = 0;
  let truncated = false;

  const transform = new TransformStream({
    transform(chunk, controller) {
      captureChunk(chunk);
      controller.enqueue(chunk);
    }
  });

  function captureChunk(chunk) {
    if (captureLimit === 0) {
      truncated = true;
      return;
    }

    const buffer = Buffer.from(chunk);
    const remaining = captureLimit - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining));
      capturedBytes += remaining;
      truncated = true;
      return;
    }

    chunks.push(buffer);
    capturedBytes += buffer.length;
  }

  return {
    stream: upstream.stream.pipeThrough(transform),
    toReviewUpstream() {
      return {
        status: upstream.status,
        headers: upstream.headers,
        isStream: true,
        rawText: Buffer.concat(chunks).toString("utf8"),
        reviewMetadata: {
          source: "stream_buffer",
          truncated,
          capturedBytes
        }
      };
    }
  };
}

function writeHeaders(res, statusCode, headers = {}) {
  res.writeHead(statusCode, headers);
}

function resolveTarget(body, modelIndex) {
  if (!body.model || typeof body.model !== "string") {
    const error = new Error("Request body requires a string model field.");
    error.statusCode = 400;
    throw error;
  }

  const target = modelIndex.get(body.model);
  if (!target) {
    const error = new Error(`Unknown model: ${body.model}`);
    error.statusCode = 400;
    throw error;
  }

  return target;
}

function ensureEndpointMatchesProvider(endpoint, provider) {
  const supported =
    (provider.type === "anthropic" && endpoint === "/v1/messages") ||
    (provider.type === "openai" && endpoint === "/v1/chat/completions");

  if (!supported) {
    const error = new Error(`Model provider ${provider.id} (${provider.type}) does not support ${endpoint}.`);
    error.statusCode = 400;
    throw error;
  }
}

function isMainModule() {
  return import.meta.url === pathToFileURL(process.argv[1] || "").href;
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return normalized;
}
