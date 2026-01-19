// Background Service Worker
import { verifyApiKey as llmVerifyApiKey, isInitialized } from './modules/llm/index.js';
import { executeAction, unwrapFinalAnswer } from './modules/executor.js';
import { getAction, BROWSER_ROUTER, CRITIQUE, actionsRegistry } from './modules/actions/index.js';
import logger from './modules/logger.js';
import { getChromeAPI } from './modules/chrome-api.js';
import { tracer } from './modules/trace-collector.js';
import { storeTrace, getTraces, getTraceByRunId, deleteTrace, clearTraces, updateTrace } from './modules/trace-storage.js';

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
  } else if (message.type === 'GET_TRACE_BY_RUN_ID') {
    getTraceByRunId(message.runId)
      .then(trace => sendResponse({ trace }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  } else if (message.type === 'DELETE_TRACE') {
    deleteTrace(message.runId)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  } else if (message.type === 'CLEAR_TRACES') {
    clearTraces()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

async function handleUserMessage({ message }) {
  const runId = Date.now().toString();

  try {
    if (!(await isInitialized())) {
      throw new Error('No LLM endpoints configured. Please configure an endpoint in settings.');
    }

    const action = getAction(BROWSER_ROUTER);
    // executeAction now handles tracing internally, returns _traceUUID
    const result = await executeAction(action, { user_message: message });
    const traceUUID = result._traceUUID;
    const trace = tracer.getTrace(traceUUID);

    logger.info('Execution trace', { runId, traceUUID });
    await storeSuccessTrace(runId, BROWSER_ROUTER, { user_message: message }, trace);
    runCritiqueAsync(runId, trace);
    tracer.cleanup(traceUUID); // Free memory

    return unwrapFinalAnswer(result);
  } catch (error) {
    logger.error('Execution failed', { runId, error: error.message });
    await storeErrorTrace(runId, BROWSER_ROUTER, { user_message: message }, error.message);
    throw error;
  }
}

// Trace storage helpers
const storeSuccessTrace = (runId, actionName, params, trace) => storeTrace({
  runId, timestamp: new Date().toISOString(), actionName, params,
  status: 'success', duration: trace?.duration, trace, critique: null,
});

const storeErrorTrace = (runId, actionName, params, errorMessage) => storeTrace({
  runId, timestamp: new Date().toISOString(), actionName, params,
  status: 'error', error: errorMessage, trace: null, critique: null,
});

// Non-blocking critique runner (fire-and-forget)
async function runCritiqueAsync(runId, trace) {
  if (!trace) return;
  try {
    const critiqueAction = getAction(CRITIQUE);
    const result = await executeAction(critiqueAction, { trace });
    await updateTrace(runId, { critique: result.result });
  } catch (e) {
    console.error('Critique failed:', e.message);
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
  try {
    if (!(await isInitialized())) {
      throw new Error('No LLM endpoints configured. Please configure an endpoint in settings.');
    }

    const action = actionsRegistry[actionName];
    if (!action) {
      throw new Error(`Unknown action: ${actionName}`);
    }

    const result = await executeAction(action, params || {});
    const traceUUID = result._traceUUID;
    const trace = tracer.getTrace(traceUUID);

    logger.info('Execution trace', { runId, traceUUID });
    await storeSuccessTrace(runId, actionName, params || {}, trace);
    runCritiqueAsync(runId, trace);
    tracer.cleanup(traceUUID);

    return { result: result.result, trace };
  } catch (error) {
    logger.error('Execution failed', { runId, error: error.message });
    await storeErrorTrace(runId, actionName, params || {}, error.message);
    return { error: error.message, trace: null };
  }
}

