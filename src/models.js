export function listModels(config) {
  const seen = new Set();
  const models = [];

  if (config.modelMappings.length > 0) {
    addGenericAttackSimulationModel(models, seen, config.attackSimulation);
    for (const mapping of config.modelMappings) {
      if (!mapping.enabled || seen.has(mapping.id)) {
        continue;
      }
      seen.add(mapping.id);
      models.push({
        id: mapping.id,
        object: "model",
        created: 0,
        owned_by: mapping.provider,
        display_name: mapping.displayName || mapping.id,
        provider: mapping.provider,
        upstream_model: mapping.upstreamModel
      });
    }

    addAttackSimulatorModels(models, seen, config.attackSimulators || []);
    return {
      object: "list",
      data: models
    };
  }

  addGenericAttackSimulationModel(models, seen, config.attackSimulation);
  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (seen.has(model.id)) {
        continue;
      }
      seen.add(model.id);
      models.push({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: provider.id,
        display_name: model.displayName || model.id,
        provider: provider.id,
        type: provider.type
      });
    }
  }

  addAttackSimulatorModels(models, seen, config.attackSimulators || []);
  return {
    object: "list",
    data: models
  };
}

function addGenericAttackSimulationModel(models, seen, attackSimulation) {
  if (!attackSimulation?.enabled || seen.has(attackSimulation.modelId)) {
    return;
  }
  seen.add(attackSimulation.modelId);
  models.push({
    id: attackSimulation.modelId,
    object: "model",
    created: 0,
    owned_by: "tinygateway-attack-simulator",
    display_name: attackSimulation.displayName || attackSimulation.modelId,
    provider: attackSimulation.provider,
    upstream_model: attackSimulation.model,
    type: "attack_simulator",
    scenario: attackSimulation.defaultScenario,
    client_parameterized: Boolean(attackSimulation.allowClientParams),
    allowed_scenarios: attackSimulation.allowedScenarios || [],
    allowed_intensities: attackSimulation.allowedIntensities || [],
    allowed_insertion_styles: attackSimulation.allowedInsertionStyles || []
  });
}

function addAttackSimulatorModels(models, seen, attackSimulators) {
  for (const simulator of attackSimulators) {
    if (!simulator.enabled || seen.has(simulator.id)) {
      continue;
    }
    seen.add(simulator.id);
    models.push({
      id: simulator.id,
      object: "model",
      created: 0,
      owned_by: "tinygateway-attack-simulator",
      display_name: simulator.displayName || simulator.id,
      provider: simulator.provider,
      upstream_model: simulator.model,
      type: "attack_simulator",
      scenario: simulator.scenario
    });
  }
}
