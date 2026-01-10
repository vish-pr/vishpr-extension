// LLM Model Configuration
// Defines model tiers and selection logic

/**
 * Intelligence levels for model selection
 * @enum {string}
 */
export const INTELLIGENCE_LEVEL = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
};

/**
 * @typedef {Object} ProviderRouting
 * @property {string[]} [only] - Only use these specific providers
 */

/**
 * @typedef {Object} ModelSelection
 * @property {'gemini' | 'openrouter'} provider
 * @property {string} model
 * @property {ProviderRouting} [routing]
 */

/**
 * Model configuration by intelligence level
 * Format: [provider, model, routing]
 */
export const MODELS = {
  HIGH: [
    ['openrouter', 'google/gemini-2.5-pro', { only: ['google-ai-studio'] }],
    ['openrouter', 'qwen/qwen3-235b-a22b-2507', { only: ['Cerebras'] }],
    ['gemini', 'gemini-2.0-flash-exp']
  ],
  MEDIUM: [
    ['openrouter', 'openai/gpt-oss-120b', { only: ['Cerebras'] }],
    ['openrouter', 'google/gemini-2.5-flash', { only: ['google-ai-studio'] }],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct', { only: ['Cerebras'] }],
    ['gemini', 'gemini-2.0-flash-exp']
  ],
  LOW: [
    ['openrouter', 'google/gemini-2.5-flash-lite', { only: ['google-ai-studio'] }],
    ['openrouter', 'qwen/qwen3-32b', { only: ['Cerebras'] }],
    ['gemini', 'gemini-2.0-flash-exp']
  ]
};

/**
 * Get models for a specific intelligence level
 * @param {string} intelligence - Intelligence level (HIGH, MEDIUM, LOW)
 * @param {Set<string>} availableProviders - Set of available provider names
 * @returns {ModelSelection[]}
 */
export function getModelsForIntelligence(intelligence, availableProviders) {
  const models = MODELS[intelligence] || MODELS.MEDIUM;

  return models
    .filter(([provider]) => availableProviders.has(provider))
    .map(([provider, model, routing]) => ({
      provider,
      model,
      routing: routing || {}
    }));
}

/**
 * Get cascading models starting from requested intelligence level
 * Falls back to lower intelligence models if higher ones fail
 * @param {string} intelligence - Starting intelligence level
 * @param {Set<string>} availableProviders - Available providers
 * @returns {ModelSelection[]}
 */
export function getCascadingModels(intelligence, availableProviders) {
  const levels = ['HIGH', 'MEDIUM', 'LOW'];
  const allModels = [];

  // Build complete list of all models
  for (const level of levels) {
    const models = getModelsForIntelligence(level, availableProviders);
    allModels.push(...models);
  }

  // Find starting index
  const startIndex = levels.indexOf(intelligence);
  if (startIndex === -1) {
    console.warn(`Unknown intelligence level: ${intelligence}, using MEDIUM`);
    return getCascadingModels('MEDIUM', availableProviders);
  }

  // Calculate models before starting level
  let modelsBeforeStart = 0;
  for (let i = 0; i < startIndex; i++) {
    const level = levels[i];
    const models = getModelsForIntelligence(level, availableProviders);
    modelsBeforeStart += models.length;
  }

  // Return cascading models from requested level
  const cascadingModels = allModels.slice(modelsBeforeStart);

  return cascadingModels;
}
