import fs from "node:fs";
import path from "node:path";
import { buildModelIndex, loadConfig, mergeSanitizedConfig, sanitizeConfig, validateAndNormalizeConfig } from "./config.js";

export class ConfigStore {
  constructor(configPath = process.env.TINYGATEWAY_CONFIG || path.resolve(process.cwd(), "config.json")) {
    this.configPath = configPath;
    this.lastMtimeMs = 0;
    this.lastError = null;
    this.reload({ required: true });
  }

  current() {
    this.reload({ required: false });
    return {
      config: this.config,
      modelIndex: this.modelIndex,
      lastError: this.lastError
    };
  }

  publicConfig() {
    return sanitizeConfig(this.current().config);
  }

  save(incomingConfig) {
    const merged = mergeSanitizedConfig(this.current().config, incomingConfig);
    const normalized = validateAndNormalizeConfig(merged);
    const pretty = `${JSON.stringify(normalized, null, 2)}\n`;
    const tempPath = `${this.configPath}.tmp`;

    fs.writeFileSync(tempPath, pretty, "utf8");
    fs.renameSync(tempPath, this.configPath);

    this.lastMtimeMs = 0;
    this.reload({ required: true });

    return sanitizeConfig(this.config);
  }

  saveProviderModels(providerId, models) {
    const nextConfig = structuredClone(this.current().config);
    const provider = nextConfig.providers.find((item) => item.id === providerId);
    if (!provider) {
      const error = new Error(`Unknown provider: ${providerId}`);
      error.statusCode = 404;
      throw error;
    }

    provider.models = models;
    return this.save(nextConfig);
  }

  reload({ required }) {
    const stat = fs.statSync(this.configPath);
    if (!required && stat.mtimeMs === this.lastMtimeMs) {
      return;
    }

    try {
      const config = loadConfig(this.configPath);
      this.config = config;
      this.modelIndex = buildModelIndex(config);
      this.lastMtimeMs = stat.mtimeMs;
      this.lastError = null;
    } catch (error) {
      this.lastError = error;
      if (required || !this.config) {
        throw error;
      }
    }
  }
}
