// Background Service Worker
import { isInitialized } from './modules/llm/index.js';
import { executeAction, unwrapFinalAnswer } from './modules/executor.js';
import { getAction, BROWSER_ROUTER } from './modules/actions/index.js';
import logger from './modules/logger.js';
import { getChromeAPI } from './modules/chrome-api.js';

// Track panel open state per window
const panelOpenState = new Map();
// Lock to prevent race conditions from rapid clicks
const toggleLock = new Map();

// Toggle side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  await toggleSidePanel(tab.windowId);
});

async function toggleSidePanel(windowId) {
  // Prevent rapid toggle attempts
  if (toggleLock.get(windowId)) {
    return;
  }
  toggleLock.set(windowId, true);

  try {
    const chromeAPI = getChromeAPI();
    chromeAPI.setWindowId(windowId);

    if (panelOpenState.get(windowId)) {
      // Panel is open, close it - set state optimistically
      panelOpenState.set(windowId, false);
      try {
        await chrome.sidePanel.close({ windowId });
      } catch {
        // Panel may already be closed, state already updated
      }
    } else {
      // Panel is closed, open it - set state optimistically
      panelOpenState.set(windowId, true);
      try {
        await chrome.sidePanel.open({ windowId });
      } catch (error) {
        // Failed to open, revert state
        panelOpenState.set(windowId, false);
        logger.error('Failed to open side panel', { error: error.message });
      }
    }
  } finally {
    // Release lock after a short delay to debounce rapid clicks
    setTimeout(() => toggleLock.set(windowId, false), 200);
  }
}

// Listen for messages from side panel and DevTools
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'panelOpened') {
    // Get window ID from sender tab or use current window
    chrome.windows.getCurrent().then(window => {
      panelOpenState.set(window.id, true);
    });
    return false;
  }

  if (message.action === 'panelClosed') {
    chrome.windows.getCurrent().then(window => {
      panelOpenState.set(window.id, false);
    });
    return false;
  }

  if (message.action === 'requestPanelClose') {
    chrome.windows.getCurrent().then(async window => {
      panelOpenState.set(window.id, false);
      try {
        await chrome.sidePanel.close({ windowId: window.id });
      } catch {
        // Panel may already be closed
      }
    });
    return false;
  }

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
