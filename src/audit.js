import fs from "node:fs";
import path from "node:path";

export class AuditLog {
  constructor(config) {
    this.enabled = config.audit.enabled;
    this.directory = path.resolve(process.cwd(), config.audit.directory);
    this.filePath = path.join(this.directory, "audit.jsonl");

    if (this.enabled) {
      fs.mkdirSync(this.directory, { recursive: true });
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
}
