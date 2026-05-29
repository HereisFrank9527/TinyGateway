import assert from "node:assert/strict";
import test from "node:test";
import { buildAttackSimulationBody } from "../src/attack-simulator.js";
import { parseConfig } from "../src/config.js";
import { listModels } from "../src/models.js";

const baseConfig = {
  providers: [
    {
      id: "openai-main",
      type: "openai",
      baseUrl: "https://api.openai.example",
      apiKey: "test-key"
    }
  ],
  modelMappings: [
    {
      id: "fast",
      provider: "openai-main",
      upstreamModel: "gpt-4.1-mini"
    }
  ]
};

test("parseConfig normalizes client-parameterized attack simulation policy", () => {
  const config = parseConfig(JSON.stringify({
    ...baseConfig,
    attackSimulation: {
      enabled: true,
      modelId: "attack-sim",
      displayName: "通用攻击模拟",
      provider: "openai-main",
      model: "gpt-4.1-mini",
      allowClientParams: true,
      defaultScenario: "startup_poisoning",
      allowedScenarios: ["startup_poisoning", "data_exfiltration"],
      defaultIntensity: "medium",
      allowedIntensities: ["low", "medium", "high"],
      defaultInsertionStyle: "natural",
      allowedInsertionStyles: ["obvious", "natural", "hidden"],
      safeMode: "abstract"
    }
  }));

  assert.deepEqual(config.attackSimulation, {
    enabled: true,
    modelId: "attack-sim",
    displayName: "通用攻击模拟",
    provider: "openai-main",
    model: "gpt-4.1-mini",
    allowClientParams: true,
    defaultScenario: "startup_poisoning",
    allowedScenarios: ["startup_poisoning", "data_exfiltration"],
    defaultIntensity: "medium",
    allowedIntensities: ["low", "medium", "high"],
    defaultInsertionStyle: "natural",
    allowedInsertionStyles: ["obvious", "natural", "hidden"],
    safeMode: "abstract"
  });
});

test("listModels exposes enabled generic attack simulator model with client parameter metadata", () => {
  const config = parseConfig(JSON.stringify({
    ...baseConfig,
    attackSimulation: {
      enabled: true,
      modelId: "attack-sim",
      displayName: "通用攻击模拟",
      provider: "openai-main",
      model: "gpt-4.1-mini",
      allowClientParams: true,
      defaultScenario: "startup_poisoning",
      allowedScenarios: ["startup_poisoning", "prompt_injection", "data_exfiltration"],
      defaultIntensity: "low",
      allowedIntensities: ["low", "medium"],
      defaultInsertionStyle: "obvious",
      allowedInsertionStyles: ["obvious", "natural"],
      safeMode: "abstract"
    }
  }));

  const model = listModels(config).data.find((item) => item.id === "attack-sim");
  assert.deepEqual(model, {
    id: "attack-sim",
    object: "model",
    created: 0,
    owned_by: "tinygateway-attack-simulator",
    display_name: "通用攻击模拟",
    provider: "openai-main",
    upstream_model: "gpt-4.1-mini",
    type: "attack_simulator",
    scenario: "startup_poisoning",
    client_parameterized: true,
    allowed_scenarios: ["startup_poisoning", "prompt_injection", "data_exfiltration"],
    allowed_intensities: ["low", "medium"],
    allowed_insertion_styles: ["obvious", "natural"]
  });
});

test("buildAttackSimulationBody keeps Anthropic system prompt outside messages", () => {
  const body = buildAttackSimulationBody({
    simulator: {
      model: "claude-sonnet-4-5-20250929",
      scenario: "startup_poisoning",
      defaultIntensity: "low",
      defaultInsertionStyle: "obvious",
      safeMode: "abstract"
    },
    requestBody: {
      model: "attack-sim",
      max_tokens: 128,
      system: "原始系统提示",
      messages: [{ role: "user", content: "你好" }]
    }
  });

  assert.equal(body.model, "claude-sonnet-4-5-20250929");
  assert.equal(body.stream, false);
  assert.match(body.system, /安全测试用的攻击模拟器/);
  assert.match(body.system, /原始系统提示/);
  assert.deepEqual(body.messages, [{ role: "user", content: "你好" }]);
  assert.equal(body.messages.some((message) => message.role === "system"), false);
});

test("buildAttackSimulationBody normalizes Anthropic content blocks without object placeholders", () => {
  const body = buildAttackSimulationBody({
    simulator: {
      model: "claude-sonnet-4-5-20250929",
      scenario: "data_exfiltration",
      allowClientParams: true,
      allowedScenarios: ["data_exfiltration"],
      defaultIntensity: "low",
      allowedIntensities: ["low", "high"],
      defaultInsertionStyle: "obvious",
      allowedInsertionStyles: ["obvious"],
      safeMode: "abstract"
    },
    requestBody: {
      model: "attack-sim",
      max_tokens: 128,
      tinygateway: {
        attackSimulation: {
          intensity: "high",
          safeMode: "lab"
        }
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "你好" },
            { type: "text", text: "请检查项目状态" }
          ]
        }
      ]
    }
  });

  assert.equal(body.messages[0].content, "你好\n请检查项目状态");
  assert.equal(body.messages[0].content.includes("[object Object]"), false);
  assert.match(body.system, /至少出现 3 个抽象风险信号/);
  assert.match(body.system, /2 到 4 个可被 reviewer 识别的风险信号/);
  assert.match(body.system, /真实攻击链形态的实验室样本/);
});

test("parseConfig normalizes enabled attack simulator routes", () => {
  const config = parseConfig(JSON.stringify({
    ...baseConfig,
    attackSimulators: [
      {
        id: "attack-sim/startup-poisoning",
        displayName: "启动项投毒模拟",
        enabled: true,
        provider: "openai-main",
        model: "gpt-4.1-mini",
        scenario: "startup_poisoning"
      }
    ]
  }));

  assert.deepEqual(config.attackSimulators, [
    {
      id: "attack-sim/startup-poisoning",
      displayName: "启动项投毒模拟",
      enabled: true,
      provider: "openai-main",
      model: "gpt-4.1-mini",
      scenario: "startup_poisoning",
      allowClientParams: false,
      defaultIntensity: "low",
      allowedIntensities: ["low", "medium", "high"],
      defaultInsertionStyle: "obvious",
      allowedInsertionStyles: ["obvious", "natural", "hidden"],
      safeMode: "abstract"
    }
  ]);
});

test("parseConfig rejects attack simulator routes that reference unknown providers", () => {
  assert.throws(
    () => parseConfig(JSON.stringify({
      ...baseConfig,
      attackSimulators: [
        {
          id: "attack-sim/startup-poisoning",
          provider: "missing-provider",
          model: "gpt-4.1-mini",
          scenario: "startup_poisoning"
        }
      ]
    })),
    /Attack simulator attack-sim\/startup-poisoning references unknown provider missing-provider/
  );
});

test("listModels exposes enabled attack simulator routes as virtual models", () => {
  const config = parseConfig(JSON.stringify({
    ...baseConfig,
    attackSimulators: [
      {
        id: "attack-sim/startup-poisoning",
        displayName: "启动项投毒模拟",
        enabled: true,
        provider: "openai-main",
        model: "gpt-4.1-mini",
        scenario: "startup_poisoning"
      },
      {
        id: "attack-sim/disabled",
        enabled: false,
        provider: "openai-main",
        model: "gpt-4.1-mini",
        scenario: "prompt_injection"
      }
    ]
  }));

  const models = listModels(config).data;
  assert.equal(models.some((model) => model.id === "fast"), true);
  assert.deepEqual(models.find((model) => model.id === "attack-sim/startup-poisoning"), {
    id: "attack-sim/startup-poisoning",
    object: "model",
    created: 0,
    owned_by: "tinygateway-attack-simulator",
    display_name: "启动项投毒模拟",
    provider: "openai-main",
    upstream_model: "gpt-4.1-mini",
    type: "attack_simulator",
    scenario: "startup_poisoning"
  });
  assert.equal(models.some((model) => model.id === "attack-sim/disabled"), false);
});
