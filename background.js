// Background Service Worker
import { verifyApiKey as llmVerifyApiKey, isInitialized } from './modules/llm/index.js';
import { executeAction, unwrapFinalAnswer } from './modules/executor.js';
import { getAction, BROWSER_ROUTER, actionsRegistry } from './modules/actions/index.js';
import logger from './modules/logger.js';
import { getChromeAPI } from './modules/chrome-api.js';
import { tracer } from './modules/trace-collector.js';
import { generateAndStoreCritique } from './modules/critique.js';
import { storeTrace, getTraces, getTraceByRunId, deleteTrace, clearTraces } from './modules/trace-storage.js';

// Enable side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
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

    await storeTrace({
      runId,
      timestamp: new Date().toISOString(),
      actionName: BROWSER_ROUTER,
      params: { user_message: message },
      status: 'success',
      duration: trace?.duration,
      trace,
      critique: null,
    });

    runCritiqueAsync(runId, trace);
    tracer.cleanup(traceUUID); // Free memory

    return unwrapFinalAnswer(result);
  } catch (error) {
    // On error, we may not have a trace UUID
    logger.error('Execution failed', { runId, error: error.message });

    await storeTrace({
      runId,
      timestamp: new Date().toISOString(),
      actionName: BROWSER_ROUTER,
      params: { user_message: message },
      status: 'error',
      error: error.message,
      trace: null,
      critique: null,
    });

    throw error;
  }
}

// Non-blocking critique runner (fire-and-forget)
function runCritiqueAsync(runId, trace) {
  if (!trace) return;
  generateAndStoreCritique(runId, trace).catch(e =>
    console.error('Critique failed:', e.message)
  );
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

    await storeTrace({
      runId,
      timestamp: new Date().toISOString(),
      actionName,
      params: params || {},
      status: 'success',
      duration: trace?.duration,
      trace,
      critique: null,
    });

    runCritiqueAsync(runId, trace);
    tracer.cleanup(traceUUID);

    return {
      result: result.result,
      trace,
    };
  } catch (error) {
    logger.error('Execution failed', { runId, error: error.message });

    await storeTrace({
      runId,
      timestamp: new Date().toISOString(),
      actionName,
      params: params || {},
      status: 'error',
      error: error.message,
      trace: null,
      critique: null,
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

setInterval(async () => {
  try {
    const chromeAPI = getChromeAPI();
    const stateJSON = chromeAPI.toJSON();
    await chrome.storage.local.set({ browserState: stateJSON });
    logger.debug('Browser state persisted to storage');
  } catch (error) {
    logger.error('Failed to persist browser state', { error: error.message });
  }
}, 60000);

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
