const MAX_TEXT_LENGTH = 12000;
const MAX_ARRAY_ITEMS = 40;

export function detectClientProtocol(endpoint) {
  if (endpoint === "/v1/messages") {
    return "anthropic";
  }
  if (endpoint === "/v1/chat/completions") {
    return "openai";
  }
  return "unknown";
}

export function buildInboundReviewJob({ requestId, mode, context = "response", endpoint, provider, model, requestBody, upstream }) {
  const reviewContext = context === "full" ? "full" : "response";
  const streamCapture = normalizeStreamCaptureMetadata(upstream?.reviewMetadata);
  return {
    id: getReviewId(),
    requestId,
    mode,
    context: reviewContext,
    direction: "inbound",
    endpoint,
    clientProtocol: detectClientProtocol(endpoint),
    provider: provider.id,
    providerProtocol: provider.type,
    localModel: model.id,
    upstreamModel: model.upstreamId || model.id,
    stream: Boolean(requestBody?.stream),
    ...(reviewContext === "full" ? { request: extractRequestForReview(requestBody) } : {}),
    response: extractResponseForReview(upstream),
    metadata: compactObject({
      createdAt: new Date().toISOString(),
      truncated: Boolean(streamCapture?.truncated),
      streamCapture
    })
  };
}

export function buildOutboundReviewJob({ requestId, mode, context = "full", endpoint, provider, model, requestBody }) {
  const reviewContext = context === "response" ? "response" : "full";
  return {
    id: getReviewId(),
    requestId,
    mode,
    context: reviewContext,
    direction: "outbound",
    endpoint,
    clientProtocol: detectClientProtocol(endpoint),
    provider: provider.id,
    providerProtocol: provider.type,
    localModel: model.id,
    upstreamModel: model.upstreamId || model.id,
    stream: Boolean(requestBody?.stream),
    request: extractRequestForReview(requestBody),
    metadata: compactObject({
      createdAt: new Date().toISOString()
    })
  };
}

export function extractRequestForReview(body = {}) {
  return compactObject({
    model: safeText(body.model),
    system: normalizeContent(body.system),
    messages: limitArray(body.messages).map(normalizeMessage),
    tools: limitArray(body.tools).map(normalizeTool)
  });
}

export function extractResponseForReview(upstream = {}) {
  const body = upstream.body;
  const content = [];
  const toolCalls = [];

  if (body && typeof body === "object") {
    collectContentFromBody(body, content, toolCalls);
  } else if (typeof body === "string") {
    content.push({ type: "text", text: truncateText(body) });
  }

  if (content.length === 0 && typeof upstream.rawText === "string" && upstream.rawText) {
    content.push({ type: "text", text: truncateText(upstream.rawText) });
  }

  return compactObject({
    statusCode: upstream.status,
    content: content.slice(0, MAX_ARRAY_ITEMS),
    toolCalls: toolCalls.slice(0, MAX_ARRAY_ITEMS),
    rawText: typeof upstream.rawText === "string" ? truncateText(upstream.rawText) : undefined
  });
}

function collectContentFromBody(body, content, toolCalls) {
  if (Array.isArray(body.content)) {
    for (const block of body.content.slice(0, MAX_ARRAY_ITEMS)) {
      if (typeof block === "string") {
        content.push({ type: "text", text: truncateText(block) });
      } else if (block?.type === "text") {
        content.push({ type: "text", text: truncateText(block.text || "") });
      } else if (block?.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }

  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choice of choices.slice(0, MAX_ARRAY_ITEMS)) {
    const message = choice.message || choice.delta || {};
    if (typeof message.content === "string") {
      content.push({ type: "text", text: truncateText(message.content) });
    } else if (Array.isArray(message.content)) {
      for (const item of message.content.slice(0, MAX_ARRAY_ITEMS)) {
        if (typeof item === "string") {
          content.push({ type: "text", text: truncateText(item) });
        } else if (item?.type === "text") {
          content.push({ type: "text", text: truncateText(item.text || "") });
        }
      }
    }
    if (Array.isArray(message.tool_calls)) {
      toolCalls.push(...message.tool_calls.map(normalizeOpenAiToolCall));
    }
  }

  if (typeof body.output_text === "string") {
    content.push({ type: "text", text: truncateText(body.output_text) });
  }
}

function normalizeStreamCaptureMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  return compactObject({
    source: metadata.source,
    truncated: Boolean(metadata.truncated),
    capturedBytes: Number.isFinite(metadata.capturedBytes) ? metadata.capturedBytes : undefined
  });
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object") {
    return { role: "unknown", content: normalizeContent(message) };
  }
  return compactObject({
    role: safeText(message.role || "unknown"),
    content: normalizeContent(message.content),
    tool_call_id: safeText(message.tool_call_id),
    name: safeText(message.name)
  });
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") {
    return { value: normalizeContent(tool) };
  }
  return compactObject({
    name: safeText(tool.name || tool.function?.name),
    description: safeText(tool.description || tool.function?.description),
    input_schema: tool.input_schema || tool.function?.parameters
  });
}

function normalizeOpenAiToolCall(call) {
  return compactObject({
    id: call.id,
    type: call.type,
    name: call.function?.name,
    input: parseMaybeJson(call.function?.arguments)
  });
}

function normalizeContent(content) {
  if (typeof content === "string" || typeof content === "number" || typeof content === "boolean") {
    return truncateText(String(content));
  }
  if (Array.isArray(content)) {
    return content.slice(0, MAX_ARRAY_ITEMS).map((item) => {
      if (typeof item === "string") {
        return { type: "text", text: truncateText(item) };
      }
      if (!item || typeof item !== "object") {
        return { type: "unknown", value: truncateText(String(item)) };
      }
      return compactObject({
        type: item.type || "unknown",
        text: typeof item.text === "string" ? truncateText(item.text) : undefined,
        content: typeof item.content === "string" ? truncateText(item.content) : undefined,
        name: item.name,
        id: item.id,
        input: item.input,
        tool_use_id: item.tool_use_id
      });
    });
  }
  if (content && typeof content === "object") {
    return compactObject(content);
  }
  return content;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function limitArray(value) {
  return Array.isArray(value) ? value.slice(0, MAX_ARRAY_ITEMS) : [];
}

function truncateText(value) {
  const text = String(value ?? "");
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}...[truncated]` : text;
}

function safeText(value) {
  return typeof value === "string" ? truncateText(value) : value;
}

function compactObject(object) {
  const result = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

function getReviewId() {
  return `review_${crypto.randomUUID()}`;
}
