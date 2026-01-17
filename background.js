// Background Service Worker
import { verifyApiKey as llmVerifyApiKey, isInitialized } from './modules/llm/index.js';
import { executeAction, unwrapFinalAnswer } from './modules/executor.js';
import { getAction, BROWSER_ROUTER, actionsRegistry } from './modules/actions/index.js';
import logger from './modules/logger.js';
import { getChromeAPI } from './modules/chrome-api.js';
import { TraceCollector } from './modules/trace-collector.js';

// Enable side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Listen for messages from side panel and DevTools
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'processMessage') {
    handleUserMessage(message)
      .then(result => {
        logger.info('User Message Processed Successfully');
        sendResponse({ result });
      })
      .catch(error => {
        logger.error('User Message Processing Failed', { error: error.message, stack: error.stack });
        sendResponse({ error: error.message });
      });
    return true; // Keep channel open for async response
  } else if (message.action === 'verifyApiKey') {
    logger.info('API Key Verification Request');
    verifyApiKey(message.apiKey)
      .then(result => {
        logger.info('API Key Verification Result', { valid: result.valid });
        sendResponse(result);
      })
      .catch(error => {
        logger.error('API Key Verification Failed', { error: error.message });
        sendResponse({ valid: false, error: error.message });
      });
    return true; // Keep channel open for async response
  } else if (message.type === 'DEBUG_PING') {
    // DevTools panel connection check
    sendResponse({ connected: true });
    return true;
  } else if (message.type === 'DEBUG_EXECUTE') {
    // Execute action with tracing for DevTools debug panel
    handleDebugExecute(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function handleUserMessage({ message }) {
  logger.info('Handling User Message', { userMessage: message });

  try {
    // Check if any endpoint is configured
    if (!(await isInitialized())) {
      throw new Error('No LLM endpoints configured. Please configure an endpoint in settings.');
    }

    const action = getAction(BROWSER_ROUTER);
    logger.info('Executing action', { action: BROWSER_ROUTER });
    const result = await executeAction(action, { user_message: message });
    logger.info('Action completed');
    // Unwrap final answer at top level for display to user
    return unwrapFinalAnswer(result);
  } catch (error) {
    logger.error('Action execution error in background', {
      error: error.message,
      stack: error.stack
    });
    console.error('[Background] Action execution error:', error);
    throw error;
  }
}

// Verify API key
async function verifyApiKey(apiKey) {
  try {
    return await llmVerifyApiKey(apiKey);
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Handle debug execution from DevTools panel
async function handleDebugExecute({ actionName, params, runId }) {
  logger.info('Debug Execute', { actionName, runId });

  try {
    // Check if LLM is initialized
    if (!(await isInitialized())) {
      throw new Error('No LLM endpoints configured. Please configure an endpoint in settings.');
    }

    // Get the action from registry
    const action = actionsRegistry[actionName];
    if (!action) {
      throw new Error(`Unknown action: ${actionName}`);
    }

    // Create trace collector
    const traceCollector = new TraceCollector(runId);

    // Execute action with tracing
    const result = await executeAction(action, params || {}, null, traceCollector);

    // Get the complete trace
    const trace = traceCollector.getTrace();

    logger.info('Debug Execute Complete', { actionName, runId });

    return {
      result: result.result,
      trace: trace,
    };
  } catch (error) {
    logger.error('Debug Execute Failed', {
      actionName,
      runId,
      error: error.message,
      stack: error.stack
    });

    return {
      error: error.message,
      trace: null,
    };
  }
}

// ============================================
// Browser State Persistence
// ============================================
// Note: Tab lifecycle (onRemoved, onUpdated, onActivated) is handled
// internally by chrome-api.js. Only persistence logic needed here.

// Persist browser state periodically
setInterval(async () => {
  try {
    const chromeAPI = getChromeAPI();
    const stateJSON = chromeAPI.toJSON();
    await chrome.storage.local.set({ browserState: stateJSON });
    logger.debug('Browser state persisted to storage');
  } catch (error) {
    logger.error('Failed to persist browser state', { error: error.message });
  }
}, 60000); // Save every minute

// Load browser state on extension startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    const chromeAPI = getChromeAPI();
    const result = await chrome.storage.local.get('browserState');

    if (result.browserState) {
      chromeAPI.fromJSON(result.browserState);
      logger.info('Browser state restored from storage');
    }
  } catch (error) {
    logger.error('Failed to restore browser state', { error: error.message });
  }
});
