/**
 * LLM Models - Loading, cascading, defaults
 */

import logger from '../logger.js';
import { getModelStatsCounter, modelStatsKey, providerStatsKey } from '../debug/time-bucket-counter.js';
import { OPENROUTER_ID } from './endpoints.js';

// Model tuple: [endpoint, model, openrouterProvider, noToolChoice, noToolUse]
// openrouterProvider: provider slug for OpenRouter routing (e.g., 'google-ai-studio')
// noToolChoice: boolean - skip tool_choice param for models that don't support it
// noToolUse: boolean - model doesn't support tool use at all (skipped when tools required)
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
    .flatMap(level => (models[level] || []).map(([endpoint, model, openrouterProvider, noToolChoice, noToolUse]) => ({
      endpoint, model, openrouterProvider, noToolChoice, noToolUse
    })));
}

const SKIP_WINDOW_MS = 60 * 1000; // Only skip models with errors in last 1 minute

export async function shouldSkip(endpoint, model, openrouterProvider) {
  const counter = getModelStatsCounter();
  const key = modelStatsKey(endpoint, model, openrouterProvider);

  // Get latest entries for each type (sorted newest first)
  const [successes, errors, skips] = await Promise.all([
    counter.getEntries(key, 'success'),
    counter.getEntries(key, 'error'),
    counter.getEntries(key, 'skip')
  ]);

  const lastSuccess = successes[0]?.[0] || 0;
  const lastError = errors[0]?.[0] || 0;

  // If success is latest, try using model
  if (lastSuccess >= lastError) return false;

  // Only skip if error was within the skip window
  const now = Date.now();
  if (now - lastError > SKIP_WINDOW_MS) return false;

  // Error is latest and recent - count errors after last success
  const errorsSinceSuccess = errors.filter(([ts]) => ts > lastSuccess).length;
  if (errorsSinceSuccess === 0) return false;

  // Count skips after last error
  const skipsSinceError = skips.filter(([ts]) => ts > lastError).length;

  // Need that many skips before retrying
  if (skipsSinceError < errorsSinceSuccess) {
    await counter.increment(key, 'skip');
    logger.info(`Skipping ${model}`, { errorsSinceSuccess, skipsSinceError });
    return true;
  }
  return false;
}

export async function recordSuccess(endpoint, model, openrouterProvider) {
  const counter = getModelStatsCounter();
  const key = modelStatsKey(endpoint, model, openrouterProvider);
  const provKey = providerStatsKey(endpoint);
  await counter.increment(key, 'success');
  await counter.increment(provKey, 'success');
}

export async function recordError(endpoint, model, openrouterProvider) {
  const counter = getModelStatsCounter();
  const key = modelStatsKey(endpoint, model, openrouterProvider);
  const provKey = providerStatsKey(endpoint);
  await counter.increment(key, 'error');
  await counter.increment(provKey, 'error');
}

export async function getAllModelsSortedByRecentErrors() {
  const models = await getModels();
  const allModels = [];

  for (const level of ['HIGH', 'MEDIUM', 'LOW']) {
    for (const [endpoint, model, openrouterProvider, noToolChoice, noToolUse] of (models[level] || [])) {
      allModels.push({ endpoint, model, openrouterProvider, noToolChoice, noToolUse });
    }
  }

  const withStats = await Promise.all(allModels.map(async m => {
    const key = modelStatsKey(m.endpoint, m.model, m.openrouterProvider);
    const stats = await getModelStatsCounter().getStats(key);
    return { ...m, recentErrors: stats?.error?.lastHour || 0 };
  }));

  return withStats.sort((a, b) => a.recentErrors - b.recentErrors);
}
