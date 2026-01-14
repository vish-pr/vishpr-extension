/**
 * LLM Endpoints - Predefined configs and endpoint management
 */

const CACHE_TTL = 5 * 60 * 1000;

// Endpoint ID constants
export const OPENROUTER_ID = 'openrouter';
export const GROQ_ID = 'groq';
export const GEMINI_ID = 'gemini';

export const PREDEFINED_ENDPOINTS = {
  [OPENROUTER_ID]: {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    extraHeaders: { 'X-Title': 'VishPro Browser Agent' }
  },
  [GROQ_ID]: {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models'
  },
  [GEMINI_ID]: {
    name: 'Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models'
  }
};

const modelsCache = new Map();

export async function getEndpoints() {
  return (await chrome.storage.local.get(['llmEndpoints'])).llmEndpoints || {};
}

export async function setEndpoints(endpoints) {
  await chrome.storage.local.set({ llmEndpoints: endpoints });
}

export function resolveEndpoint(endpointName, endpoints) {
  const predefined = PREDEFINED_ENDPOINTS[endpointName];
  const userConfig = endpoints[endpointName];

  if (!predefined && !userConfig?.url) {
    throw new Error(`No URL configured for endpoint: ${endpointName}`);
  }

  const apiKey = userConfig?.apiKey || '';

  return {
    name: predefined?.name || endpointName,
    url: predefined?.url || userConfig.url,
    apiKey,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      ...(predefined?.extraHeaders || {})
    },
    modelsUrl: predefined?.modelsUrl || userConfig.modelsUrl
  };
}

export function getConfiguredEndpoints(endpoints) {
  const result = [];

  for (const [id, config] of Object.entries(PREDEFINED_ENDPOINTS)) {
    if (endpoints[id]) {
      result.push({ id, name: config.name, predefined: true });
    }
  }

  for (const [id, config] of Object.entries(endpoints)) {
    if (!PREDEFINED_ENDPOINTS[id]) {
      result.push({ id, name: id, predefined: false, url: config.url });
    }
  }

  return result;
}

export async function fetchModelsForEndpoint(endpointName, endpoints) {
  const cached = modelsCache.get(endpointName);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.models;
  }

  try {
    const config = resolveEndpoint(endpointName, endpoints);
    if (!config.modelsUrl) return [];

    const response = await fetch(config.modelsUrl, {
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}
    });

    if (!response.ok) return cached?.models || [];

    const data = await response.json();
    const models = (data.data || []).map(m => ({ id: m.id, name: m.name || m.id }));

    modelsCache.set(endpointName, { models, time: Date.now() });
    return models;
  } catch {
    return cached?.models || [];
  }
}

export async function verifyApiKey(apiKey, endpointName = OPENROUTER_ID) {
  const predefined = PREDEFINED_ENDPOINTS[endpointName];
  if (!predefined) return { valid: false, error: 'Unknown endpoint' };

  try {
    const response = await fetch(predefined.modelsUrl, {
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
    });
    return { valid: response.ok, error: response.ok ? null : 'Invalid API key' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
