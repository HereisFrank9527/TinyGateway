export async function readJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

export function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

export function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...headers
  });
  res.end(body);
}

export function sendHtml(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    ...headers
  });
  res.end(body);
}

export function sendCss(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/css; charset=utf-8",
    ...headers
  });
  res.end(body);
}

export function sendJs(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/javascript; charset=utf-8",
    ...headers
  });
  res.end(body);
}

export function getRequestId() {
  return crypto.randomUUID();
}
