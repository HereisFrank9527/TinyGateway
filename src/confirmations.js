export class ConfirmationQueue {
  constructor({ now = () => new Date(), idFactory = defaultConfirmationId } = {}) {
    this.now = now;
    this.idFactory = idFactory;
    this.items = new Map();
    this.waiters = new Map();
  }

  create({ requestId, endpoint, target, requestBody, upstream, review, decision, direction = "inbound" }) {
    const now = this.now().toISOString();
    const confirmation = {
      id: this.idFactory(),
      requestId,
      endpoint,
      direction,
      provider: target.provider.id,
      model: target.model.id,
      upstreamModel: target.model.upstreamId || target.model.id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      review,
      decision,
      requestFingerprint: fingerprintRequestBody(requestBody),
      requestSummary: summarizeRequest(requestBody),
      responseSummary: upstream ? summarizeUpstream(upstream) : null
    };
    this.items.set(confirmation.id, confirmation);
    return cloneConfirmation(confirmation);
  }

  list() {
    return [...this.items.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneConfirmation);
  }

  get(id) {
    const item = this.items.get(id);
    return item ? cloneConfirmation(item) : null;
  }

  resolve(id, status) {
    if (!["allowed", "blocked"].includes(status)) {
      throw new Error(`Unsupported confirmation status: ${status}`);
    }
    const item = this.items.get(id);
    if (!item) {
      return null;
    }
    item.status = status;
    item.updatedAt = this.now().toISOString();
    const confirmation = cloneConfirmation(item);
    this.notifyWaiters(id, status, confirmation);
    return confirmation;
  }

  waitForResolution(id, { timeoutMs = 120000 } = {}) {
    const item = this.items.get(id);
    if (!item) {
      return Promise.resolve({ outcome: "missing" });
    }
    if (item.status === "allowed" || item.status === "blocked") {
      return Promise.resolve({ outcome: item.status, confirmation: cloneConfirmation(item) });
    }

    const normalizedTimeoutMs = Math.max(1, Number(timeoutMs) || 120000);
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(id, waiter);
          const current = this.items.get(id);
          resolve({ outcome: "timeout", confirmation: current ? cloneConfirmation(current) : null });
        }, normalizedTimeoutMs)
      };
      const waiters = this.waiters.get(id) || new Set();
      waiters.add(waiter);
      this.waiters.set(id, waiters);
    });
  }

  notifyWaiters(id, outcome, confirmation) {
    const waiters = this.waiters.get(id);
    if (!waiters) {
      return;
    }
    this.waiters.delete(id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ outcome, confirmation });
    }
  }

  removeWaiter(id, waiter) {
    const waiters = this.waiters.get(id);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.waiters.delete(id);
    }
  }

  matchForRequest(id, requestBody) {
    const item = this.items.get(id);
    if (!item) {
      return { outcome: "missing" };
    }
    if (item.requestFingerprint !== fingerprintRequestBody(requestBody)) {
      return { outcome: "mismatch", confirmation: cloneConfirmation(item) };
    }
    if (item.status === "allowed") {
      return { outcome: "allowed", confirmation: cloneConfirmation(item) };
    }
    if (item.status === "blocked") {
      return { outcome: "blocked", confirmation: cloneConfirmation(item) };
    }
    return { outcome: "pending", confirmation: cloneConfirmation(item) };
  }
}

function defaultConfirmationId() {
  return `conf_${crypto.randomUUID().replaceAll("-", "")}`;
}

function fingerprintRequestBody(requestBody) {
  return JSON.stringify(sortValue(requestBody));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function summarizeRequest(requestBody) {
  return {
    rawText: truncateText(JSON.stringify(requestBody ?? ""))
  };
}

function summarizeUpstream(upstream) {
  return {
    status: upstream.status,
    isJson: Boolean(upstream.isJson),
    isStream: Boolean(upstream.isStream),
    contentType: upstream.headers?.["content-type"] || upstream.headers?.["Content-Type"] || "",
    rawText: truncateText(upstream.rawText || (typeof upstream.body === "string" ? upstream.body : JSON.stringify(upstream.body ?? "")))
  };
}

function truncateText(value, maxLength = 2000) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function cloneConfirmation(confirmation) {
  return structuredClone(confirmation);
}
