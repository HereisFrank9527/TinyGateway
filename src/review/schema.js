export const REVIEW_RISKS = ["low", "medium", "high", "critical"];
export const REVIEW_ACTIONS = ["allow", "audit", "confirm", "block", "redact"];
export const REVIEW_CATEGORIES = [
  "prompt_injection",
  "secret_exposure",
  "system_prompt_extraction",
  "sensitive_file_access",
  "dangerous_shell",
  "network_exfiltration",
  "dependency_risk",
  "git_risk",
  "cloud_risk",
  "privacy_risk",
  "policy_bypass",
  "unknown"
];

export function parseReviewResult(value) {
  const parsed = typeof value === "string" ? extractJsonObject(value) : value;
  return normalizeReviewResult(parsed);
}

export function extractJsonObject(text) {
  if (typeof text !== "string") {
    throw new Error("Reviewer output must be a string or object.");
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : sliceFirstJsonObject(trimmed);

  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("Reviewer returned invalid JSON.");
  }
}

function sliceFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Reviewer output does not contain a JSON object.");
  }
  return text.slice(start, end + 1);
}

export function normalizeReviewResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Review result must be a JSON object.");
  }

  const risk = result.risk || "low";
  if (!REVIEW_RISKS.includes(risk)) {
    throw new Error(`Invalid review risk: ${risk}`);
  }

  const action = result.action || "audit";
  if (!REVIEW_ACTIONS.includes(action)) {
    throw new Error(`Invalid review action: ${action}`);
  }

  const categories = Array.isArray(result.categories) ? result.categories : [];
  for (const category of categories) {
    if (!REVIEW_CATEGORIES.includes(category)) {
      throw new Error(`Invalid review category: ${category}`);
    }
  }

  const confidence = clampConfidence(result.confidence);
  const evidence = normalizeStringArray(result.evidence);
  const reason = typeof result.reason === "string" && result.reason.trim() ? result.reason.trim() : "No reason provided.";
  const requiresUserApproval =
    typeof result.requiresUserApproval === "boolean" ? result.requiresUserApproval : ["confirm", "block"].includes(action);
  const suggestedUserPrompt = typeof result.suggestedUserPrompt === "string" ? result.suggestedUserPrompt : "";
  const redactions = normalizeRedactions(result.redactions);

  return {
    risk,
    action,
    confidence,
    categories,
    reason,
    evidence,
    requiresUserApproval,
    suggestedUserPrompt,
    redactions
  };
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(1, number));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item)).filter(Boolean);
}

function normalizeRedactions(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const text = typeof item.text === "string" ? item.text : "";
      if (!text) {
        return null;
      }
      const redaction = {
        text,
        replacement: typeof item.replacement === "string" && item.replacement ? item.replacement : "[REDACTED]"
      };
      if (typeof item.path === "string" && item.path) {
        redaction.path = item.path;
      }
      return redaction;
    })
    .filter(Boolean);
}
