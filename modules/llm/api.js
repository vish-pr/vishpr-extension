/**
 * LLM API - Core OpenAI-compatible API call
 */

import logger from '../logger.js';
import { resolveEndpoint, getEndpoints } from './endpoints.js';

export async function callOpenAICompatible({ endpoint, model, messages, tools, schema, openrouterProvider, noToolChoice }) {
  const endpoints = await getEndpoints();
  const config = resolveEndpoint(endpoint, endpoints);

  const request = { model, messages };

  // Standard OpenAI params
  if (tools?.length) {
    request.tools = tools;
    if (!noToolChoice) {
      request.tool_choice = 'required';
    }
  } else if (schema) {
    request.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema }
    };
  }

  // OpenRouter provider routing
  if (openrouterProvider) {
    request.provider = { only: [openrouterProvider] };
  }

  logger.debug('LLM Request Details', { endpoint, model, request });

  const response = await fetch(config.url, {
    method: 'POST',
    headers: config.headers,
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || 'Unknown error';
    const details = err.error?.metadata?.raw || err.error?.metadata?.provider_name || '';
    throw new Error(details ? `${msg} - ${details}` : msg);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;

  if (!message) {
    throw new Error('Empty response from API');
  }

  // For structured schema, parse JSON from content
  if (schema && message.content) {
    try {
      return JSON.parse(message.content);
    } catch (e) {
      logger.error('Failed to parse schema response', { content: message.content, error: e.message });
      throw new Error(`Invalid JSON in schema response: ${e.message}`);
    }
  }

  return message;
}

export async function verifyModel(endpointName, modelId, openrouterProvider = null) {
  const endpoints = await getEndpoints();

  const VERIFY_TOOL = [{
    type: 'function',
    function: { name: 'test', description: 'Test function', parameters: { type: 'object', properties: {} } }
  }];

  try {
    const config = resolveEndpoint(endpointName, endpoints);

    const baseRequest = {
      model: modelId,
      messages: [{ role: 'user', content: 'Call the test function' }],
      max_tokens: 500,
      tools: VERIFY_TOOL
    };

    // OpenRouter provider routing
    if (openrouterProvider) {
      baseRequest.provider = { only: [openrouterProvider] };
    }

    // First try with tool_choice
    let response = await fetch(config.url, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify({ ...baseRequest, tool_choice: 'required' })
    });

    if (response.ok) {
      return { valid: true };
    }

    const err = await response.json().catch(() => ({}));
    const errorMsg = err.error?.message || 'Model verification failed';

    // Check if it's a tool_choice error - retry without tool_choice
    const lowerMsg = errorMsg.toLowerCase();
    if (lowerMsg.includes('tool_choice') || lowerMsg.includes('tool choice') ||
        (lowerMsg.includes('tool') && lowerMsg.includes('not supported'))) {

      response = await fetch(config.url, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify(baseRequest)
      });

      if (response.ok) {
        return { valid: true, noToolChoice: true };
      }

      const retryErr = await response.json().catch(() => ({}));
      return { valid: false, error: retryErr.error?.message || 'Model verification failed' };
    }

    return { valid: false, error: errorMsg };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
