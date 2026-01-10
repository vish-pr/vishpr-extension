// Unified LLM Client with Adapter Pattern
// Supports OpenRouter and Gemini APIs

/**
 * @typedef {Object} TextContent
 * @property {'text'} type
 * @property {string} text
 */

/**
 * @typedef {Object} ImageContentPart
 * @property {'image_url'} type
 * @property {Object} image_url
 * @property {string} image_url.url
 * @property {string} [image_url.detail]
 */

/**
 * @typedef {TextContent | ImageContentPart} ContentPart
 */

/**
 * @typedef {Object} Message
 * @property {'user' | 'assistant' | 'system'} role
 * @property {string | ContentPart[]} content
 * @property {string} [name]
 */

/**
 * @typedef {Object} GenerateOptions
 * @property {number} [max_tokens]
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {Object} [response_format]
 */

// ============================================================================
// OpenRouter Client Implementation
// ============================================================================

class OpenRouterClient {
  constructor() {
    this.apiKey = null;
    this.siteUrl = null;
    this.siteName = 'VishPro Browser Agent';
    this.endpoint = 'https://openrouter.ai/api/v1/chat/completions';
  }

  async init(key) {
    this.apiKey = key;
    await chrome.storage.local.set({ openrouterApiKey: key });
  }

  async isInitialized() {
    if (this.apiKey) return true;

    const result = await chrome.storage.local.get(['openrouterApiKey']);
    if (result.openrouterApiKey) {
      this.apiKey = result.openrouterApiKey;
      return true;
    }

    return false;
  }

  async setApiKey(key) {
    this.apiKey = key;
    await chrome.storage.local.set({ openrouterApiKey: key });
  }

  async verifyApiKey(key) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${key}`
        }
      });
      return response.ok;
    } catch (error) {
      console.error('API key verification failed:', error);
      return false;
    }
  }

  getHeaders() {
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };

    if (this.siteUrl) {
      headers['HTTP-Referer'] = this.siteUrl;
    }

    if (this.siteName) {
      headers['X-Title'] = this.siteName;
    }

    return headers;
  }

  async generate(request) {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not set');
    }

    if (!request.model) {
      throw new Error('Model must be specified');
    }

    if (!request.messages || !Array.isArray(request.messages)) {
      throw new Error('Messages must be an array');
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const errorResponse = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        const errorMessage = errorResponse.error?.message || 'Unknown error';
        const errorDetails = errorResponse.error?.metadata?.raw ||
                           errorResponse.error?.metadata?.provider_name ||
                           JSON.stringify(errorResponse.error?.metadata || '');
        const fullError = errorDetails
          ? `${errorMessage} - Details: ${errorDetails}`
          : errorMessage;
        throw new Error(`API request failed: ${fullError}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('Empty response from API');
      }

      return content;
    } catch (error) {
      console.error('OpenRouter request failed:', error);
      throw new Error(`Failed to generate content: ${error.message}`);
    }
  }

  async generateFromPrompt(prompt, model = 'google/gemini-2.5-flash', options = {}) {
    return this.generate({
      messages: [
        { role: 'user', content: prompt }
      ],
      model,
      ...options
    });
  }

  async generateFromMessages(messages, model = 'google/gemini-2.5-flash', options = {}) {
    return this.generate({
      messages,
      model,
      ...options
    });
  }

  async getModels() {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not set');
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error('Failed to fetch models');
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to fetch models:', error);
      throw error;
    }
  }
}

// ============================================================================
// Gemini Client Implementation
// ============================================================================

class GeminiClient {
  constructor() {
    this.apiKey = null;
    this.baseEndpoint = 'https://generativelanguage.googleapis.com/v1beta';
  }

  async init(key) {
    this.apiKey = key;
    await chrome.storage.local.set({ geminiApiKey: key });
  }

  async isInitialized() {
    if (this.apiKey) return true;

    const result = await chrome.storage.local.get(['geminiApiKey']);
    if (result.geminiApiKey) {
      this.apiKey = result.geminiApiKey;
      return true;
    }

    return false;
  }

  async setApiKey(key) {
    this.apiKey = key;
    await chrome.storage.local.set({ geminiApiKey: key });
  }

  async verifyApiKey(key) {
    try {
      const model = 'gemini-2.0-flash-exp';
      const endpoint = `${this.baseEndpoint}/models/${model}?key=${key}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
        mode: 'cors'
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (error) {
      console.error('API key verification failed:', error);
      return false;
    }
  }

  async generate({ prompt, model = 'gemini-2.0-flash-exp', systemInstruction, generationConfig }) {
    if (!this.apiKey) {
      throw new Error('Gemini API key not set');
    }

    const endpoint = `${this.baseEndpoint}/models/${model}:generateContent?key=${this.apiKey}`;

    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }]
    };

    if (systemInstruction) {
      requestBody.systemInstruction = {
        parts: [{ text: systemInstruction }]
      };
    }

    if (generationConfig) {
      requestBody.generationConfig = generationConfig;
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        const errorMessage = errorData.error?.message || `Status ${response.status}`;
        const errorDetails = errorData.error?.details ? JSON.stringify(errorData.error.details) : '';
        const fullError = errorDetails
          ? `${errorMessage} - Details: ${errorDetails}`
          : errorMessage;
        throw new Error(`API request failed: ${fullError}`);
      }

      const data = await response.json();
      const result = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!result) {
        throw new Error('Empty response from Gemini API');
      }

      return result;
    } catch (error) {
      console.error('Gemini request failed:', error);
      throw new Error(`Failed to generate content: ${error.message}`);
    }
  }

  async generateFromMessages(messages, model = 'gemini-2.0-flash-exp', options = {}) {
    let systemInstruction;
    const conversationMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
      } else {
        conversationMessages.push(msg);
      }
    }

    const prompt = conversationMessages
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');

    return this.generate({
      prompt,
      model,
      systemInstruction,
      ...options
    });
  }

  async generateFromPrompt(prompt, model = 'gemini-2.0-flash-exp', options = {}) {
    return this.generate({
      prompt,
      model,
      ...options
    });
  }
}

// ============================================================================
// Unified LLM Client Adapter
// ============================================================================

class LLMClient {
  constructor() {
    this.provider = 'openrouter'; // Default provider
    this.openRouterClient = new OpenRouterClient();
    this.geminiClient = new GeminiClient();
  }

  /**
   * Set the active provider
   * @param {'openrouter' | 'gemini'} provider
   */
  async setProvider(provider) {
    if (provider !== 'openrouter' && provider !== 'gemini') {
      throw new Error('Invalid provider. Must be "openrouter" or "gemini"');
    }
    this.provider = provider;
    await chrome.storage.local.set({ llmProvider: provider });
  }

  /**
   * Get the active provider
   * @returns {Promise<string>}
   */
  async getProvider() {
    if (this.provider) return this.provider;

    const result = await chrome.storage.local.get(['llmProvider']);
    if (result.llmProvider) {
      this.provider = result.llmProvider;
    }

    return this.provider;
  }

  /**
   * Get the current active client
   * @returns {OpenRouterClient | GeminiClient}
   */
  getActiveClient() {
    return this.provider === 'gemini' ? this.geminiClient : this.openRouterClient;
  }

  /**
   * Initialize with API key
   * @param {string} key
   * @param {'openrouter' | 'gemini'} [provider]
   */
  async init(key, provider) {
    if (provider) {
      await this.setProvider(provider);
    }
    return this.getActiveClient().init(key);
  }

  /**
   * Check if initialized
   * @returns {Promise<boolean>}
   */
  async isInitialized() {
    return this.getActiveClient().isInitialized();
  }

  /**
   * Set API key for current provider
   * @param {string} key
   */
  async setApiKey(key) {
    return this.getActiveClient().setApiKey(key);
  }

  /**
   * Verify API key
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async verifyApiKey(key) {
    return this.getActiveClient().verifyApiKey(key);
  }

  /**
   * Generate from messages (unified interface)
   * @param {Message[]} messages
   * @param {string} [model]
   * @param {GenerateOptions} [options]
   * @returns {Promise<string>}
   */
  async generateFromMessages(messages, model, options = {}) {
    const client = this.getActiveClient();

    // Use provider-specific default models if not specified
    if (!model) {
      model = this.provider === 'gemini'
        ? 'gemini-2.0-flash-exp'
        : 'google/gemini-2.5-flash';
    }

    return client.generateFromMessages(messages, model, options);
  }

  /**
   * Generate from simple prompt (unified interface)
   * @param {string} prompt
   * @param {string} [model]
   * @param {GenerateOptions} [options]
   * @returns {Promise<string>}
   */
  async generateFromPrompt(prompt, model, options = {}) {
    const client = this.getActiveClient();

    if (!model) {
      model = this.provider === 'gemini'
        ? 'gemini-2.0-flash-exp'
        : 'google/gemini-2.5-flash';
    }

    return client.generateFromPrompt(prompt, model, options);
  }

  /**
   * Get available models (OpenRouter only)
   * @returns {Promise<Object>}
   */
  async getModels() {
    if (this.provider !== 'openrouter') {
      throw new Error('getModels() is only available for OpenRouter provider');
    }
    return this.openRouterClient.getModels();
  }

  /**
   * Direct access to provider-specific clients
   */
  get openRouter() {
    return this.openRouterClient;
  }

  get gemini() {
    return this.geminiClient;
  }
}

// Create singleton instance
const llmClient = new LLMClient();

// Export everything
export default llmClient;
export { LLMClient, OpenRouterClient, GeminiClient };
