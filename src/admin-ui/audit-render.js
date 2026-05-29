export function renderAuditEntries(entries) {
  return (
    entries
      .map((entry) => {
        const blocked = entry.review?.action === "block" || entry.statusCode === 403 || entry.statusCode === 502;
        const riskClass = getRiskClass(entry);
        const summary = getAuditSummary(entry);
        return `
          <article class="audit-entry ${blocked ? "blocked" : ""} ${riskClass}">
            <div class="audit-meta">
              <span>${escapeHtml(entry.ts || "")}</span>
              <span>${escapeHtml(entry.event || "")}</span>
              <span>${escapeHtml(entry.endpoint || entry.url || "")}</span>
              <span>${escapeHtml(entry.provider || "")}</span>
              <span>${escapeHtml(entry.model || entry.requestedModel || "")}</span>
            </div>
            ${summary ? `<div class="audit-summary">${escapeHtml(summary)}</div>` : ""}
            ${renderReviewDetails(entry.review, entry.decision)}
            <pre>${escapeHtml(JSON.stringify(entry.review || entry.decision || entry.message || entry, null, 2))}</pre>
          </article>
        `;
      })
      .join("") || "<p>\u6682\u65e0\u5ba1\u8ba1\u8bb0\u5f55</p>"
  );
}

export function getRiskClass(entry) {
  const risk = entry?.review?.risk;
  return ["low", "medium", "high", "critical"].includes(risk) ? `risk-${risk}` : "";
}

export function getAuditSummary(entry) {
  if (entry.event === "review_decision" && entry.decision) {
    const reviewSummary = entry.review ? ` / ${formatReviewSummary(entry.review)}` : "";
    return `guard ${entry.decision.outcome} / ${entry.decision.reason}${reviewSummary}`;
  }
  if (entry.event === "review_result" && entry.review) {
    return formatReviewSummary(entry.review);
  }
  if (entry.event === "review_error") {
    return `review_error / ${entry.message || "unknown error"}`;
  }
  return entry.statusCode ? `status ${entry.statusCode}` : entry.message || "";
}

function formatReviewSummary(review) {
  const categories = review.categories?.length ? ` / ${review.categories.join(", ")}` : "";
  return `${review.risk} / ${review.action}${categories}`;
}

function renderReviewDetails(review, decision) {
  if (!review && !decision) {
    return "";
  }
  const evidence = Array.isArray(review?.evidence) && review.evidence.length
    ? `<ul class="audit-evidence">${review.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="review-details">
      ${decision ? `<div><strong>\u51b3\u7b56:</strong> ${escapeHtml(decision.outcome || "")}${decision.reason ? ` / ${escapeHtml(decision.reason)}` : ""}</div>` : ""}
      ${review ? `<div><strong>\u539f\u56e0:</strong> ${escapeHtml(review.reason || "")}</div>` : ""}
      ${review?.requiresUserApproval ? `<div><strong>\u7528\u6237\u786e\u8ba4:</strong> \u9700\u8981</div>` : ""}
      ${review?.suggestedUserPrompt ? `<div><strong>\u63d0\u793a:</strong> ${escapeHtml(review.suggestedUserPrompt)}</div>` : ""}
      ${evidence}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
