export function renderConfirmationEntries(entries) {
  return (
    entries
      .map((entry) => {
        const review = entry.review || {};
        const categories = review.categories?.length ? ` / ${review.categories.join(", ")}` : "";
        const actions =
          entry.status === "pending"
            ? `<div class="actions inline-actions">
                <button class="primary" data-confirmation-allow="${escapeAttr(entry.id)}">\u5141\u8bb8\u91cd\u8bd5</button>
                <button class="danger" data-confirmation-block="${escapeAttr(entry.id)}">\u963b\u65ad</button>
              </div>`
            : "";
        return `
          <article class="confirmation-entry status-${escapeAttr(entry.status || "unknown")}">
            <div class="item-head">
              <div>
                <div class="item-title">${escapeHtml(entry.id)}</div>
                <div>${escapeHtml(entry.status || "unknown")} / ${escapeHtml(entry.direction || "unknown")} / ${escapeHtml(entry.endpoint || "")} / ${escapeHtml(entry.provider || "")} / ${escapeHtml(entry.model || "")}</div>
              </div>
              <span class="confirmation-status">${escapeHtml(entry.status || "unknown")}</span>
            </div>
            <div class="review-details">
              <div><strong>\u68c0\u67e5:</strong> ${escapeHtml(review.risk || "unknown")} / ${escapeHtml(review.action || "unknown")}${escapeHtml(categories)}</div>
              ${review.reason ? `<div><strong>\u539f\u56e0:</strong> ${escapeHtml(review.reason)}</div>` : ""}
              ${review.suggestedUserPrompt ? `<div><strong>\u63d0\u793a:</strong> ${escapeHtml(review.suggestedUserPrompt)}</div>` : ""}
              ${entry.requestId ? `<div><strong>\u8bf7\u6c42:</strong> ${escapeHtml(entry.requestId)}</div>` : ""}
              ${entry.upstreamModel ? `<div><strong>\u4e0a\u6e38:</strong> ${escapeHtml(entry.upstreamModel)}</div>` : ""}
              ${entry.createdAt ? `<div><strong>\u521b\u5efa\u65f6\u95f4:</strong> ${escapeHtml(entry.createdAt)}</div>` : ""}
            </div>
            ${entry.requestSummary?.rawText ? `<pre><strong>\u8bf7\u6c42</strong>\n${escapeHtml(entry.requestSummary.rawText)}</pre>` : ""}
            ${entry.responseSummary?.rawText ? `<pre><strong>\u54cd\u5e94</strong>\n${escapeHtml(entry.responseSummary.rawText)}</pre>` : ""}
            ${actions}
          </article>
        `;
      })
      .join("") || "<p>\u6682\u65e0\u786e\u8ba4\u9879</p>"
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
