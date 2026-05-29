export function applyRedactions(upstream, review = {}) {
  const redactions = Array.isArray(review.redactions) ? review.redactions : [];
  if (!redactions.length || !upstream?.isJson || upstream.body === undefined) {
    return upstream;
  }

  let changed = false;
  const body = redactValue(upstream.body, redactions, () => {
    changed = true;
  });

  if (!changed) {
    return upstream;
  }

  return {
    ...upstream,
    body,
    rawText: JSON.stringify(body)
  };
}

function redactValue(value, redactions, markChanged) {
  if (typeof value === "string") {
    return redactString(value, redactions, markChanged);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactions, markChanged));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, redactions, markChanged)])
    );
  }

  return value;
}

function redactString(value, redactions, markChanged) {
  let output = value;
  for (const redaction of redactions) {
    const text = typeof redaction?.text === "string" ? redaction.text : "";
    if (!text || !output.includes(text)) {
      continue;
    }
    const replacement = typeof redaction.replacement === "string" && redaction.replacement ? redaction.replacement : "[REDACTED]";
    output = output.split(text).join(replacement);
  }
  if (output !== value) {
    markChanged();
  }
  return output;
}
