// Unified LLM Client with Provider Failover
// Supports both Gemini and OpenRouter

import llmClient from './llm-client.js';
import { getCascadingModels, INTELLIGENCE_LEVEL } from './llm-config.js';
import logger from './logger.js';

// Extract individual clients from unified client
const geminiClient = llmClient.gemini;
const openRouterClient = llmClient.openRouter;

/**
 * @typedef {Object} LLMProvider
 * @property {Function} generate
 * @property {Function} isInitialized
 * @property {Function} setApiKey
 * @property {Function} verifyApiKey
 */

/** @type {Object.<string, LLMProvider>} */
const providers = {
  gemini: geminiClient,
  openrouter: openRouterClient
};

// Fail-fast mechanism: track failures and skips
const modelFailures = new Map();

/**
 * Extract JSON from response, handling markdown code blocks
 * @param {string} text - Response text
 * @returns {string} Extracted JSON string
 */
function extractJSON(text) {
  // Try to extract from markdown code blocks first
  const jsonBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }

  // Try to find JSON object in the text (greedy match)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0].trim();
  }

  // Return as is and let JSON.parse handle it
  return text.trim();
}


/**
 * Build a human-readable schema hint for the LLM
 * @param {Object} schema - JSON schema object
 * @returns {string} Schema description for prompt
 */
function buildSchemaHint(schema) {
  if (!schema || !schema.properties) {
    return 'Respond with a JSON object.';
  }

  const required = schema.required || [];
  const fields = [];

  for (const [key, prop] of Object.entries(schema.properties)) {
    const isRequired = required.includes(key);
    const requiredMark = isRequired ? ' (REQUIRED)' : ' (optional)';

    let fieldDesc = `  "${key}"${requiredMark}`;

    if (prop.type) {
      fieldDesc += `: ${prop.type}`;
    }

    if (prop.enum) {
      fieldDesc += ` - one of: ${prop.enum.slice(0, 5).join(', ')}${prop.enum.length > 5 ? '...' : ''}`;
    }

    if (prop.description) {
      // Take first sentence only
      const desc = prop.description.split('.')[0];
      if (desc.length < 80) {
        fieldDesc += ` - ${desc}`;
      }
    }

    fields.push(fieldDesc);
  }

  return `IMPORTANT: Respond with a JSON object with these EXACT field names:
{
${fields.join(',\n')}
}`;
}

/**
 * Get model key for tracking
 * @param {Object} selection
 * @returns {string}
 */
function getModelKey(selection) {
  return `${selection.provider}:${selection.model}`;
}

/**
 * Check if model should be skipped
 * @param {Object} selection
 * @returns {boolean}
 */
function shouldSkipModel(selection) {
  const key = getModelKey(selection);
  const tracker = modelFailures.get(key);
  if (!tracker || tracker.failures === 0) return false;

  if (tracker.skips < tracker.failures) {
    tracker.skips++;
    return true;
  }
  return false;
}

/**
 * Record model failure
 * @param {Object} selection
 */
function recordFailure(selection) {
  const key = getModelKey(selection);
  const tracker = modelFailures.get(key);
  if (!tracker) {
    modelFailures.set(key, { failures: 1, skips: 0 });
  } else if (tracker.skips >= tracker.failures) {
    tracker.failures++;
    tracker.skips = 0;
  }
}

/**
 * Record model success
 * @param {Object} selection
 */
function recordSuccess(selection) {
  modelFailures.delete(getModelKey(selection));
}

/**
 * Get available providers
 * @returns {Promise<Set<string>>}
 */
async function getAvailableProviders() {
  const available = new Set();

  if (await providers.gemini.isInitialized()) {
    available.add('gemini');
  }
  if (await providers.openrouter.isInitialized()) {
    available.add('openrouter');
  }

  return available;
}

/**
 * Generate with specific model
 * @param {Object} selection - Model selection
 * @param {Array} messages - Chat messages
 * @param {Object} schema - JSON schema for structured output (REQUIRED)
 * @returns {Promise<string>}
 */
async function generateWithModel(selection, messages, schema) {
  const { provider, model, routing } = selection;

  logger.info(`LLM Call: ${provider}:${model}`, {
    provider,
    model,
    routing,
    messageCount: messages.length
  });

  if (provider === 'gemini') {
    // Gemini doesn't have native JSON mode yet, but we can request JSON in the prompt
    // Build schema hint from the actual schema structure
    const schemaHint = buildSchemaHint(schema);

    // Add JSON instruction to the last user message - need proper copy
    const modifiedMessages = messages.map(msg => ({ ...msg }));
    const lastMessage = modifiedMessages[modifiedMessages.length - 1];
    if (lastMessage.role === 'user') {
      lastMessage.content += `\n\nIMPORTANT: You MUST respond with valid JSON only. Do not include any text, markdown formatting, or explanation - just the JSON object.\n\n${schemaHint}`;
    }
    logger.debug('LLM Input (Gemini with schema)', { messages: modifiedMessages });
    const result = await providers.gemini.generateFromMessages(modifiedMessages, model);
    logger.debug('LLM Output (Gemini)', { result });
    return result;
  } else if (provider === 'openrouter') {
    const options = {};

    // Add provider routing if specified
    if (routing?.only) {
      options.provider = { only: routing.only };
    }

    // Add JSON schema mode (always required)
    // Pass complete JSON schema in response_format
    // Schema must follow OpenRouter strict mode requirements:
    // - Objects with properties must have additionalProperties: false
    // - Objects without properties must have properties: {} and additionalProperties: true
    // - Arrays must have items defined
    options.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema: schema
      }
    };

    logger.debug('LLM Input (OpenRouter with schema)', { messages, options });
    const result = await providers.openrouter.generateFromMessages(messages, model, options);
    logger.debug('LLM Output (OpenRouter)', { result });
    return result;
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Generate content with automatic failover
 * @param {Object} params
 * @param {Array} params.messages - Array of {role, content} messages
 * @param {string} [params.intelligence='MEDIUM'] - Intelligence level
 * @param {Object} params.schema - JSON schema for structured output (REQUIRED)
 * @returns {Promise<Object>} Parsed JSON object matching the schema
 */
export async function generate({ messages, intelligence = 'MEDIUM', schema }) {
  // Schema is now required for all LLM calls
  if (!schema) {
    throw new Error('Schema is required for all LLM calls. Please provide a valid JSON schema.');
  }

  const availableProviders = await getAvailableProviders();

  if (availableProviders.size === 0) {
    throw new Error('No LLM provider is available. Please configure an API key for Gemini or OpenRouter.');
  }

  const cascadingModels = getCascadingModels(intelligence, availableProviders);

  if (cascadingModels.length === 0) {
    throw new Error('No models available for the requested intelligence level.');
  }

  let lastError = null;

  for (const selection of cascadingModels) {
    // Skip if fail-fast mechanism indicates
    if (shouldSkipModel(selection)) {
      logger.debug(`Skipping ${selection.provider}:${selection.model} due to fail-fast`);
      continue;
    }

    try {
      const result = await generateWithModel(selection, messages, schema);

      // Check if result is empty
      if (!result || (typeof result === 'string' && result.trim() === '')) {
        throw new Error('Empty response from LLM');
      }

      logger.info(`LLM Success: ${selection.provider}:${selection.model}`);
      recordSuccess(selection);

      // Parse and return JSON (schema is always required)
      try {
        if (typeof result === 'string') {
          const jsonString = extractJSON(result);
          const parsed = JSON.parse(jsonString);
          return parsed;
        }
        return result;
      } catch (parseError) {
        logger.error('[LLM] Failed to parse JSON response', { result });
        throw new Error(`Failed to parse JSON response: ${parseError.message}. Response: ${result?.substring(0, 200)}`);
      }
    } catch (error) {
      lastError = error;
      recordFailure(selection);
      logger.warn(`LLM Failure: ${selection.provider}:${selection.model}`, { error: error.message });
    }
  }

  logger.error('All LLM models failed', {
    intelligence,
    attemptedModels: cascadingModels.length,
    lastError: lastError?.message
  });

  throw new Error(`All LLM requests failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Check if any provider is initialized
 * @returns {Promise<boolean>}
 */
export async function isInitialized() {
  const availableProviders = await getAvailableProviders();
  return availableProviders.size > 0;
}

/**
 * Set API key for a provider
 * @param {string} key - API key
 * @param {'gemini' | 'openrouter'} [provider] - Provider name
 */
export async function setApiKey(key, provider) {
  if (provider) {
    await providers[provider].setApiKey(key);
  } else {
    // Auto-detect provider from key format
    if (key.startsWith('AIza')) {
      await providers.gemini.setApiKey(key);
    } else if (key.startsWith('sk-or-')) {
      await providers.openrouter.setApiKey(key);
    } else {
      throw new Error('Cannot determine provider from API key format. Please specify provider explicitly.');
    }
  }
}

/**
 * Verify API key
 * @param {string} key - API key
 * @param {'gemini' | 'openrouter'} [provider] - Provider name
 * @returns {Promise<boolean>}
 */
export async function verifyApiKey(key, provider) {
  if (provider) {
    return await providers[provider].verifyApiKey(key);
  }

  // Auto-detect provider from key format
  if (key.startsWith('AIza')) {
    return await providers.gemini.verifyApiKey(key);
  } else if (key.startsWith('sk-or-')) {
    return await providers.openrouter.verifyApiKey(key);
  }

  return false;
}

// Export providers for direct access if needed
export { providers, INTELLIGENCE_LEVEL };
