/**
 * LLM Models - Loading, cascading, defaults
 */

import logger from '../logger.js';
import { getModelStatsCounter, modelStatsKey } from '../time-bucket-counter.js';
import { OPENROUTER_ID } from './endpoints.js';

// Model tuple: [endpoint, model, openrouterProvider, noToolChoice]
// openrouterProvider: provider slug for OpenRouter routing (e.g., 'google-ai-studio')
// noToolChoice: boolean - skip tool_choice param for models that don't support it
export const DEFAULT_MODELS = {
  HIGH: [
    [OPENROUTER_ID, 'google/gemini-2.5-pro', 'google-ai-studio'],
    [OPENROUTER_ID, 'qwen/qwen3-235b-a22b-2507', 'Cerebras']
  ],
  MEDIUM: [
    [OPENROUTER_ID, 'openai/gpt-oss-120b', 'Cerebras'],
    [OPENROUTER_ID, 'google/gemini-2.5-flash', 'google-ai-studio'],
    [OPENROUTER_ID, 'meta-llama/llama-3.3-70b-instruct', 'Cerebras']
  ],
  LOW: [
    [OPENROUTER_ID, 'google/gemini-2.5-flash-lite', 'google-ai-studio'],
    [OPENROUTER_ID, 'qwen/qwen3-32b', 'Cerebras']
  ]
};

const INTELLIGENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];

export async function getModels() {
  return (await chrome.storage.local.get(['llmModels'])).llmModels || DEFAULT_MODELS;
}

export async function setModels(models) {
  await chrome.storage.local.set({ llmModels: models });
}

export function getDefaultModels() {
  return JSON.parse(JSON.stringify(DEFAULT_MODELS));
}

export async function getCascadingModels(intelligence) {
  const models = await getModels();
  const startIndex = Math.max(0, INTELLIGENCE_LEVELS.indexOf(intelligence));

  return INTELLIGENCE_LEVELS
    .slice(startIndex)
    .flatMap(level => (models[level] || []).map(([endpoint, model, openrouterProvider, noToolChoice]) => ({
      endpoint, model, openrouterProvider, noToolChoice
    })));
}

export async function shouldSkip(endpoint, model, openrouterProvider) {
  const key = modelStatsKey(endpoint, model, openrouterProvider);
  const stats = await getModelStatsCounter().getStats(key);
  const errors = stats?.error?.total || 0;
  const skips = stats?.skip?.total || 0;

  if (errors === 0) return false;
  if (skips < errors) {
    await getModelStatsCounter().increment(key, 'skip');
    logger.info(`Skipping ${model}`, { errors, skips });
    return true;
  }
  return false;
}

export async function recordSuccess(endpoint, model, openrouterProvider) {
  const key = modelStatsKey(endpoint, model, openrouterProvider);
  await getModelStatsCounter().reset(key, ['error', 'skip']);
  await getModelStatsCounter().increment(key, 'success');
}

export async function recordError(endpoint, model, openrouterProvider) {
  const key = modelStatsKey(endpoint, model, openrouterProvider);
  await getModelStatsCounter().increment(key, 'error');
  await getModelStatsCounter().reset(key, ['skip']);
}

export async function getAllModelsSortedByRecentErrors() {
  const models = await getModels();
  const allModels = [];

  for (const level of ['HIGH', 'MEDIUM', 'LOW']) {
    for (const [endpoint, model, openrouterProvider, noToolChoice] of (models[level] || [])) {
      allModels.push({ endpoint, model, openrouterProvider, noToolChoice });
    }
  }

  const withStats = await Promise.all(allModels.map(async m => {
    const key = modelStatsKey(m.endpoint, m.model, m.openrouterProvider);
    const stats = await getModelStatsCounter().getStats(key);
    return { ...m, recentErrors: stats?.error?.lastHour || 0 };
  }));

  return withStats.sort((a, b) => a.recentErrors - b.recentErrors);
}
