import { renderAuditEntries } from "./audit-render.js";
import { renderConfirmationEntries } from "./confirmation-render.js";

let config = null;
let models = [];
let confirmations = [];
let attackReport = [];
const openCards = new Set();

const $ = (selector) => document.querySelector(selector);
const text = {
  refreshed: "\u5df2\u5237\u65b0",
  running: "\u8fd0\u884c\u4e2d",
  configError: "\u914d\u7f6e\u9519\u8bef",
  valid: "\u6709\u6548",
  fetchModels: "\u83b7\u53d6\u6a21\u578b",
  delete: "\u5220\u9664",
  type: "\u7c7b\u578b",
  apiKeyPlaceholder: "\u5df2\u8131\u654f\u6216\u7559\u7a7a",
  saveProvider: "\u4fdd\u5b58 Provider",
  noSavedModels: "\u6682\u65e0\u5df2\u4fdd\u5b58\u6a21\u578b",
  manualModels: "支持模型列表（每行一个模型 ID）",
  localModel: "\u672c\u5730\u6a21\u578b\u540d",
  displayName: "\u663e\u793a\u540d",
  upstreamModel: "上游实际模型",
  attackSimModel: "客户端虚拟模型名",
  scenario: "模拟场景",
  saveAttackSimulator: "保存攻击模拟",
  attackScenarioStartupPoisoning: "startup_poisoning：启动项投毒模拟",
  attackScenarioPromptInjection: "prompt_injection：提示词注入模拟",
  attackScenarioDataExfiltration: "data_exfiltration：数据外传模拟",
  genericAttackSimulation: "通用攻击模拟",
  saveAttackSimulation: "保存通用攻击模拟",
  modelId: "客户端虚拟模型名",
  allowClientParams: "允许客户端参数",
  defaultScenario: "默认场景",
  defaultIntensity: "默认强度",
  allowedScenarios: "允许场景（每行一个）",
  allowedIntensities: "允许强度（每行一个）",
  defaultInsertionStyle: "默认插入方式",
  allowedInsertionStyles: "允许插入方式（每行一个）",
  safeMode: "安全模式",
  aliases: "Aliases\uff0c\u6bcf\u884c\u4e00\u4e2a",
  enabled: "\u542f\u7528",
  disabled: "\u7981\u7528",
  saveMapping: "\u4fdd\u5b58\u6620\u5c04",
  providerStillUsed: "Provider \u4ecd\u88ab\u6a21\u578b\u6620\u5c04\u4f7f\u7528",
  fetchingModels: "\u6b63\u5728\u83b7\u53d6\u6a21\u578b",
  savedModels: "\u5df2\u4fdd\u5b58\u6a21\u578b",
  saved: "\u5df2\u4fdd\u5b58",
  requestFailed: "\u8bf7\u6c42\u5931\u8d25",
  confirmation: "\u786e\u8ba4\u9879",
  allowed: "\u5df2\u653e\u884c",
  blocked: "\u5df2\u963b\u65ad"
};

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindActions();
  refreshAll();
});

function bindTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      $(`#${button.dataset.tab}`).classList.add("active");
    });
  });
}

function bindActions() {
  $("#refreshAll").addEventListener("click", refreshAll);
  $("#refreshAudit").addEventListener("click", loadAudit);
  $("#saveAuditSettings").addEventListener("click", saveAuditSettings);
  $("#refreshConfirmations").addEventListener("click", loadConfirmations);
  $("#refreshAttackReport").addEventListener("click", loadAttackReport);
  $("#saveRaw").addEventListener("click", saveRawConfig);
  $("#addProvider").addEventListener("click", addProvider);
  $("#addMapping").addEventListener("click", addMapping);
  $("#addAttackSimulator").addEventListener("click", addAttackSimulator);
  $("#saveReviewer").addEventListener("click", saveReviewer);
}

async function refreshAll() {
  try {
    await Promise.all([loadStatus(), loadConfig(), loadModels(), loadAudit(), loadConfirmations(), loadAttackReport(), checkUpdate()]);
    render();
    toast(text.refreshed);
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadStatus() {
  const status = await apiGet("/api/admin/status");
  $("#statusBadge").textContent = status.ok ? text.running : text.configError;
  $("#statusBadge").classList.toggle("bad", !status.ok);
  $("#gatewayAddress").textContent = status.address || "-";
  $("#providerCount").textContent = status.providerCount;
  $("#modelCount").textContent = status.modelCount;
  $("#configState").textContent = status.ok ? text.valid : status.configError;
  $("#currentVersion").textContent = status.version || "-";
}

async function loadConfig() {
  config = await apiGet("/api/admin/config");
}

async function loadModels() {
  const result = await apiGet("/api/admin/models");
  models = result.data || [];
}

async function loadAudit() {
  const result = await apiGet("/api/admin/audit?limit=100");
  renderAudit(result.data || []);
}

async function loadConfirmations() {
  const result = await apiGet("/api/admin/confirmations");
  confirmations = result.data || [];
  renderConfirmations();
}

async function loadAttackReport() {
  const result = await apiGet("/api/admin/attack-simulations/report?limit=500");
  attackReport = result.data || [];
  renderAttackReport();
}

async function checkUpdate() {
  const node = $("#updateState");
  if (!node) {
    return;
  }
  try {
    const result = await apiGet("/api/admin/update/check");
    if (result.updateAvailable) {
      node.innerHTML = `<a href="${escapeAttr(result.releaseUrl)}" target="_blank" rel="noreferrer">可更新到 ${escapeHtml(result.latestVersion)}</a>`;
      return;
    }
    node.textContent = `已是最新 ${result.currentVersion}`;
  } catch (error) {
    node.textContent = "检查失败";
    node.title = error.message;
  }
}

function render() {
  renderVisibleModels();
  renderProviders();
  renderMappings();
  renderAttackSimulation();
  renderAttackSimulators();
  renderAttackReport();
  renderAuditSettings();
  renderReviewer();
  $("#rawConfig").value = JSON.stringify(config, null, 2);
}

function renderVisibleModels() {
  $("#visibleModels").innerHTML = models
    .map(
      (model) => `
        <tr>
          <td>${escapeHtml(model.id)}</td>
          <td>${escapeHtml(model.display_name || "")}</td>
          <td>${escapeHtml(model.provider || model.owned_by || "")}</td>
          <td>${escapeHtml(model.upstream_model || "")}</td>
        </tr>
      `
    )
    .join("");
}

function renderProviders() {
  $("#providersList").innerHTML = config.providers
    .map(
      (provider, index) => `
        <article class="item ${isCardOpen("provider", provider.id, index) ? "is-open" : ""}" data-provider-index="${index}">
          <div class="item-head">
            <div class="item-head-main">
              <div class="item-title">${escapeHtml(provider.id)}</div>
              <div class="item-meta">${escapeHtml(provider.type)} -> ${escapeHtml(provider.baseUrl)} · ${(provider.models || []).length} 个已保存模型</div>
            </div>
            <div class="actions inline-actions">
              <button class="collapse-toggle" data-toggle-card="provider:${index}">${isCardOpen("provider", provider.id, index) ? "收起" : "展开"}</button>
              <button data-fetch-provider-models="${index}">${text.fetchModels}</button>
              <button class="danger" data-remove-provider="${index}">${text.delete}</button>
            </div>
          </div>
          <div class="item-body">
            <div class="form-grid">
              <label>ID<input data-provider-field="id" value="${escapeAttr(provider.id)}"></label>
              <label>${text.type}
                <select data-provider-field="type">
                  <option value="anthropic" ${provider.type === "anthropic" ? "selected" : ""}>anthropic</option>
                  <option value="openai" ${provider.type === "openai" ? "selected" : ""}>openai</option>
                </select>
              </label>
              <label>Base URL<input data-provider-field="baseUrl" value="${escapeAttr(provider.baseUrl)}"></label>
              <label>API Key<input data-provider-field="apiKey" value="${escapeAttr(provider.apiKey || "")}" placeholder="${text.apiKeyPlaceholder}"></label>
              <label>${text.manualModels}<textarea data-provider-models rows="6">${escapeHtml((provider.models || []).map((model) => model.id).join("\n"))}</textarea></label>
            </div>
            <p class="field-note">获取模型失败的中转站，可以在这里手动维护支持模型列表；保存后模型映射、攻击模拟和检查模型都会用它生成下拉选择。</p>
            <div class="actions">
              <button class="primary" data-save-provider="${index}">${text.saveProvider}</button>
            </div>
            <div class="model-chips">
              ${(provider.models || []).map((model) => `<span>${escapeHtml(model.id)}</span>`).join("") || `<em>${text.noSavedModels}</em>`}
            </div>
          </div>
        </article>
      `
    )
    .join("");

  bindCardToggles();
  document.querySelectorAll("[data-save-provider]").forEach((button) => {
    button.addEventListener("click", () => saveProvider(Number(button.dataset.saveProvider)));
  });
  document.querySelectorAll("[data-remove-provider]").forEach((button) => {
    button.addEventListener("click", () => removeProvider(Number(button.dataset.removeProvider)));
  });
  document.querySelectorAll("[data-fetch-provider-models]").forEach((button) => {
    button.addEventListener("click", () => fetchAndSaveProviderModels(Number(button.dataset.fetchProviderModels)));
  });
}

function renderMappings() {
  $("#mappingsList").innerHTML = config.modelMappings
    .map((mapping, index) => renderMappingCard(mapping, index))
    .join("");

  bindCardToggles();
  config.modelMappings.forEach((mapping, index) => {
    const select = document.querySelector(`[data-mapping-index="${index}"] [data-mapping-field="provider"]`);
    if (select) {
      select.value = mapping.provider;
    }
    const upstream = document.querySelector(`[data-mapping-index="${index}"] [data-mapping-field="upstreamModel"]`);
    if (upstream) {
      upstream.value = mapping.upstreamModel;
    }
  });
  document.querySelectorAll("[data-save-mapping]").forEach((button) => {
    button.addEventListener("click", () => saveMapping(Number(button.dataset.saveMapping)));
  });
  document.querySelectorAll("[data-remove-mapping]").forEach((button) => {
    button.addEventListener("click", () => removeMapping(Number(button.dataset.removeMapping)));
  });
  document.querySelectorAll("[data-provider-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const index = Number(select.dataset.providerSelect);
      const provider = config.providers.find((item) => item.id === select.value);
      config.modelMappings[index].provider = select.value;
      if (provider?.models?.length) {
        config.modelMappings[index].upstreamModel = provider.models[0].id;
      }
      renderMappings();
    });
  });
}

function renderMappingCard(mapping, index) {
  const providerOptions = config.providers
    .map((provider) => `<option value="${escapeAttr(provider.id)}">${escapeHtml(provider.id)}</option>`)
    .join("");
  const provider = config.providers.find((item) => item.id === mapping.provider) || config.providers[0];
  const savedModels = provider?.models || [];
  const modelOptions = savedModels
    .map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.id)}</option>`)
    .join("");
  const upstreamControl =
    savedModels.length > 0
      ? `<select data-mapping-field="upstreamModel">${modelOptions}</select>`
      : `<input data-mapping-field="upstreamModel" list="provider-models-${index}" value="${escapeAttr(mapping.upstreamModel)}">
         <p class="field-note">这个 Provider 还没有保存模型列表。先点 Provider 里的“获取模型”，这里就会变成下拉选择。</p>`;

  return `
    <article class="item ${isCardOpen("mapping", mapping.id, index) ? "is-open" : ""}" data-mapping-index="${index}">
      <div class="item-head">
        <div class="item-head-main">
          <div class="item-title">${escapeHtml(mapping.id)}</div>
          <div class="item-meta">${escapeHtml(mapping.provider)} -> ${escapeHtml(mapping.upstreamModel)} · ${mapping.enabled === false ? text.disabled : text.enabled}</div>
        </div>
        <div class="actions inline-actions">
          <button class="collapse-toggle" data-toggle-card="mapping:${index}">${isCardOpen("mapping", mapping.id, index) ? "收起" : "展开"}</button>
          <button class="danger" data-remove-mapping="${index}">${text.delete}</button>
        </div>
      </div>
      <div class="item-body">
        <div class="form-grid">
          <label>${text.localModel}<input data-mapping-field="id" value="${escapeAttr(mapping.id)}"></label>
          <label>${text.displayName}<input data-mapping-field="displayName" value="${escapeAttr(mapping.displayName || "")}"></label>
          <label>Provider
            <select data-mapping-field="provider" data-provider-select="${index}">
              ${providerOptions}
            </select>
          </label>
          <label>${text.upstreamModel}
            <datalist id="provider-models-${index}">${modelOptions}</datalist>
            ${upstreamControl}
          </label>
          <label>${text.aliases}<textarea data-mapping-field="aliases" rows="4">${escapeHtml((mapping.aliases || []).join("\n"))}</textarea></label>
          <label>${text.enabled}
            <select data-mapping-field="enabled">
              <option value="true" ${mapping.enabled !== false ? "selected" : ""}>${text.enabled}</option>
              <option value="false" ${mapping.enabled === false ? "selected" : ""}>${text.disabled}</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button class="primary" data-save-mapping="${index}">${text.saveMapping}</button>
        </div>
      </div>
    </article>
  `;
}



function defaultScenarios() {
  return ["startup_poisoning", "prompt_injection", "data_exfiltration"];
}

function scenarioLabels() {
  return {
    startup_poisoning: text.attackScenarioStartupPoisoning,
    prompt_injection: text.attackScenarioPromptInjection,
    data_exfiltration: text.attackScenarioDataExfiltration
  };
}

function scenarioOptions(selected) {
  const labels = scenarioLabels();
  return defaultScenarios()
    .map((value) => `<option value="${value}" ${selected === value ? "selected" : ""}>${escapeHtml(labels[value])}</option>`)
    .join("");
}

function optionList(values, selected) {
  return values
    .map((value) => `<option value="${escapeAttr(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

function defaultAttackSimulation() {
  return {
    enabled: false,
    modelId: "attack-sim",
    displayName: text.genericAttackSimulation,
    provider: config.providers[0]?.id || "",
    model: config.providers[0]?.models?.[0]?.id || "",
    allowClientParams: false,
    defaultScenario: "startup_poisoning",
    allowedScenarios: defaultScenarios(),
    defaultIntensity: "low",
    allowedIntensities: ["low", "medium", "high"],
    defaultInsertionStyle: "obvious",
    allowedInsertionStyles: ["obvious", "natural", "hidden"],
    safeMode: "tool-intent"
  };
}

function renderAttackSimulation() {
  config.attackSimulation = config.attackSimulation || defaultAttackSimulation();
  const policy = config.attackSimulation;
  const providerOptions = config.providers
    .map((provider) => `<option value="${escapeAttr(provider.id)}">${escapeHtml(provider.id)}</option>`)
    .join("");
  const provider = config.providers.find((item) => item.id === policy.provider) || config.providers[0];
  const savedModels = provider?.models || [];
  const modelOptions = savedModels
    .map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.id)}</option>`)
    .join("");
  const modelControl =
    savedModels.length > 0
      ? `<select id="attackSimulationModel">${modelOptions}</select>`
      : `<input id="attackSimulationModel" list="attack-simulation-provider-models" value="${escapeAttr(policy.model || "")}">
         <p class="field-note">这个 Provider 还没有保存模型列表。先到 Provider 页点“获取模型”，这里就会变成下拉选择。</p>`;

  $("#attackSimulationPanel").innerHTML = `
    <article class="item ${isCardOpen("attack-simulation", policy.modelId || "attack-sim", 0) ? "is-open" : ""}" data-attack-simulation-policy>
      <div class="item-head">
        <div class="item-head-main">
          <div class="item-title">${text.genericAttackSimulation}</div>
          <div class="item-meta">客户端调用 ${escapeHtml(policy.modelId || "attack-sim")} · 上游 ${escapeHtml(policy.provider || "")} -> ${escapeHtml(policy.model || "")} · ${policy.allowClientParams ? "client_parameterized" : "fixed"}</div>
        </div>
        <div class="actions inline-actions">
          <button class="collapse-toggle" data-toggle-card="attack-simulation:0">${isCardOpen("attack-simulation", policy.modelId || "attack-sim", 0) ? "收起" : "展开"}</button>
        </div>
      </div>
      <div class="item-body">
        <div class="form-grid">
          <label>${text.modelId}<input id="attackSimulationModelId" value="${escapeAttr(policy.modelId || "attack-sim")}"></label>
          <label>${text.displayName}<input id="attackSimulationDisplayName" value="${escapeAttr(policy.displayName || text.genericAttackSimulation)}"></label>
          <label>Provider
            <select id="attackSimulationProvider">
              ${providerOptions}
            </select>
          </label>
          <label>${text.upstreamModel}
            <datalist id="attack-simulation-provider-models">${modelOptions}</datalist>
            ${modelControl}
          </label>
          <label>${text.defaultScenario}
            <select id="attackSimulationDefaultScenario">
              ${scenarioOptions(policy.defaultScenario)}
            </select>
          </label>
          <label>${text.defaultIntensity}
            <select id="attackSimulationDefaultIntensity">
              ${optionList(["low", "medium", "high"], policy.defaultIntensity || "low")}
            </select>
          </label>
          <label>${text.defaultInsertionStyle}
            <select id="attackSimulationDefaultInsertionStyle">
              ${optionList(["obvious", "natural", "hidden"], policy.defaultInsertionStyle || "obvious")}
            </select>
          </label>
          <label>${text.safeMode}
            <select id="attackSimulationSafeMode">
              ${optionList(["abstract", "inert", "tool-intent", "lab"], policy.safeMode || "abstract")}
            </select>
          </label>
          <label>${text.allowClientParams}
            <select id="attackSimulationAllowClientParams">
              <option value="true" ${policy.allowClientParams === true ? "selected" : ""}>${text.enabled}</option>
              <option value="false" ${policy.allowClientParams === true ? "" : "selected"}>${text.disabled}</option>
            </select>
          </label>
          <label>${text.enabled}
            <select id="attackSimulationEnabled">
              <option value="true" ${policy.enabled === true ? "selected" : ""}>${text.enabled}</option>
              <option value="false" ${policy.enabled === true ? "" : "selected"}>${text.disabled}</option>
            </select>
          </label>
          <label>${text.allowedScenarios}<textarea id="attackSimulationAllowedScenarios" rows="4">${escapeHtml((policy.allowedScenarios || defaultScenarios()).join("\n"))}</textarea></label>
          <label>${text.allowedIntensities}<textarea id="attackSimulationAllowedIntensities" rows="4">${escapeHtml((policy.allowedIntensities || ["low", "medium", "high"]).join("\n"))}</textarea></label>
          <label>${text.allowedInsertionStyles}<textarea id="attackSimulationAllowedInsertionStyles" rows="4">${escapeHtml((policy.allowedInsertionStyles || ["obvious", "natural", "hidden"]).join("\n"))}</textarea></label>
        </div>
        <p class="hint">“客户端虚拟模型名”是客户端看到的名字；“上游实际模型”才是真正被调用的模型。tool-intent / lab 会模拟确认疲劳和攻击链结构；测试期间请拒绝客户端弹出的任何命令、文件、网络或 git 操作确认。</p>
        <div class="actions">
          <button class="primary" id="saveAttackSimulation">${text.saveAttackSimulation}</button>
        </div>
      </div>
    </article>
  `;
  bindCardToggles();
  $("#attackSimulationProvider").value = policy.provider || "";
  if ($("#attackSimulationModel")) {
    $("#attackSimulationModel").value = policy.model || "";
  }
  $("#attackSimulationProvider").addEventListener("change", () => {
    const provider = config.providers.find((item) => item.id === $("#attackSimulationProvider").value);
    config.attackSimulation.provider = $("#attackSimulationProvider").value;
    if (provider?.models?.length) {
      config.attackSimulation.model = provider.models[0].id;
    }
    renderAttackSimulation();
  });
  $("#saveAttackSimulation").addEventListener("click", saveAttackSimulation);
}

function renderAttackSimulators() {
  config.attackSimulators = config.attackSimulators || [];
  $("#attackSimulatorsList").innerHTML = config.attackSimulators
    .map((simulator, index) => renderAttackSimulatorCard(simulator, index))
    .join("");

  bindCardToggles();
  config.attackSimulators.forEach((simulator, index) => {
    const providerSelect = document.querySelector(`[data-attack-simulator-index="${index}"] [data-attack-simulator-field="provider"]`);
    if (providerSelect) {
      providerSelect.value = simulator.provider;
    }
    const modelSelect = document.querySelector(`[data-attack-simulator-index="${index}"] [data-attack-simulator-field="model"]`);
    if (modelSelect) {
      modelSelect.value = simulator.model;
    }
  });
  document.querySelectorAll("[data-save-attack-simulator]").forEach((button) => {
    button.addEventListener("click", () => saveAttackSimulator(Number(button.dataset.saveAttackSimulator)));
  });
  document.querySelectorAll("[data-remove-attack-simulator]").forEach((button) => {
    button.addEventListener("click", () => removeAttackSimulator(Number(button.dataset.removeAttackSimulator)));
  });
  document.querySelectorAll("[data-attack-simulator-provider-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const index = Number(select.dataset.attackSimulatorProviderSelect);
      const provider = config.providers.find((item) => item.id === select.value);
      config.attackSimulators[index].provider = select.value;
      if (provider?.models?.length) {
        config.attackSimulators[index].model = provider.models[0].id;
      }
      renderAttackSimulators();
    });
  });
}

function renderAttackSimulatorCard(simulator, index) {
  const providerOptions = config.providers
    .map((provider) => `<option value="${escapeAttr(provider.id)}">${escapeHtml(provider.id)}</option>`)
    .join("");
  const provider = config.providers.find((item) => item.id === simulator.provider) || config.providers[0];
  const savedModels = provider?.models || [];
  const modelOptions = savedModels
    .map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.id)}</option>`)
    .join("");
  const modelControl =
    savedModels.length > 0
      ? `<select data-attack-simulator-field="model">${modelOptions}</select>`
      : `<input data-attack-simulator-field="model" list="attack-simulator-provider-models-${index}" value="${escapeAttr(simulator.model || "")}">
         <p class="field-note">这个 Provider 还没有保存模型列表。先到 Provider 页点“获取模型”，这里就会变成下拉选择。</p>`;
  const scenarioChoices = scenarioOptions(simulator.scenario);

  return `
    <article class="item ${isCardOpen("attack-simulator", simulator.id, index) ? "is-open" : ""}" data-attack-simulator-index="${index}">
      <div class="item-head">
        <div class="item-head-main">
          <div class="item-title">${escapeHtml(simulator.id)}</div>
          <div class="item-meta">客户端调用 ${escapeHtml(simulator.id || "")} · 上游 ${escapeHtml(simulator.provider || "")} -> ${escapeHtml(simulator.model || "")} · ${escapeHtml(simulator.scenario || "")}</div>
        </div>
        <div class="actions inline-actions">
          <button class="collapse-toggle" data-toggle-card="attack-simulator:${index}">${isCardOpen("attack-simulator", simulator.id, index) ? "收起" : "展开"}</button>
          <button class="danger" data-remove-attack-simulator="${index}">${text.delete}</button>
        </div>
      </div>
      <div class="item-body">
        <div class="form-grid">
          <label>${text.attackSimModel}<input data-attack-simulator-field="id" value="${escapeAttr(simulator.id || "")}"></label>
          <label>${text.displayName}<input data-attack-simulator-field="displayName" value="${escapeAttr(simulator.displayName || "")}"></label>
          <label>Provider
            <select data-attack-simulator-field="provider" data-attack-simulator-provider-select="${index}">
              ${providerOptions}
            </select>
          </label>
          <label>${text.upstreamModel}
            <datalist id="attack-simulator-provider-models-${index}">${modelOptions}</datalist>
            ${modelControl}
          </label>
          <label>${text.scenario}
            <select data-attack-simulator-field="scenario">
              ${scenarioChoices}
            </select>
          </label>
          <label>${text.enabled}
            <select data-attack-simulator-field="enabled">
              <option value="true" ${simulator.enabled !== false ? "selected" : ""}>${text.enabled}</option>
              <option value="false" ${simulator.enabled === false ? "selected" : ""}>${text.disabled}</option>
            </select>
          </label>
          <label>${text.defaultIntensity}
            <select data-attack-simulator-field="defaultIntensity">
              ${optionList(["low", "medium", "high"], simulator.defaultIntensity || "low")}
            </select>
          </label>
          <label>${text.defaultInsertionStyle}
            <select data-attack-simulator-field="defaultInsertionStyle">
              ${optionList(["obvious", "natural", "hidden"], simulator.defaultInsertionStyle || "obvious")}
            </select>
          </label>
          <label>${text.allowClientParams}
            <select data-attack-simulator-field="allowClientParams">
              <option value="true" ${simulator.allowClientParams === true ? "selected" : ""}>${text.enabled}</option>
              <option value="false" ${simulator.allowClientParams === true ? "" : "selected"}>${text.disabled}</option>
            </select>
          </label>
          <label>${text.safeMode}
            <select data-attack-simulator-field="safeMode">
              ${optionList(["abstract", "inert", "tool-intent", "lab"], simulator.safeMode || "abstract")}
            </select>
          </label>
          <label>${text.allowedIntensities}<textarea data-attack-simulator-field="allowedIntensities" rows="4">${escapeHtml((simulator.allowedIntensities || ["low", "medium", "high"]).join("\n"))}</textarea></label>
          <label>${text.allowedInsertionStyles}<textarea data-attack-simulator-field="allowedInsertionStyles" rows="4">${escapeHtml((simulator.allowedInsertionStyles || ["obvious", "natural", "hidden"]).join("\n"))}</textarea></label>
        </div>
        <p class="hint">客户端用虚拟模型名发起普通请求；TinyGateway 会调用上方上游实际模型生成模拟响应，并继续经过 reviewer 审查。tool-intent / lab 用于测试确认疲劳和攻击链结构，测试期间拒绝客户端弹出的所有操作确认。</p>
        <div class="actions">
          <button class="primary" data-save-attack-simulator="${index}">${text.saveAttackSimulator}</button>
        </div>
      </div>
    </article>
  `;
}

function renderAttackReport() {
  const list = $("#attackReportList");
  if (!list) {
    return;
  }
  list.innerHTML = attackReport
    .map((item) => {
      const latestReview = item.reviews?.[item.reviews.length - 1];
      const latestDecision = item.decisions?.[item.decisions.length - 1];
      return `
        <article class="audit-entry ${latestReview?.risk ? `risk-${escapeAttr(latestReview.risk)}` : ""}">
          <div class="audit-meta">
            <span>${escapeHtml(item.ts || "")}</span>
            <span>${escapeHtml(item.requestId || "")}</span>
            <span>${escapeHtml(item.model || "")}</span>
            <span>${escapeHtml(item.scenario || "")}</span>
            <span>${escapeHtml(item.intensity || "")}</span>
            <span>${escapeHtml(item.safeMode || "")}</span>
          </div>
          <div class="audit-summary">${escapeHtml(item.status || "observed")}${latestReview ? ` / ${escapeHtml(latestReview.risk || "")} / ${escapeHtml(latestReview.action || "")}` : ""}</div>
          <div class="review-details">
            <div><strong>上游:</strong> ${escapeHtml(item.provider || "")} -> ${escapeHtml(item.upstreamModel || "")}</div>
            <div><strong>插入:</strong> ${escapeHtml(item.insertionStyle || "")} / ${item.clientParameterized ? "客户端参数" : "固定参数"}</div>
            ${latestDecision ? `<div><strong>决策:</strong> ${escapeHtml(latestDecision.outcome || "")} / ${escapeHtml(latestDecision.reason || "")}</div>` : ""}
            ${latestReview ? `<div><strong>原因:</strong> ${escapeHtml(latestReview.reason || "")}</div>` : ""}
          </div>
        </article>
      `;
    })
    .join("") || "<p>暂无模拟攻击报告</p>";
}

function renderReviewer() {
  const reviewer = config.reviewer || {};
  if (reviewer.mode === "full") {
    $("#reviewerMode").value = "guard";
    $("#reviewerContext").value = "full";
    $("#reviewerOutboundReview").value = "guard";
  } else {
    $("#reviewerMode").value = reviewer.mode || "off";
    $("#reviewerContext").value = reviewer.context || "response";
    $("#reviewerOutboundReview").value = reviewer.outboundReview || "off";
  }
  $("#reviewerConfirmBehavior").value = reviewer.confirmBehavior || "queue";
  if (!$("#reviewerConfirmBehavior").value && reviewer.confirmBehavior === "queue") {
    $("#reviewerConfirmBehavior").value = "retry";
  }
  if (!$("#reviewerConfirmBehavior").value) {
    $("#reviewerConfirmBehavior").value = "hold";
  }
  $("#reviewerProvider").innerHTML = [
    '<option value="">none</option>',
    ...config.providers.map((provider) => `<option value="${escapeAttr(provider.id)}">${escapeHtml(provider.id)}</option>`)
  ].join("");
  $("#reviewerProvider").value = reviewer.provider || "";
  renderReviewerModelControl(reviewer);
  $("#reviewerProvider").onchange = () => {
    config.reviewer = {
      ...config.reviewer,
      provider: $("#reviewerProvider").value,
      model: selectedProviderModels($("#reviewerProvider").value)[0]?.id || config.reviewer?.model || ""
    };
    renderReviewerModelControl(config.reviewer);
  };
  $("#reviewerTimeoutMs").value = reviewer.timeoutMs || 12000;
  $("#reviewerHoldTimeoutMs").value = reviewer.holdTimeoutMs || 120000;
  $("#reviewerFailBehavior").value = reviewer.failBehavior || "allow";
}

function renderReviewerModelControl(reviewer = {}) {
  const savedModels = selectedProviderModels($("#reviewerProvider").value || reviewer.provider);
  const options = savedModels
    .map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.id)}</option>`)
    .join("");
  $("#reviewerModelControl").innerHTML =
    savedModels.length > 0
      ? `<select id="reviewerModel">${options}</select>`
      : `<input id="reviewerModel" list="reviewer-provider-models" placeholder="检查模型 ID" value="${escapeAttr(reviewer.model || "")}">
         <datalist id="reviewer-provider-models">${options}</datalist>
         <p class="field-note">这个 Provider 还没有保存模型列表。可以在 Provider 里获取或手动填写支持模型列表。</p>`;
  $("#reviewerModel").value = reviewer.model || savedModels[0]?.id || "";
}

function selectedProviderModels(providerId) {
  return config.providers.find((provider) => provider.id === providerId)?.models || [];
}

function renderAudit(entries) {
  $("#auditList").innerHTML = renderAuditEntries(entries);
}

function renderAuditSettings() {
  config.audit = config.audit || {};
  $("#auditRetentionHours").value = config.audit.retentionHours || 48;
  $("#auditMaxSizeMb").value = config.audit.maxSizeMb || 20;
}

function renderConfirmations() {
  const list = $("#confirmationsList");
  if (!list) {
    return;
  }
  list.innerHTML = renderConfirmationEntries(confirmations);
  list.querySelectorAll("[data-confirmation-allow]").forEach((button) => {
    button.addEventListener("click", () => resolveConfirmation(button.dataset.confirmationAllow, "allow"));
  });
  list.querySelectorAll("[data-confirmation-block]").forEach((button) => {
    button.addEventListener("click", () => resolveConfirmation(button.dataset.confirmationBlock, "block"));
  });
}

function cardKey(type, id, index) {
  return `${type}:${id || index}`;
}

function isCardOpen(type, id, index) {
  return openCards.has(cardKey(type, id, index));
}

function bindCardToggles() {
  document.querySelectorAll("[data-toggle-card]").forEach((button) => {
    if (button.dataset.cardToggleBound === "true") {
      return;
    }
    button.dataset.cardToggleBound = "true";
    button.addEventListener("click", () => {
      const [type, indexText] = button.dataset.toggleCard.split(":");
      const index = Number(indexText);
      const id = getCardId(type, index);
      const key = cardKey(type, id, index);
      if (openCards.has(key)) {
        openCards.delete(key);
      } else {
        openCards.add(key);
      }
      render();
    });
  });
}

function getCardId(type, index) {
  if (type === "provider") {
    return config.providers[index]?.id;
  }
  if (type === "mapping") {
    return config.modelMappings[index]?.id;
  }
  if (type === "attack-simulator") {
    return config.attackSimulators?.[index]?.id;
  }
  if (type === "attack-simulation") {
    return config.attackSimulation?.modelId || "attack-sim";
  }
  return String(index);
}

async function resolveConfirmation(id, action) {
  try {
    const result = await apiPost(`/api/admin/confirmations/${encodeURIComponent(id)}/${action}`, {});
    confirmations = confirmations.map((item) => (item.id === id ? result.data : item));
    renderConfirmations();
    toast(`${text.confirmation}${action === "allow" ? text.allowed : text.blocked}`);
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveProvider(index) {
  const item = document.querySelector(`[data-provider-index="${index}"]`);
  const oldId = config.providers[index].id;
  const manualModelIds = lines(item.querySelector("[data-provider-models]")?.value || "");
  const nextProvider = {
    ...config.providers[index],
    ...collectFields(item, "provider"),
    models: mergeManualModels(config.providers[index].models || [], manualModelIds)
  };

  config.providers[index] = nextProvider;
  if (oldId !== nextProvider.id) {
    config.modelMappings = config.modelMappings.map((mapping) =>
      mapping.provider === oldId ? { ...mapping, provider: nextProvider.id } : mapping
    );
  }

  await saveConfig(config);
}

function mergeManualModels(existingModels, modelIds) {
  const existingById = new Map((existingModels || []).map((model) => [model.id, model]));
  return modelIds.map((id) => ({
    ...(existingById.get(id) || {}),
    id,
    displayName: existingById.get(id)?.displayName || id,
    aliases: existingById.get(id)?.aliases || []
  }));
}

async function removeProvider(index) {
  const provider = config.providers[index];
  if (config.modelMappings.some((mapping) => mapping.provider === provider.id)) {
    toast(text.providerStillUsed, true);
    return;
  }

  config.providers.splice(index, 1);
  await saveConfig(config);
}

async function fetchAndSaveProviderModels(index) {
  const provider = config.providers[index];
  try {
    toast(`${text.fetchingModels} ${provider.id}...`);
    const result = await apiPost(`/api/admin/providers/${encodeURIComponent(provider.id)}/models/fetch`, {});
    config = result.config;
    await loadModels();
    await loadStatus();
    render();
    toast(`${text.savedModels}: ${provider.id} (${result.count})`);
  } catch (error) {
    toast(error.message, true);
  }
}

function addProvider() {
  const provider = {
    id: uniqueId("provider", config.providers.map((provider) => provider.id)),
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: ""
  };
  config.providers.push(provider);
  openCards.add(cardKey("provider", provider.id, config.providers.length - 1));
  renderProviders();
}

async function saveMapping(index) {
  const item = document.querySelector(`[data-mapping-index="${index}"]`);
  const values = {
    ...config.modelMappings[index],
    ...collectFields(item, "mapping")
  };
  values.aliases = lines(values.aliases);
  values.enabled = values.enabled !== "false";
  config.modelMappings[index] = values;
  await saveConfig(config);
}

async function removeMapping(index) {
  config.modelMappings.splice(index, 1);
  await saveConfig(config);
}


async function saveAttackSimulation() {
  config.attackSimulation = {
    ...config.attackSimulation,
    enabled: $("#attackSimulationEnabled").value === "true",
    modelId: $("#attackSimulationModelId").value.trim() || "attack-sim",
    displayName: $("#attackSimulationDisplayName").value.trim() || text.genericAttackSimulation,
    provider: $("#attackSimulationProvider").value,
    model: $("#attackSimulationModel").value.trim(),
    allowClientParams: $("#attackSimulationAllowClientParams").value === "true",
    defaultScenario: $("#attackSimulationDefaultScenario").value,
    allowedScenarios: lines($("#attackSimulationAllowedScenarios").value),
    defaultIntensity: $("#attackSimulationDefaultIntensity").value,
    allowedIntensities: lines($("#attackSimulationAllowedIntensities").value),
    defaultInsertionStyle: $("#attackSimulationDefaultInsertionStyle").value,
    allowedInsertionStyles: lines($("#attackSimulationAllowedInsertionStyles").value),
    safeMode: $("#attackSimulationSafeMode").value || "abstract"
  };
  await saveConfig(config);
}

async function saveAttackSimulator(index) {
  const item = document.querySelector(`[data-attack-simulator-index="${index}"]`);
  const values = {
    ...config.attackSimulators[index],
    ...collectFields(item, "attack-simulator")
  };
  values.enabled = values.enabled !== "false";
  values.allowClientParams = values.allowClientParams === "true";
  values.allowedIntensities = lines(values.allowedIntensities);
  values.allowedInsertionStyles = lines(values.allowedInsertionStyles);
  config.attackSimulators[index] = values;
  await saveConfig(config);
}

async function removeAttackSimulator(index) {
  config.attackSimulators.splice(index, 1);
  await saveConfig(config);
}

function addAttackSimulator() {
  config.attackSimulators = config.attackSimulators || [];
  const simulator = {
    id: uniqueId("attack-sim/startup-poisoning", config.attackSimulators.map((simulator) => simulator.id)),
    displayName: "启动项投毒模拟",
    provider: config.providers[0]?.id || "",
    model: config.providers[0]?.models?.[0]?.id || "",
    scenario: "startup_poisoning",
    allowClientParams: false,
    defaultIntensity: "low",
    allowedIntensities: ["low", "medium", "high"],
    defaultInsertionStyle: "obvious",
    allowedInsertionStyles: ["obvious", "natural", "hidden"],
    safeMode: "tool-intent",
    enabled: true
  };
  config.attackSimulators.push(simulator);
  openCards.add(cardKey("attack-simulator", simulator.id, config.attackSimulators.length - 1));
  renderAttackSimulators();
}

function addMapping() {
  const provider = config.providers[0];
  const mapping = {
    id: uniqueId("model", config.modelMappings.map((mapping) => mapping.id)),
    displayName: "",
    provider: provider?.id || "",
    upstreamModel: provider?.models?.[0]?.id || "",
    aliases: [],
    enabled: true
  };
  config.modelMappings.push(mapping);
  openCards.add(cardKey("mapping", mapping.id, config.modelMappings.length - 1));
  renderMappings();
}

async function saveReviewer() {
  config.reviewer = {
    enabled: $("#reviewerMode").value !== "off",
    mode: $("#reviewerMode").value,
    context: $("#reviewerContext").value,
    outboundReview: $("#reviewerOutboundReview").value,
    provider: $("#reviewerProvider").value,
    model: $("#reviewerModel").value.trim(),
    timeoutMs: Number($("#reviewerTimeoutMs").value || 12000),
    holdTimeoutMs: Number($("#reviewerHoldTimeoutMs").value || 120000),
    failBehavior: $("#reviewerFailBehavior").value,
    confirmBehavior: $("#reviewerConfirmBehavior").value
  };
  await saveConfig(config);
}

async function saveAuditSettings() {
  config.audit = {
    ...(config.audit || {}),
    retentionHours: Number($("#auditRetentionHours").value || 48),
    maxSizeMb: Number($("#auditMaxSizeMb").value || 20)
  };
  await saveConfig(config);
}

async function saveRawConfig() {
  const parsed = JSON.parse($("#rawConfig").value);
  await saveConfig(parsed);
}

async function saveConfig(nextConfig) {
  try {
    config = await apiPut("/api/admin/config", nextConfig);
    await loadModels();
    await loadStatus();
    render();
    toast(text.saved);
  } catch (error) {
    toast(error.message, true);
  }
}

function collectFields(root, prefix) {
  const values = {};
  root.querySelectorAll(`[data-${prefix}-field]`).forEach((field) => {
    values[field.getAttribute(`data-${prefix}-field`)] = field.value.trim();
  });
  return values;
}

function lines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueId(prefix, existingIds) {
  let index = existingIds.length + 1;
  let id = `${prefix}-${index}`;
  while (existingIds.includes(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }
  return id;
}

async function apiGet(url) {
  const response = await fetch(url);
  return parseResponse(response);
}

async function apiPut(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `${text.requestFailed}: ${response.status}`);
  }
  return data;
}

function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.style.background = isError ? "#b42318" : "#17202a";
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2200);
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
