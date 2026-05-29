import fs from "node:fs";
import path from "node:path";
import { readJson, sendCss, sendHtml, sendJs, sendJson } from "./http.js";
import { listModels } from "./models.js";
import { fetchProviderModels } from "./provider.js";
import { ConfirmationQueue } from "./confirmations.js";

const STATIC_DIR = path.resolve(process.cwd(), "src", "admin-ui");
const REPO = "HereisFrank9527/TinyGateway";

export async function routeAdminRequest({ req, res, url, state, configStore, audit, confirmations = new ConfirmationQueue(), shutdown }) {
  if (req.method === "GET" && url.pathname === "/admin") {
    sendStatic(res, "index.html", sendHtml);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/app.css") {
    sendStatic(res, "app.css", sendCss);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/app.js") {
    sendStatic(res, "app.js", sendJs);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/audit-render.js") {
    sendStatic(res, "audit-render.js", sendJs);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/confirmation-render.js") {
    sendStatic(res, "confirmation-render.js", sendJs);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/status") {
    sendJson(res, 200, {
      ok: !state.lastError,
      configError: state.lastError?.message || null,
      address: `http://${state.config.server.host}:${state.config.server.port}`,
      version: readLocalVersion(),
      providerCount: state.config.providers.length,
      modelCount: listModels(state.config).data.length
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/update/check") {
    sendJson(res, 200, await checkForUpdate());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/shutdown") {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, {
        error: {
          type: "forbidden",
          message: "Shutdown is only allowed from loopback clients."
        }
      });
      return true;
    }
    if (typeof shutdown !== "function") {
      sendJson(res, 503, {
        error: {
          type: "shutdown_unavailable",
          message: "Shutdown handler is not available."
        }
      });
      return true;
    }
    audit.write({ event: "shutdown_requested", remoteAddress: req.socket?.remoteAddress || "" });
    sendJson(res, 200, { ok: true, message: "TinyGateway is shutting down." });
    shutdown();
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/config") {
    sendJson(res, 200, configStore.publicConfig());
    return true;
  }

  if (req.method === "PUT" && url.pathname === "/api/admin/config") {
    const body = await readJson(req);
    const saved = configStore.save(body);
    if (typeof audit.configure === "function") {
      audit.configure(configStore.current().config);
    }
    sendJson(res, 200, saved);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/models") {
    sendJson(res, 200, listModels(state.config));
    return true;
  }

  const fetchModelsMatch = url.pathname.match(/^\/api\/admin\/providers\/([^/]+)\/models\/fetch$/);
  if (req.method === "POST" && fetchModelsMatch) {
    const providerId = decodeURIComponent(fetchModelsMatch[1]);
    const provider = state.config.providers.find((item) => item.id === providerId);
    if (!provider) {
      sendJson(res, 404, {
        error: {
          type: "not_found",
          message: `Unknown provider: ${providerId}`
        }
      });
      return true;
    }

    const models = await fetchProviderModels(provider);
    const savedConfig = configStore.saveProviderModels(providerId, models);
    sendJson(res, 200, {
      providerId,
      count: models.length,
      models,
      config: savedConfig
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/audit") {
    sendJson(res, 200, {
      data: audit.readRecent(url.searchParams.get("limit") || 100)
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/attack-simulations/report") {
    sendJson(res, 200, {
      data: buildAttackSimulationReport(audit.readRecent(url.searchParams.get("limit") || 500))
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/confirmations") {
    sendJson(res, 200, {
      data: confirmations.list()
    });
    return true;
  }

  const confirmationActionMatch = url.pathname.match(/^\/api\/admin\/confirmations\/([^/]+)\/(allow|block)$/);
  if (req.method === "POST" && confirmationActionMatch) {
    const confirmationId = decodeURIComponent(confirmationActionMatch[1]);
    const action = confirmationActionMatch[2];
    const confirmation = confirmations.resolve(confirmationId, action === "allow" ? "allowed" : "blocked");
    if (!confirmation) {
      sendJson(res, 404, {
        error: {
          type: "not_found",
          message: `Unknown confirmation: ${confirmationId}`
        }
      });
      return true;
    }
    audit.write({
      event: "confirmation_resolved",
      confirmationId,
      status: confirmation.status,
      requestId: confirmation.requestId,
      provider: confirmation.provider,
      model: confirmation.model
    });
    sendJson(res, 200, { data: confirmation });
    return true;
  }

  return false;
}

function isLoopbackRequest(req) {
  const address = normalizeRemoteAddress(req.socket?.remoteAddress || "");
  return ["127.0.0.1", "::1", "localhost"].includes(address);
}

function normalizeRemoteAddress(address) {
  return String(address).replace(/^::ffff:/, "");
}

function readLocalVersion() {
  const versionPath = path.resolve(process.cwd(), "VERSION");
  if (!fs.existsSync(versionPath)) {
    return "0.0.0";
  }
  return fs.readFileSync(versionPath, "utf8").trim() || "0.0.0";
}

async function checkForUpdate() {
  const currentVersion = readLocalVersion();
  const release = await fetchLatestRelease();
  const latestVersion = normalizeVersion(release.tag_name || release.name || "");
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseUrl: release.html_url || `https://github.com/${REPO}/releases/latest`,
    assetName: findPortableAsset(release)?.name || "",
    publishedAt: release.published_at || "",
    notes: release.body || ""
  };
}

async function fetchLatestRelease() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "TinyGateway-Update-Checker"
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `Update check failed: ${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return body;
}

function findPortableAsset(release) {
  return (release.assets || []).find((asset) => asset.name === "TinyGateway-portable.zip" || /portable.*\.zip$/i.test(asset.name));
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "") || "0.0.0";
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = normalizeVersion(right).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) {
      return 1;
    }
    if ((a[index] || 0) < (b[index] || 0)) {
      return -1;
    }
  }
  return 0;
}

function buildAttackSimulationReport(entries) {
  const byRequest = new Map();
  for (const entry of [...entries].reverse()) {
    if (!entry.requestId) {
      continue;
    }
    const item = byRequest.get(entry.requestId) || {
      requestId: entry.requestId,
      ts: entry.ts,
      model: "",
      provider: "",
      upstreamModel: "",
      scenario: "",
      intensity: "",
      insertionStyle: "",
      safeMode: "",
      clientParameterized: false,
      reviews: [],
      decisions: [],
      status: "observed"
    };

    if (entry.event === "attack_simulation") {
      Object.assign(item, {
        ts: entry.ts || item.ts,
        model: entry.model || item.model,
        provider: entry.provider || item.provider,
        upstreamModel: entry.upstreamModel || item.upstreamModel,
        scenario: entry.scenario || item.scenario,
        intensity: entry.intensity || item.intensity,
        insertionStyle: entry.insertionStyle || item.insertionStyle,
        safeMode: entry.safeMode || item.safeMode,
        clientParameterized: Boolean(entry.clientParameterized)
      });
    }

    if (entry.review) {
      item.reviews.push({
        event: entry.event,
        risk: entry.review.risk,
        action: entry.review.action,
        categories: entry.review.categories || [],
        reason: entry.review.reason || ""
      });
    }

    if (entry.decision) {
      item.decisions.push({
        event: entry.event,
        outcome: entry.decision.outcome,
        reason: entry.decision.reason || "",
        statusCode: entry.decision.statusCode
      });
      item.status = entry.decision.outcome || item.status;
    } else if (entry.event === "response_blocked" || entry.event === "request_blocked") {
      item.status = "block";
    } else if (entry.event === "confirmation_created") {
      item.status = "confirm";
    }

    byRequest.set(entry.requestId, item);
  }

  return [...byRequest.values()]
    .filter((item) => item.scenario)
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

function sendStatic(res, fileName, sender) {
  const filePath = path.join(STATIC_DIR, fileName);
  if (!filePath.startsWith(STATIC_DIR) || !fs.existsSync(filePath)) {
    sendJson(res, 404, {
      error: {
        type: "not_found",
        message: "Admin asset not found."
      }
    });
    return;
  }

  sender(res, 200, fs.readFileSync(filePath, "utf8"));
}
