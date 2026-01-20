// Background Service Worker
import { verifyApiKey as llmVerifyApiKey, isInitialized } from './modules/llm/index.js';
import { executeAction, unwrapFinalAnswer } from './modules/executor.js';
import { getAction, BROWSER_ROUTER, actionsRegistry } from './modules/actions/index.js';
import logger from './modules/logger.js';
import { getChromeAPI } from './modules/chrome-api.js';
import { getTraces, getTraceById, deleteTrace } from './modules/trace-collector.js';

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
  } else if (message.action === 'verifyApiKey') {
    verifyApiKey(message.apiKey)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ valid: false, error: error.message }));
    return true;
  } else if (message.type === 'DEBUG_PING') {
    sendResponse({ connected: true });
    return true;
  } else if (message.type === 'DEBUG_EXECUTE') {
    handleDebugExecute(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  } else if (message.type === 'GET_TRACES') {
    getTraces(message.limit || 50)
      .then(traces => sendResponse({ traces }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  } else if (message.type === 'GET_TRACE_BY_ID') {
    getTraceById(message.traceId)
      .then(trace => sendResponse({ trace }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  } else if (message.type === 'DELETE_TRACE') {
    deleteTrace(message.traceId)
      .then(() => sendResponse({ success: true }))
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

// Verify API key
async function verifyApiKey(apiKey) {
  try {
    return await llmVerifyApiKey(apiKey);
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Handle debug execution from DevTools panel
async function handleDebugExecute({ actionName, params }) {
  const cleanParams = params || {};

  try {
    if (!(await isInitialized())) {
      throw new Error('No LLM endpoints configured. Please configure an endpoint in settings.');
    }

    const action = actionsRegistry[actionName];
    if (!action) {
      throw new Error(`Unknown action: ${actionName}`);
    }

    const result = await executeAction(action, cleanParams);
    const { _traceUUID: traceId, _duration: duration } = result;

    logger.info('Execution trace', { traceId, duration });

    // Fetch the built trace for response
    const traceData = await getTraceById(traceId);

    return { result: result.result, trace: traceData?.trace, traceId };
  } catch (error) {
    logger.error('Execution failed', { error: error.message });
    return { error: error.message, trace: null };
  }
}

