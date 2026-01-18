/**
 * Trace Storage - Persists execution traces with their critiques
 * Uses UUID-based keys for efficient individual access
 */

const INDEX_KEY = 'traces_index';
const TRACE_PREFIX = 'trace_';
const MAX_TRACES = 100;

/**
 * Store a new trace record
 */
export async function storeTrace(record) {
  const { runId } = record;
  const traceKey = TRACE_PREFIX + runId;

  // Get current index
  const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);

  // Add to front of index
  index.unshift(runId);

  // Remove old entries if over limit
  const toDelete = index.splice(MAX_TRACES);

  // Write trace and updated index
  await chrome.storage.local.set({
    [traceKey]: record,
    [INDEX_KEY]: index,
  });

  // Clean up old trace data
  if (toDelete.length > 0) {
    await chrome.storage.local.remove(toDelete.map(id => TRACE_PREFIX + id));
  }
}

/**
 * Update a trace record (e.g., to add critique)
 */
export async function updateTrace(runId, updates) {
  const traceKey = TRACE_PREFIX + runId;
  const { [traceKey]: trace } = await chrome.storage.local.get(traceKey);

  if (trace) {
    await chrome.storage.local.set({
      [traceKey]: { ...trace, ...updates },
    });
  }
}

/**
 * Get recent traces
 */
export async function getTraces(limit = 20) {
  const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
  const ids = index.slice(0, limit);

  if (ids.length === 0) return [];

  const keys = ids.map(id => TRACE_PREFIX + id);
  const result = await chrome.storage.local.get(keys);

  // Return in index order
  return ids.map(id => result[TRACE_PREFIX + id]).filter(Boolean);
}

/**
 * Get trace by run ID
 */
export async function getTraceByRunId(runId) {
  const traceKey = TRACE_PREFIX + runId;
  const { [traceKey]: trace } = await chrome.storage.local.get(traceKey);
  return trace;
}

/**
 * Delete a single trace by run ID
 */
export async function deleteTrace(runId) {
  const traceKey = TRACE_PREFIX + runId;

  // Update index
  const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
  const filtered = index.filter(id => id !== runId);

  await chrome.storage.local.set({ [INDEX_KEY]: filtered });
  await chrome.storage.local.remove(traceKey);
}

/**
 * Clear all traces
 */
export async function clearTraces() {
  const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);

  // Remove all trace keys and the index
  const keysToRemove = [INDEX_KEY, ...index.map(id => TRACE_PREFIX + id)];
  await chrome.storage.local.remove(keysToRemove);
}
