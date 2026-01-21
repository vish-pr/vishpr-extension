// Background Service Worker
import { isInitialized } from './modules/llm/index.js';
import { executeAction, unwrapFinalAnswer } from './modules/executor.js';
import { getAction, BROWSER_ROUTER } from './modules/actions/index.js';
import logger from './modules/logger.js';
import { getChromeAPI } from './modules/chrome-api.js';

// Enable side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  const chromeAPI = getChromeAPI();
  chromeAPI.setWindowId(tab.windowId);
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Listen for messages from side panel and DevTools
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'processMessage') {
    handleUserMessage(message)
      .then(result => sendResponse({ result }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

async function handleUserMessage({ message }) {
  const actionName = BROWSER_ROUTER;
  const params = { user_message: message };

  try {
    if (!(await isInitialized())) {
      throw new Error('No LLM endpoints configured. Please configure an endpoint in settings.');
    }

    const action = getAction(actionName);
    const result = await executeAction(action, params);
    const { _traceUUID: traceId, _duration: duration } = result;

    logger.info('Execution trace', { traceId, duration });

    return unwrapFinalAnswer(result);
  } catch (error) {
    logger.error('Execution failed', { error: error.message });
    throw error;
  }
}
