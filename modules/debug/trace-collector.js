/**
 * Tracer - Execution tracing with IndexedDB persistence
 */
import { getActionStatsCounter } from './time-bucket-counter.js';

const DB_NAME = 'vishpr_traces';
const DB_VERSION = 1;
const EVENTS_STORE = 'trace_events';
const META_STORE = 'trace_meta';
const MAX_TRACES = 100;

let dbPromise = null;

// Map traceId -> actionName for logging oversized events
// Bounded to prevent memory leaks if actions crash before endAction()
const traceActionNames = new Map();
const TRACE_NAMES_MAX_SIZE = 100;

function setTraceActionName(traceId, name) {
  // Cleanup oldest entries if map is too large (handles crash scenarios)
  if (traceActionNames.size >= TRACE_NAMES_MAX_SIZE) {
    // Delete first half of entries (oldest, since Map maintains insertion order)
    const deleteCount = Math.floor(TRACE_NAMES_MAX_SIZE / 2);
    const keysToDelete = [...traceActionNames.keys()].slice(0, deleteCount);
    for (const key of keysToDelete) {
      traceActionNames.delete(key);
    }
  }
  traceActionNames.set(traceId, name);
}

function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = /** @type {IDBOpenDBRequest} */ (e.target).result;
        db.createObjectStore(EVENTS_STORE, { keyPath: 'id', autoIncrement: true }).createIndex('traceId', 'traceId');
        db.createObjectStore(META_STORE, { keyPath: 'traceId' }).createIndex('timestamp', 'timestamp');
      };
    });
  }
  return dbPromise;
}

async function getTraceEvents(traceId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const events = [];
    const request = db.transaction(EVENTS_STORE, 'readonly').objectStore(EVENTS_STORE).index('traceId').openCursor(IDBKeyRange.only(traceId));
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { events.push(cursor.value); cursor.continue(); }
      else resolve(events.sort((a, b) => a.id - b.id));
    };
    request.onerror = () => reject(request.error);
  });
}

// ============ Public Query Functions ============

export async function updateTrace(traceId, updates) {
  const db = await getDB();
  const store = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
  const existing = await new Promise(r => { const req = store.get(traceId); req.onsuccess = () => r(req.result); });
  if (existing) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put({ ...existing, ...updates });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}

// Find direct children of a trace by ID prefix (format: parentId_stepIndex_uuid)
async function getDirectChildren(db, parentId) {
  return new Promise((resolve) => {
    const results = [];
    const prefix = `${parentId}_`;
    const request = db.transaction(META_STORE).objectStore(META_STORE).openCursor();
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const id = cursor.value.traceId;
        // Direct child: starts with prefix and has format parentId_stepIndex_uuid (no further nesting)
        if (id.startsWith(prefix) && id.slice(prefix.length).split('_').length === 2) {
          results.push(cursor.value);
        }
        cursor.continue();
      } else resolve(results);
    };
  });
}

export async function getTraceById(traceId) {
  const db = await getDB();
  const meta = await new Promise(r => { const req = db.transaction(META_STORE).objectStore(META_STORE).get(traceId); req.onsuccess = () => r(req.result); });
  if (!meta) return null;

  const trace = buildTraceTree(await getTraceEvents(traceId), traceId);
  if (!trace) return { ...meta, trace: null };

  // Find and attach direct children
  const childMetas = await getDirectChildren(db, traceId);
  for (const childMeta of childMetas) {
    const childResult = await getTraceById(childMeta.traceId);
    if (!childResult?.trace) continue;

    const suffix = childMeta.traceId.slice(traceId.length + 1);
    const firstPart = suffix.split('_')[0];

    const stepIndex = parseInt(firstPart, 10);
    const step = !isNaN(stepIndex) && trace.children.find(s => s.id === `${stepIndex}`);
    if (step) {
      step.children.push(childResult.trace);
    } else {
      // No matching step - attach directly to root action
      trace.children.push(childResult.trace);
    }
  }

  // Sort step children by timestamp so child actions appear in correct order
  for (const step of trace.children) {
    if (step.children?.length > 1) {
      step.children.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }
  }

  collectStats(trace);
  return { ...meta, trace };
}

export async function getTraces(limit = 20) {
  const db = await getDB();
  const metas = await new Promise((resolve, reject) => {
    const results = [];
    const request = db.transaction(META_STORE).objectStore(META_STORE).index('timestamp').openCursor(null, 'prev');
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        // Only include root traces in listing
        if (cursor.value.isRoot && results.length < limit) results.push(cursor.value);
        cursor.continue();
      } else resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
  // Return metadata only (not full traces) to avoid Chrome message size limits.
  // Full trace data is fetched on-demand via getTraceById when selecting a trace.
  return metas;
}

export async function deleteTrace(traceId) {
  const db = await getDB();

  // Find children by ID prefix to cascade delete
  const childMetas = await getDirectChildren(db, traceId);

  // Delete this trace's meta and events
  await new Promise(r => { const tx = db.transaction(META_STORE, 'readwrite'); tx.objectStore(META_STORE).delete(traceId); tx.oncomplete = r; });
  await new Promise(r => {
    const request = db.transaction(EVENTS_STORE, 'readwrite').objectStore(EVENTS_STORE).index('traceId').openCursor(IDBKeyRange.only(traceId));
    request.onsuccess = (e) => { const cursor = e.target.result; if (cursor) { cursor.delete(); cursor.continue(); } else r(); };
  });

  // Cascade delete children
  for (const child of childMetas) {
    await deleteTrace(child.traceId);
  }
}


// ============ Tracer Functions ============

// Called from startAction only - creates meta for new action
async function createTraceMeta(traceId, isRoot, name = null, input = null) {
  const inputPreview = getInputPreview(input);
  const db = await getDB();
  await new Promise(r => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ traceId, timestamp: Date.now(), status: 'running', isRoot, name, inputPreview });
    tx.oncomplete = r;
  });
  // Cleanup old root traces
  if (isRoot) {
    const roots = await new Promise(r => {
      const ids = [];
      const req = db.transaction(META_STORE).objectStore(META_STORE).index('timestamp').openCursor(null, 'next');
      req.onsuccess = (e) => { const c = e.target.result; if (c) { if (c.value.isRoot) ids.push(c.value.traceId); c.continue(); } else r(ids); };
    });
    if (roots.length > MAX_TRACES) {
      for (const id of roots.slice(0, roots.length - MAX_TRACES)) await deleteTrace(id);
    }
  }
}

// Append event to trace - no meta handling
async function persistEvent(traceId, event) {
  if (!traceId) return;
  try {
    const db = await getDB();
    const eventData = { traceId, timestamp: Date.now(), ...event };
    // Safety check: skip if event is too large (shouldn't happen after sanitize, but just in case)
    const size = JSON.stringify(eventData).length;
    if (size > 1000000) {
      // Log to action stats for visibility
      const actionName = traceActionNames.get(traceId) || event.name || 'UNKNOWN';
      console.warn(`Trace event too large (${size} bytes) for ${actionName}, skipping:`, event.type);
      getActionStatsCounter().increment(actionName, 'oversized_events').catch(() => {});
      return;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(EVENTS_STORE, 'readwrite');
      tx.objectStore(EVENTS_STORE).add(eventData);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('Failed to persist trace event:', e.message);
  }
}

// Max sizes for trace data to prevent crashes
const MAX_STRING_LENGTH = 40000;  // 40KB per string field
const MAX_OBJECT_SIZE = 200000;   // 200KB per serialized object

function truncateString(str, maxLen = MAX_STRING_LENGTH) {
  if (typeof str !== 'string' || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `... [truncated ${str.length - maxLen} chars]`;
}

function truncateValue(value, maxLen = MAX_STRING_LENGTH) {
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value, maxLen);
  if (Array.isArray(value)) {
    // Truncate array items and limit array length
    const maxItems = 50;
    const truncated = value.slice(0, maxItems).map(v => truncateValue(v, maxLen / 2));
    if (value.length > maxItems) truncated.push(`... [${value.length - maxItems} more items]`);
    return truncated;
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = truncateValue(v, maxLen / 2);
    }
    return result;
  }
  return value;
}

function sanitize(value) {
  if (value == null) return value;
  try {
    // First pass: handle functions and errors
    const cleaned = JSON.parse(JSON.stringify(value, (_, v) =>
      typeof v === 'function' ? '[Function]' :
      v instanceof Error ? { message: v.message, name: v.name } : v
    ));
    // Second pass: truncate large strings
    const truncated = truncateValue(cleaned);
    // Final check: ensure total size is within limits
    const json = JSON.stringify(truncated);
    if (json.length > MAX_OBJECT_SIZE) {
      return { _truncated: true, _size: json.length, _preview: json.slice(0, 500) + '...' };
    }
    return truncated;
  }
  catch (e) { return `[Unserializable: ${e.message}]`; }
}

function sanitizeError(e) { return typeof e === 'string' ? e : e instanceof Error ? { message: e.message, name: e.name } : String(e); }

// Extract first input value for display in history list
function getInputPreview(input) {
  if (!input || typeof input !== 'object') return null;
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  const [, value] = entries[0];
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
  return valueStr.length > 50 ? valueStr.slice(0, 50) + '…' : valueStr;
}

export const tracer = {
  // traceId is passed in - parent creates composite ID, or null for root
  // Returns { uuid, startTime, writePromise }
  startAction(traceId, name, input) {
    const isRoot = !traceId;
    const uuid = traceId || crypto.randomUUID();
    const startTime = performance.now();
    // Track action name for oversized event logging
    setTraceActionName(uuid, name);
    const writePromise = Promise.all([
      createTraceMeta(uuid, isRoot, name, input),
      persistEvent(uuid, { type: 'action_start', name, input: sanitize(input), startTime })
    ]);
    return { uuid, startTime, writePromise };
  },

  // Returns { duration, writePromise }
  endAction(uuid, startTime, output, error = null) {
    const duration = performance.now() - startTime;
    const status = error ? 'error' : 'success';
    const writePromise = Promise.all([
      persistEvent(uuid, { type: 'action_end', duration, output: sanitize(output), status, error: error ? sanitizeError(error) : undefined }),
      updateTrace(uuid, { status, duration })
    ]).finally(() => traceActionNames.delete(uuid));  // Cleanup to prevent memory leak
    return { duration, writePromise };
  },

  // Returns { startTime, writePromise }
  startStep(actionUUID, stepIndex, stepType, stepInfo = {}, context = null) {
    const startTime = performance.now();
    const writePromise = persistEvent(actionUUID, { type: 'step_start', stepIndex, stepType, handler: stepInfo.handler, action: stepInfo.action, input: sanitize(context), startTime });
    return { startTime, writePromise };
  },

  // Returns writePromise
  endStep(actionUUID, stepIndex, startTime, output, error = null) {
    const status = error ? 'error' : output?.skipped ? 'skipped' : 'success';
    return persistEvent(actionUUID, { type: 'step_end', stepIndex, duration: performance.now() - startTime, output: sanitize(output), status, error: error ? sanitizeError(error) : undefined });
  },

  // Returns writePromise
  traceLLM(actionUUID, stepIndex, model, prompt, response, duration, turn = null, maxTurns = null, error = null) {
    return persistEvent(actionUUID, { type: 'llm', stepIndex, model, prompt, output: sanitize(response), duration, turn, maxTurns, status: error ? 'error' : 'success', error: error ? sanitizeError(error) : undefined });
  },

  // Returns writePromise
  traceWarning(actionUUID, stepIndex, message, details = null) {
    return persistEvent(actionUUID, { type: 'warning', stepIndex, message, details: details ? sanitize(details) : undefined });
  },
};

// ============ Tree Builder ============

function getUsageStats(usage) {
  if (!usage) return { tokens: { input: 0, output: 0 }, cost: 0, upstreamCost: 0 };
  return {
    tokens: {
      input: usage.input_tokens || usage.prompt_tokens || 0,
      output: usage.output_tokens || usage.completion_tokens || 0,
    },
    cost: usage.cost || 0,
    upstreamCost: usage.cost_details?.upstream_inference_cost || 0,
  };
}

function collectStats(node) {
  const stats = { tokens: { input: 0, output: 0 }, cost: 0, upstreamCost: 0, llmCalls: 0 };
  const collect = (n) => {
    if (n.type === 'llm' && n.usageStats) {
      stats.tokens.input += n.usageStats.tokens.input;
      stats.tokens.output += n.usageStats.tokens.output;
      stats.cost += n.usageStats.cost;
      stats.upstreamCost += n.usageStats.upstreamCost;
      stats.llmCalls++;
    }
    // Don't recurse into child_action placeholders - those are loaded separately
    if (n.type !== 'child_action') {
      for (const child of n.children || []) collect(child);
    }
  };
  for (const child of node.children || []) collect(child);
  if (stats.llmCalls > 0) node.stats = stats;
}

// Build tree for a single action's events
export function buildTraceTree(events, actionUUID) {
  if (!events?.length) return null;
  const steps = new Map();
  let action = null;

  for (const e of events) {
    const stepKey = `${e.stepIndex}`;
    switch (e.type) {
      case 'action_start':
        action = { id: actionUUID, type: 'action', name: e.name, input: e.input, timestamp: e.timestamp, startTime: e.startTime, status: 'running', children: [] };
        break;
      case 'action_end':
        if (action) Object.assign(action, { duration: e.duration, output: e.output, status: e.status, error: e.error });
        break;
      case 'step_start':
        const sNode = { id: stepKey, type: 'step', name: `Step ${e.stepIndex + 1}`, stepType: e.stepType, handler: e.handler, action: e.action, input: e.input, timestamp: e.timestamp, startTime: e.startTime, status: 'running', children: [] };
        steps.set(stepKey, sNode);
        action?.children.push(sNode);
        break;
      case 'step_end':
        Object.assign(steps.get(stepKey) || {}, { duration: e.duration, output: e.output, status: e.status, error: e.error });
        break;
      case 'llm':
        const llmName = e.turn !== null ? `LLM Call (Turn ${e.turn + 1}/${e.maxTurns})` : 'LLM Call';
        const usageStats = getUsageStats(e.output?.usage);
        steps.get(stepKey)?.children.push({ type: 'llm', name: llmName, model: e.model, prompt: e.prompt, output: e.output, usageStats, duration: e.duration, timestamp: e.timestamp, status: e.status, error: e.error });
        break;
      case 'warning':
        steps.get(stepKey)?.children.push({ type: 'warning', name: e.message, details: e.details, timestamp: e.timestamp, status: 'warning' });
        break;
    }
  }

  if (action) collectStats(action);
  return action;
}
