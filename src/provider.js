import { getProviderApiKey } from "./config.js";

export async function fetchProviderModels(provider) {
  if (provider.type === "anthropic") {
    return fetchAnthropicModels(provider);
  }
  if (provider.type === "openai") {
    return fetchOpenAiModels(provider);
  }
  throw new Error(`Unsupported provider type: ${provider.type}`);
}

export async function proxyProviderRequest({ provider, endpoint, body, sourceHeaders }) {
  if (provider.type === "anthropic") {
    return proxyAnthropic({ provider, endpoint, body, sourceHeaders });
  }
  if (provider.type === "openai") {
    return proxyOpenAi({ provider, endpoint, body, sourceHeaders });
  }
  throw new Error(`Unsupported provider type: ${provider.type}`);
}

async function proxyAnthropic({ provider, endpoint, body, sourceHeaders }) {
  const apiKey = getProviderApiKey(provider);
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": sourceHeaders["anthropic-version"] || provider.anthropicVersion || "2023-06-01"
  };

  if (sourceHeaders["anthropic-beta"] || provider.anthropicBeta) {
    headers["anthropic-beta"] = sourceHeaders["anthropic-beta"] || provider.anthropicBeta;
  }

  return fetchUpstream(`${provider.baseUrl}${endpoint}`, headers, body);
}

async function proxyOpenAi({ provider, endpoint, body }) {
  const apiKey = getProviderApiKey(provider);
  return fetchUpstream(
    `${provider.baseUrl}${endpoint}`,
    {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body
  );
}

async function fetchAnthropicModels(provider) {
  const apiKey = getProviderApiKey(provider);
  const body = await fetchJson(`${provider.baseUrl}/v1/models`, {
    "x-api-key": apiKey,
    "anthropic-version": provider.anthropicVersion || "2023-06-01"
  });

  return normalizeModelList(body);
}

async function fetchOpenAiModels(provider) {
  const apiKey = getProviderApiKey(provider);
  const body = await fetchJson(`${provider.baseUrl}/v1/models`, {
    authorization: `Bearer ${apiKey}`
  });

  return normalizeModelList(body);
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...headers
    }
  });
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Model list returned invalid JSON from ${url}.`);
  }

  if (!response.ok) {
    throw new Error(body.error?.message || body.message || `Model list request failed: ${response.status}`);
  }

  return body;
}

function normalizeModelList(body) {
  const data = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return data
    .map((model) => {
      if (typeof model === "string") {
        return {
          id: model,
          displayName: model
        };
      }

      const id = model.id || model.name || model.model;
      if (!id) {
        return null;
      }

      return {
        id,
        displayName: model.display_name || model.displayName || model.name || id,
        created: model.created || model.created_at || undefined
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchUpstream(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const responseHeaders = {};
  for (const [key, value] of response.headers.entries()) {
    if (["content-type", "cache-control"].includes(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return {
      status: response.status,
      headers: responseHeaders,
      stream: response.body,
      isStream: true
    };
  }

  const text = await response.text();

  if (contentType.includes("application/json")) {
    try {
      return {
        status: response.status,
        headers: responseHeaders,
        body: JSON.parse(text),
        rawText: text,
        isJson: true
      };
    } catch {
      return {
        status: response.status,
        headers: responseHeaders,
        body: { error: { message: "Upstream returned invalid JSON." } },
        rawText: text,
        isJson: true
      };
    }
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body: text,
    rawText: text,
    isJson: false
  };
}
