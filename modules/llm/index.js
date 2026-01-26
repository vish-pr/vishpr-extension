/**
 * LLM Module - Main exports
 */

import logger from '../logger.js';
import { callOpenAICompatible, verifyModel } from './api.js';
import {
  getCascadingModels,
  shouldSkip,
  recordSuccess,
  recordError,
  getModels,
  setModels,
  getDefaultModels,
  getAllModelsSortedByRecentErrors
} from './models.js';
import {
  getEndpoints,
  setEndpoints,
  getConfiguredEndpoints,
  fetchModelsForEndpoint,
  verifyApiKey,
  PREDEFINED_ENDPOINTS,
  OPENROUTER_ID,
  CEREBRAS_ID,
  MISTRAL_ID
} from './endpoints.js';

let initialized = false;

export async function isInitialized() {
  if (initialized) return true;
  const endpoints = await getEndpoints();
  initialized = Object.keys(endpoints).length > 0;
  return initialized;
}

export async function generate({ messages, intelligence = 'MEDIUM', tools, schema, onModelError }) {
  if (!tools?.length && !schema) {
    throw new Error('Either tools or schema is required');
  }

  if (!await isInitialized()) {
    throw new Error('No LLM endpoints configured');
  }

  const cascadingModels = await getCascadingModels(intelligence);
  let lastError = null;

  for (const { endpoint, model, openrouterProvider, noToolChoice, noToolUse } of cascadingModels) {
    if (tools && noToolUse) {
      continue;
    }
    if (await shouldSkip(endpoint, model, openrouterProvider)) {
      continue;
    }

    try {
      const result = await callOpenAICompatible({ endpoint, model, messages, tools, schema, openrouterProvider, noToolChoice });

      if (tools && result.tool_calls?.length && !result.tool_calls[0].function?.name) {
        throw new Error('Invalid tool call: missing function name');
      }

      await recordSuccess(endpoint, model, openrouterProvider);
      return result;

    } catch (error) {
      lastError = error;
      await recordError(endpoint, model, openrouterProvider);
      onModelError?.({ endpoint, model, openrouterProvider, error: error.message, phase: 'cascade' });
    }
  }

  // Fallback: try all models sorted by recent errors, ignoring backoff
  const sortedModels = await getAllModelsSortedByRecentErrors();
  logger.info('Cascade failed, attempting fallback recovery', { models: sortedModels.map(m => m.model) });

  const results = [];
  for (const { endpoint, model, openrouterProvider, noToolChoice, noToolUse } of sortedModels) {
    if (tools && noToolUse) {
      continue;
    }
    try {
      const result = await callOpenAICompatible({ endpoint, model, messages, tools, schema, openrouterProvider, noToolChoice });

      if (tools && result.tool_calls?.length && !result.tool_calls[0].function?.name) {
        throw new Error('Invalid tool call: missing function name');
      }

      results.push({ model, status: 'pass' });
      logger.info('Fallback recovery complete', { results });
      await recordSuccess(endpoint, model, openrouterProvider);
      return result;
    } catch (error) {
      lastError = error;
      results.push({ model, status: 'fail', error: error.message });
      await recordError(endpoint, model, openrouterProvider);
      onModelError?.({ endpoint, model, openrouterProvider, error: error.message, phase: 'fallback' });
    }
  }

  logger.error('All fallback models failed', { results });
  throw new Error(`All models failed. Last error: ${lastError?.message || 'Unknown'}`);
}

export {
  getModels,
  setModels,
  getDefaultModels,
  getEndpoints,
  setEndpoints,
  getConfiguredEndpoints,
  fetchModelsForEndpoint,
  verifyApiKey,
  verifyModel,
  recordSuccess,
  recordError,
  PREDEFINED_ENDPOINTS,
  OPENROUTER_ID,
  CEREBRAS_ID,
  MISTRAL_ID
};

export async function setApiKey(key) {
  const endpoints = await getEndpoints();
  endpoints[OPENROUTER_ID] = { ...endpoints[OPENROUTER_ID], apiKey: key };
  await setEndpoints(endpoints);
  initialized = true;
}

export async function fetchAvailableProviders() {
  const endpoints = await getEndpoints();
  if (!endpoints[OPENROUTER_ID]?.apiKey) return [];

  try {
    const response = await fetch('https://openrouter.ai/api/v1/providers', {
      headers: { 'Authorization': `Bearer ${endpoints[OPENROUTER_ID].apiKey}` }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.data || []).map(p => ({ name: p.name, slug: p.slug }));
  } catch {
    return [];
  }
}
