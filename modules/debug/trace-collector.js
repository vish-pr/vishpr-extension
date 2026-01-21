/**
 * Tracer - Execution tracing with IndexedDB persistence
 */

const DB_NAME = 'vishpr_traces';
const DB_VERSION = 1;
const EVENTS_STORE = 'trace_events';
const META_STORE = 'trace_meta';
const MAX_TRACES = 100;

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
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

    if (firstPart === 'critique') {
      // Attach critique directly to root action
      trace.children.push(childResult.trace);
    } else {
      // Attach to the corresponding step
      const stepIndex = parseInt(firstPart, 10);
      const step = trace.children.find(s => s.id === `${stepIndex}`);
      if (step) step.children.push(childResult.trace);
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
async function createTraceMeta(traceId, isRoot, name = null) {
  const db = await getDB();
  await new Promise(r => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ traceId, timestamp: Date.now(), status: 'running', isRoot, name });
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
  const db = await getDB();
  await new Promise(r => { const tx = db.transaction(EVENTS_STORE, 'readwrite'); tx.objectStore(EVENTS_STORE).add({ traceId, timestamp: Date.now(), ...event }); tx.oncomplete = r; });
}

function sanitize(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'function' ? '[Function]' : v instanceof Error ? { message: v.message, name: v.name } : v)); }
  catch (e) { return `[Unserializable: ${e.message}]`; }
}

function sanitizeError(e) { return typeof e === 'string' ? e : e instanceof Error ? { message: e.message, name: e.name } : String(e); }

export const tracer = {
  // traceId is passed in - parent creates composite ID, or null for root
  startAction(traceId, name, input) {
    const isRoot = !traceId;
    const uuid = traceId || crypto.randomUUID();
    const startTime = performance.now();
    createTraceMeta(uuid, isRoot, name);
    persistEvent(uuid, { type: 'action_start', name, input: sanitize(input), startTime });
    return { uuid, startTime };
  },

  endAction(uuid, startTime, output, error = null) {
    const duration = performance.now() - startTime;
    const status = error ? 'error' : 'success';
    persistEvent(uuid, { type: 'action_end', duration, output: sanitize(output), status, error: error ? sanitizeError(error) : undefined });
    updateTrace(uuid, { status, duration });
    return { duration };
  },

  startStep(actionUUID, stepIndex, stepType, stepInfo = {}, context = null) {
    const startTime = performance.now();
    persistEvent(actionUUID, { type: 'step_start', stepIndex, stepType, handler: stepInfo.handler, action: stepInfo.action, input: sanitize(context), startTime });
    return { startTime };
  },

  endStep(actionUUID, stepIndex, startTime, output, error = null) {
    const status = error ? 'error' : output?.skipped ? 'skipped' : 'success';
    persistEvent(actionUUID, { type: 'step_end', stepIndex, duration: performance.now() - startTime, output: sanitize(output), status, error: error ? sanitizeError(error) : undefined });
  },

  traceLLM(actionUUID, stepIndex, model, prompt, response, duration, turn = null, maxTurns = null, error = null) {
    persistEvent(actionUUID, { type: 'llm', stepIndex, model, prompt, output: sanitize(response), duration, turn, maxTurns, status: error ? 'error' : 'success', error: error ? sanitizeError(error) : undefined });
  },

  traceWarning(actionUUID, stepIndex, message, details = null) {
    persistEvent(actionUUID, { type: 'warning', stepIndex, message, details: details ? sanitize(details) : undefined });
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
