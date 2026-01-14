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
  getDefaultModels
} from './models.js';
import {
  getEndpoints,
  setEndpoints,
  getConfiguredEndpoints,
  fetchModelsForEndpoint,
  verifyApiKey,
  PREDEFINED_ENDPOINTS,
  OPENROUTER_ID
} from './endpoints.js';

let initialized = false;

export async function isInitialized() {
  if (initialized) return true;
  const endpoints = await getEndpoints();
  initialized = Object.keys(endpoints).length > 0;
  return initialized;
}

export async function generate({ messages, intelligence = 'MEDIUM', tools, schema }) {
  if (!tools?.length && !schema) {
    throw new Error('Either tools or schema is required');
  }

  if (!await isInitialized()) {
    throw new Error('No LLM endpoints configured');
  }

  const cascadingModels = await getCascadingModels(intelligence);
  let lastError = null;

  for (const { endpoint, model, openrouterProvider, noToolChoice } of cascadingModels) {
    if (await shouldSkip(endpoint, model, openrouterProvider)) {
      logger.debug(`Skipping ${endpoint}:${model} (backoff)`);
      continue;
    }

    try {
      const logInfo = tools ? { toolCount: tools.length } : { schema: true };
      logger.info(`LLM Request: ${endpoint}/${model}`, { messageCount: messages.length, intelligence, ...logInfo });

      const result = await callOpenAICompatible({ endpoint, model, messages, tools, schema, openrouterProvider, noToolChoice });

      if (tools && result.tool_calls?.length && !result.tool_calls[0].function?.name) {
        throw new Error('Invalid tool call: missing function name');
      }

      logger.info(`LLM Response: ${endpoint}/${model}`);
      logger.debug('LLM Response Details', { endpoint, model, response: result });

      await recordSuccess(endpoint, model, openrouterProvider);
      return result;

    } catch (error) {
      lastError = error;
      await recordError(endpoint, model, openrouterProvider);
      logger.warn(`LLM Failure: ${endpoint}/${model}`, { error: error.message });
    }
  }

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
  PREDEFINED_ENDPOINTS,
  OPENROUTER_ID
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
