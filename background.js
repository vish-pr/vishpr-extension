// Background Service Worker
import { verifyApiKey as llmVerifyApiKey, isInitialized } from './modules/llm.js';
import { executeAction, getAction } from './modules/orchestrator/executor.js';
import { BROWSER_ROUTER } from './modules/actions/router-action.js';
import logger from './modules/logger.js';
import { getBrowserState } from './modules/browser-state.js';

// Enable side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Listen for messages from side panel
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
    logger.info('API Key Verification Request', { provider: message.provider });
    verifyApiKey(message.apiKey, message.provider)
      .then(result => {
        logger.info('API Key Verification Result', { valid: result.valid, provider: message.provider });
        sendResponse(result);
      })
      .catch(error => {
        logger.error('API Key Verification Failed', { error: error.message });
        sendResponse({ valid: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }
});

async function handleUserMessage({ message, apiKey, tabId, tabUrl }) {
  logger.info('Handling User Message', { userMessage: message, tabId, tabUrl });

  try {
    // Check if any provider is initialized
    if (!(await isInitialized())) {
      throw new Error('No LLM provider configured. Please add an API key in settings.');
    }

    // Get the router action and execute it
    const action = getAction(BROWSER_ROUTER);
    if (!action) {
      throw new Error(`Action not found: ${BROWSER_ROUTER}`);
    }

    logger.info('Executing action', { action: BROWSER_ROUTER });
    const result = await executeAction(action, { user_message: message, page_url: tabUrl, tabId });
    logger.info('Action completed', { hasResponse: !!result.response });

    // Return the response from the action
    return result.response || JSON.stringify(result, null, 2);
  } catch (error) {
    logger.error('Action execution error in background', {
      error: error.message,
      stack: error.stack
    });
    console.error('[Background] Action execution error:', error);
    throw error;
  }
}

// Verify API key using unified LLM client
async function verifyApiKey(apiKey, provider) {
  try {
    const valid = await llmVerifyApiKey(apiKey, provider);
    if (valid) {
      return { valid: true };
    } else {
      return { valid: false, error: 'Invalid API key' };
    }
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// ============================================
// Browser State Management - Tab Lifecycle
// ============================================

// Listen for tab removal to clean up browser state
chrome.tabs.onRemoved.addListener((tabId) => {
  const browserState = getBrowserState();
  browserState.removeTab(tabId);
  logger.info('Tab removed from browser state', { tabId });
});

// Listen for tab URL updates to keep browser state in sync
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const browserState = getBrowserState();
    browserState.registerTab(tabId, changeInfo.url);
    logger.info('Tab URL updated in browser state', { tabId, url: changeInfo.url });
  }
});

// Optional: Persist browser state periodically
setInterval(async () => {
  try {
    const browserState = getBrowserState();
    const stateJSON = browserState.toJSON();
    await chrome.storage.local.set({ browserState: stateJSON });
    logger.debug('Browser state persisted to storage');
  } catch (error) {
    logger.error('Failed to persist browser state', { error: error.message });
  }
}, 60000); // Save every minute

// Load browser state on extension startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    const browserState = getBrowserState();
    const result = await chrome.storage.local.get('browserState');

    if (result.browserState) {
      browserState.fromJSON(result.browserState);
      logger.info('Browser state restored from storage');
    }
  } catch (error) {
    logger.error('Failed to restore browser state', { error: error.message });
  }
});
