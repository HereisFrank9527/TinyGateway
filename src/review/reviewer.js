import { getProviderApiKey } from "../config.js";
import { buildReviewerMessages } from "./prompt.js";
import { parseReviewResult } from "./schema.js";

export async function callReviewer({ config, job, signal }) {
  const reviewer = config.reviewer;
  const provider = config.providers.find((item) => item.id === reviewer.provider);
  if (!provider) {
    throw new Error(`Reviewer provider not found: ${reviewer.provider}`);
  }
  if (!reviewer.model) {
    throw new Error("Reviewer model is not configured.");
  }

  const messages = buildReviewerMessages(job);
  const output = await callReviewerProvider({ provider, model: reviewer.model, messages, signal });
  return parseReviewResult(output);
}

export async function callReviewerProvider({ provider, model, messages, signal }) {
  if (provider.type === "openai") {
    return callOpenAiReviewer({ provider, model, messages, signal });
  }
  if (provider.type === "anthropic") {
    return callAnthropicReviewer({ provider, model, messages, signal });
  }
  throw new Error(`Unsupported reviewer provider type: ${provider.type}`);
}

async function callOpenAiReviewer({ provider, model, messages, signal }) {
  const response = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tinygateway-reviewer": "1",
      authorization: `Bearer ${getProviderApiKey(provider)}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      stream: false,
      response_format: { type: "json_object" }
    }),
    signal
  });
  const body = await readJsonResponse(response, "reviewer OpenAI-compatible response");
  if (!response.ok) {
    throw new Error(body.error?.message || body.message || `Reviewer request failed: ${response.status}`);
  }
  const message = body.choices?.[0]?.message;
  return message?.content || JSON.stringify(body);
}

async function callAnthropicReviewer({ provider, model, messages, signal }) {
  const system = messages.find((message) => message.role === "system")?.content || "";
  const userMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));

  const response = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tinygateway-reviewer": "1",
      "x-api-key": getProviderApiKey(provider),
      "anthropic-version": provider.anthropicVersion || "2023-06-01"
    },
    body: JSON.stringify({
      model,
      system,
      messages: userMessages,
      max_tokens: 1000,
      temperature: 0,
      stream: false
    }),
    signal
  });
  const body = await readJsonResponse(response, "reviewer Anthropic response");
  if (!response.ok) {
    throw new Error(body.error?.message || body.message || `Reviewer request failed: ${response.status}`);
  }
  const text = (body.content || [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return text || JSON.stringify(body);
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 12000));
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Reviewer request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
