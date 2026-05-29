import fs from "node:fs";
import path from "node:path";
import { KNOWN_ATTACK_SCENARIOS } from "./attack-simulator.js";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config.json");

export function loadConfig(configPath = process.env.TINYGATEWAY_CONFIG || DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}. Create or restore config.json.`);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  validateConfig(config);
  return normalizeConfig(config);
}

export function parseConfig(raw) {
  const config = JSON.parse(raw);
  validateConfig(config);
  return normalizeConfig(config);
}

export function validateAndNormalizeConfig(config) {
  validateConfig(config);
  return normalizeConfig(config);
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Config must be a JSON object.");
  }
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    throw new Error("Config must define at least one provider.");
  }
  const providerIds = new Set();
  for (const provider of config.providers) {
    if (!provider.id || !provider.type || !provider.baseUrl) {
      throw new Error("Each provider requires id, type, and baseUrl.");
    }
    providerIds.add(provider.id);
    if (!["anthropic", "openai"].includes(provider.type)) {
      throw new Error(`Unsupported provider type: ${provider.type}`);
    }
    if (!provider.apiKey && !provider.apiKeyEnv) {
      throw new Error(`Provider ${provider.id} requires apiKey or apiKeyEnv.`);
    }
    if (provider.models && !Array.isArray(provider.models)) {
      throw new Error(`Provider ${provider.id} models must be an array.`);
    }
  }

  if (config.modelMappings !== undefined && !Array.isArray(config.modelMappings)) {
    throw new Error("modelMappings must be an array.");
  }
  if (config.attackSimulators !== undefined && !Array.isArray(config.attackSimulators)) {
    throw new Error("attackSimulators must be an array.");
  }
  if (config.attackSimulation !== undefined) {
    if (!config.attackSimulation || typeof config.attackSimulation !== "object" || Array.isArray(config.attackSimulation)) {
      throw new Error("attackSimulation must be an object.");
    }
    if (config.attackSimulation.enabled !== false) {
      if (!config.attackSimulation.provider || !config.attackSimulation.model) {
        throw new Error("attackSimulation requires provider and model when enabled.");
      }
      if (!providerIds.has(config.attackSimulation.provider)) {
        throw new Error(`Attack simulation references unknown provider ${config.attackSimulation.provider}.`);
      }
    }
  }
  for (const simulator of config.attackSimulators || []) {
    if (!simulator.id || !simulator.provider || !simulator.model || !simulator.scenario) {
      throw new Error("Each attack simulator requires id, provider, model, and scenario.");
    }
    if (!providerIds.has(simulator.provider)) {
      throw new Error(`Attack simulator ${simulator.id} references unknown provider ${simulator.provider}.`);
    }
  }
  if (
    (!config.modelMappings || config.modelMappings.length === 0) &&
    !config.providers.some((provider) => Array.isArray(provider.models) && provider.models.length > 0)
  ) {
    throw new Error("Config must define modelMappings or provider models.");
  }
  for (const mapping of config.modelMappings || []) {
    if (!mapping.id || !mapping.provider || !mapping.upstreamModel) {
      throw new Error("Each model mapping requires id, provider, and upstreamModel.");
    }
    if (!providerIds.has(mapping.provider)) {
      throw new Error(`Model mapping ${mapping.id} references unknown provider ${mapping.provider}.`);
    }
  }
}

function normalizeConfig(config) {
  return {
    server: {
      host: config.server?.host || "127.0.0.1",
      port: Number(config.server?.port || 8787)
    },
    audit: {
      enabled: config.audit?.enabled !== false,
      directory: config.audit?.directory || "logs",
      retentionHours: normalizePositiveNumber(config.audit?.retentionHours, 48),
      maxSizeMb: normalizePositiveNumber(config.audit?.maxSizeMb, 20)
    },
    reviewer: normalizeReviewerConfig(config.reviewer),
    attackSimulation: normalizeAttackSimulationConfig(config.attackSimulation),
    attackSimulators: (config.attackSimulators || []).map((simulator) => ({
      id: simulator.id,
      displayName: simulator.displayName || simulator.id,
      enabled: simulator.enabled !== false,
      provider: simulator.provider,
      model: simulator.model,
      scenario: simulator.scenario,
      allowClientParams: Boolean(simulator.allowClientParams),
      defaultIntensity: normalizeChoice(simulator.defaultIntensity, ["low", "medium", "high"], "low"),
      allowedIntensities: normalizeArray(simulator.allowedIntensities, ["low", "medium", "high"]),
      defaultInsertionStyle: normalizeChoice(simulator.defaultInsertionStyle, ["obvious", "natural", "hidden"], "obvious"),
      allowedInsertionStyles: normalizeArray(simulator.allowedInsertionStyles, ["obvious", "natural", "hidden"]),
      safeMode: simulator.safeMode || "abstract"
    })),
    modelMappings: (config.modelMappings || []).map((mapping) => ({
      ...mapping,
      aliases: mapping.aliases || [],
      enabled: mapping.enabled !== false
    })),
    providers: config.providers.map((provider) => ({
      id: provider.id,
      type: provider.type,
      baseUrl: provider.baseUrl.replace(/\/+$/, ""),
      apiKey: provider.apiKey,
      apiKeyEnv: provider.apiKeyEnv,
      anthropicVersion: provider.anthropicVersion,
      anthropicBeta: provider.anthropicBeta,
      models: (provider.models || []).map((model) => ({
        ...model,
        aliases: model.aliases || []
      }))
    }))
  };
}

function normalizeAttackSimulationConfig(attackSimulation = {}) {
  const enabled = attackSimulation?.enabled === true;
  const allowedScenarios = normalizeArray(attackSimulation?.allowedScenarios, KNOWN_ATTACK_SCENARIOS);
  const allowedIntensities = normalizeArray(attackSimulation?.allowedIntensities, ["low", "medium", "high"]);
  const allowedInsertionStyles = normalizeArray(attackSimulation?.allowedInsertionStyles, ["obvious", "natural", "hidden"]);
  return {
    enabled,
    modelId: attackSimulation?.modelId || "attack-sim",
    displayName: attackSimulation?.displayName || "通用攻击模拟",
    provider: attackSimulation?.provider || "",
    model: attackSimulation?.model || "",
    allowClientParams: Boolean(attackSimulation?.allowClientParams),
    defaultScenario: normalizeChoice(attackSimulation?.defaultScenario, allowedScenarios, allowedScenarios[0] || "startup_poisoning"),
    allowedScenarios,
    defaultIntensity: normalizeChoice(attackSimulation?.defaultIntensity, allowedIntensities, allowedIntensities[0] || "low"),
    allowedIntensities,
    defaultInsertionStyle: normalizeChoice(
      attackSimulation?.defaultInsertionStyle,
      allowedInsertionStyles,
      allowedInsertionStyles[0] || "obvious"
    ),
    allowedInsertionStyles,
    safeMode: attackSimulation?.safeMode || "abstract"
  };
}

function normalizeReviewerConfig(reviewer = {}) {
  return {
    enabled: Boolean(reviewer?.enabled),
    mode: ["off", "audit", "guard", "full"].includes(reviewer?.mode) ? reviewer.mode : "off",
    context: ["response", "full"].includes(reviewer?.context) ? reviewer.context : "response",
    outboundReview: ["off", "audit", "guard"].includes(reviewer?.outboundReview) ? reviewer.outboundReview : "off",
    provider: reviewer?.provider || "",
    model: reviewer?.model || "",
    timeoutMs: Number(reviewer?.timeoutMs || 12000),
    failBehavior: ["allow", "audit", "block"].includes(reviewer?.failBehavior) ? reviewer.failBehavior : "allow",
    holdTimeoutMs: normalizePositiveNumber(reviewer?.holdTimeoutMs, 120000),
    confirmBehavior: ["allow", "block", "queue", "retry", "hold"].includes(reviewer?.confirmBehavior)
      ? reviewer.confirmBehavior
      : "queue"
  };
}

export function normalizeReviewerRuntimeConfig(reviewer = {}) {
  const mode = ["off", "audit", "guard", "full"].includes(reviewer.mode) ? reviewer.mode : "off";
  const runtime = {
    enabled: Boolean(reviewer.enabled),
    mode,
    context: ["response", "full"].includes(reviewer.context) ? reviewer.context : "response",
    outboundReview: ["off", "audit", "guard"].includes(reviewer.outboundReview) ? reviewer.outboundReview : "off",
    confirmBehavior: ["allow", "block", "queue", "retry", "hold"].includes(reviewer.confirmBehavior) ? reviewer.confirmBehavior : "queue",
    holdTimeoutMs: normalizePositiveNumber(reviewer.holdTimeoutMs, 120000),
    failBehavior: ["allow", "audit", "block"].includes(reviewer.failBehavior) ? reviewer.failBehavior : "allow"
  };

  if (runtime.mode === "full") {
    return {
      ...runtime,
      mode: "guard",
      context: "full",
      outboundReview: "guard"
    };
  }

  if (!runtime.enabled) {
    return {
      ...runtime,
      mode: "off",
      context: runtime.context,
      outboundReview: "off"
    };
  }

  return runtime;
}

function normalizePositiveNumber(value, defaultValue) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : defaultValue;
}

function normalizeArray(value, defaultValue) {
  if (!Array.isArray(value) || value.length === 0) {
    return [...defaultValue];
  }
  const normalized = value.map((item) => String(item).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [...defaultValue];
}

function normalizeChoice(value, allowedValues, defaultValue) {
  return allowedValues.includes(value) ? value : defaultValue;
}

export function getProviderApiKey(provider) {
  if (provider.apiKey) {
    return provider.apiKey;
  }
  const value = process.env[provider.apiKeyEnv];
  if (!value) {
    throw new Error(`Missing environment variable ${provider.apiKeyEnv} for provider ${provider.id}.`);
  }
  return value;
}

export function sanitizeConfig(config) {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? maskSecret(provider.apiKey) : undefined,
      apiKeyEnv: provider.apiKeyEnv,
      hasApiKey: Boolean(provider.apiKey || provider.apiKeyEnv)
    }))
  };
}

export function mergeSanitizedConfig(currentConfig, incomingConfig) {
  const currentProviders = new Map(currentConfig.providers.map((provider) => [provider.id, provider]));
  const merged = structuredClone(incomingConfig);

  merged.providers = (merged.providers || []).map((provider) => {
    const current = currentProviders.get(provider.id);
    if (current?.apiKey && isMaskedSecret(provider.apiKey)) {
      return {
        ...provider,
        apiKey: current.apiKey
      };
    }
    return provider;
  });

  return merged;
}

function maskSecret(value) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isMaskedSecret(value) {
  return typeof value === "string" && (value.includes("*") || value.includes("..."));
}

export function buildModelIndex(config) {
  const index = new Map();
  const providers = new Map(config.providers.map((provider) => [provider.id, provider]));

  addGenericAttackSimulationModel(index, providers, config.attackSimulation);

  if (config.modelMappings.length > 0) {
    for (const mapping of config.modelMappings) {
      if (!mapping.enabled) {
        continue;
      }

      const provider = providers.get(mapping.provider);
      const model = {
        id: mapping.id,
        displayName: mapping.displayName || mapping.id,
        upstreamId: mapping.upstreamModel,
        aliases: mapping.aliases,
        mapping
      };

      index.set(model.id, { provider, model });
      for (const alias of model.aliases) {
        index.set(alias, { provider, model });
      }
    }

    addAttackSimulatorModels(index, providers, config.attackSimulators || []);
    return index;
  }

  for (const provider of config.providers) {
    for (const model of provider.models) {
      index.set(model.id, { provider, model });
      for (const alias of model.aliases) {
        index.set(alias, { provider, model });
      }
    }
  }

  addAttackSimulatorModels(index, providers, config.attackSimulators || []);
  return index;
}

function addGenericAttackSimulationModel(index, providers, attackSimulation) {
  if (!attackSimulation?.enabled) {
    return;
  }
  const provider = providers.get(attackSimulation.provider);
  if (!provider) {
    return;
  }
  index.set(attackSimulation.modelId, {
    provider,
    model: {
      id: attackSimulation.modelId,
      displayName: attackSimulation.displayName || attackSimulation.modelId,
      upstreamId: attackSimulation.model,
      aliases: [],
      attackSimulator: {
        ...attackSimulation,
        id: attackSimulation.modelId,
        scenario: attackSimulation.defaultScenario
      }
    }
  });
}

function addAttackSimulatorModels(index, providers, attackSimulators) {
  for (const simulator of attackSimulators) {
    if (!simulator.enabled) {
      continue;
    }
    const provider = providers.get(simulator.provider);
    const model = {
      id: simulator.id,
      displayName: simulator.displayName || simulator.id,
      upstreamId: simulator.model,
      aliases: [],
      attackSimulator: simulator
    };
    if (!index.has(model.id)) {
      index.set(model.id, { provider, model });
    }
  }
}
