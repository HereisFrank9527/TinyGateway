import fs from "node:fs";
import path from "node:path";

export class AuditLog {
  constructor(config) {
    this.configure(config);
  }

  configure(config) {
    this.enabled = config.audit.enabled;
    this.directory = path.resolve(process.cwd(), config.audit.directory);
    this.filePath = path.join(this.directory, "audit.jsonl");
    this.retentionHours = normalizePositiveNumber(config.audit.retentionHours, 48);
    this.maxSizeBytes = normalizePositiveNumber(config.audit.maxSizeMb, 20) * 1024 * 1024;

    if (this.enabled) {
      fs.mkdirSync(this.directory, { recursive: true });
      this.prune();
    }
  }

  write(event) {
    if (!this.enabled) {
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      ...event
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    this.prune();
  }

  readRecent(limit = 100) {
    if (!this.enabled || !fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return [];
    }

    return raw
      .split("\n")
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 500)))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { malformed: true, raw: line };
        }
      })
      .reverse();
  }

  prune() {
    if (!this.enabled || !fs.existsSync(this.filePath)) {
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    if (!raw.trim()) {
      return;
    }

    const cutoffMs = Date.now() - this.retentionHours * 60 * 60 * 1000;
    const retainedByAge = raw
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        try {
          const entry = JSON.parse(line);
          const ts = Date.parse(entry.ts);
          return !Number.isFinite(ts) || ts >= cutoffMs;
        } catch {
          return true;
        }
      });

    const retainedBySize = [];
    let totalBytes = 0;
    for (let index = retainedByAge.length - 1; index >= 0; index -= 1) {
      const line = retainedByAge[index];
      const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (retainedBySize.length > 0 && totalBytes + lineBytes > this.maxSizeBytes) {
        break;
      }
      retainedBySize.push(line);
      totalBytes += lineBytes;
    }

    const nextRaw = retainedBySize.reverse().map((line) => `${line}\n`).join("");
    if (nextRaw !== raw) {
      fs.writeFileSync(this.filePath, nextRaw, "utf8");
    }
  }
}

function normalizePositiveNumber(value, defaultValue) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : defaultValue;
}
