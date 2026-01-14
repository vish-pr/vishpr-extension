// Background Service Worker
import { verifyApiKey as llmVerifyApiKey, isInitialized } from './modules/llm/index.js';
import { executeAction } from './modules/executor.js';
import { getAction, BROWSER_ROUTER } from './modules/actions/index.js';
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
    return result;
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
