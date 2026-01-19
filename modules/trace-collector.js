/**
 * TraceRouter - Global singleton for execution tracing with UUID-based tree
 *
 * Each action gets its own UUID. Child actions link to parent via UUID.
 * Parallel executions are isolated by different root UUIDs.
 *
 * Usage:
 *   const uuid = tracer.startAction(parentUUID, 'ACTION_NAME', input)
 *   tracer.traceStep(uuid, { type: 'function', ... })
 *   tracer.endAction(uuid, output, error)
 *   const tree = tracer.getTrace(rootUUID)
 */

class TraceRouter {
  constructor() {
    this.nodes = new Map(); // uuid -> node
  }

  generateUUID() {
    return crypto.randomUUID();
  }

  /**
   * Start an action - creates node with UUID, links to parent
   * @param {string|null} parentUUID - Parent action's UUID (null for root)
   * @param {string} actionName - Name of the action
   * @param {object} input - Input parameters
   * @returns {string} New action's UUID
   */
  startAction(parentUUID, actionName, input) {
    const uuid = this.generateUUID();
    const node = {
      id: uuid,
      type: 'action',
      name: actionName,
      input: this.sanitize(input),
      children: [],
      startTime: performance.now(),
      status: 'running',
    };

    this.nodes.set(uuid, node);

    // Link to parent
    if (parentUUID) {
      const parent = this.nodes.get(parentUUID);
      if (parent) parent.children.push(node);
    }

    return uuid;
  }

  /**
   * End an action
   */
  endAction(uuid, output, error = null) {
    const node = this.nodes.get(uuid);
    if (!node) return;

    node.endTime = performance.now();
    node.duration = node.endTime - node.startTime;
    node.output = this.sanitize(output);
    node.status = error ? 'error' : 'success';
    if (error) node.error = this.sanitizeError(error);
  }

  /**
   * Start a step within an action
   * @returns {string} Step UUID
   */
  startStep(actionUUID, stepIndex, stepType, stepInfo = {}) {
    const uuid = this.generateUUID();
    const node = {
      id: uuid,
      type: 'step',
      name: `Step ${stepIndex + 1}`,
      stepType,
      startTime: performance.now(),
      status: 'running',
      children: [],
      ...stepInfo,
    };

    this.nodes.set(uuid, node);

    const parent = this.nodes.get(actionUUID);
    if (parent) parent.children.push(node);

    return uuid;
  }

  /**
   * End a step
   */
  endStep(uuid, result, error = null) {
    const node = this.nodes.get(uuid);
    if (!node) return;

    node.endTime = performance.now();
    node.duration = node.endTime - node.startTime;
    node.output = this.sanitize(result);
    node.status = error ? 'error' : 'success';
    if (error) node.error = this.sanitizeError(error);
  }

  /**
   * Trace a function call (adds to parent's children)
   */
  traceFunction(parentUUID, handlerName, input, output, duration, error = null) {
    const node = {
      id: this.generateUUID(),
      type: 'function',
      name: handlerName,
      handler: handlerName,
      input: this.sanitize(input),
      output: this.sanitize(output),
      duration,
      status: error ? 'error' : 'success',
      children: [],
    };
    if (error) node.error = this.sanitizeError(error);

    const parent = this.nodes.get(parentUUID);
    if (parent) parent.children.push(node);
  }

  /**
   * Trace an LLM call
   */
  traceLLM(parentUUID, model, prompt, response, tokens, duration, error = null) {
    const node = {
      id: this.generateUUID(),
      type: 'llm',
      name: 'LLM Call',
      model,
      prompt: prompt,
      output: this.sanitizeDeep(response),
      tokens,
      duration,
      status: error ? 'error' : 'success',
      children: [],
    };
    if (error) node.error = this.sanitizeError(error);

    const parent = this.nodes.get(parentUUID);
    if (parent) parent.children.push(node);
  }

  /**
   * Trace context snapshot
   */
  traceContext(parentUUID, context) {
    const node = {
      id: this.generateUUID(),
      type: 'context',
      name: 'Context Snapshot',
      context: this.sanitize(context),
      status: 'success',
      children: [],
    };

    const parent = this.nodes.get(parentUUID);
    if (parent) parent.children.push(node);
  }

  /**
   * Trace a warning
   */
  traceWarning(parentUUID, message, details = null) {
    const node = {
      id: this.generateUUID(),
      type: 'warning',
      name: message,
      details: details ? this.sanitize(details) : null,
      status: 'warning',
      children: [],
    };

    const parent = this.nodes.get(parentUUID);
    if (parent) parent.children.push(node);
  }

  /**
   * Trace iteration marker
   */
  traceIteration(parentUUID, turn, maxIterations) {
    const node = {
      id: this.generateUUID(),
      type: 'iteration',
      name: `Turn ${turn + 1}/${maxIterations}`,
      turn: turn + 1,
      maxIterations,
      status: 'info',
      children: [],
    };

    const parent = this.nodes.get(parentUUID);
    if (parent) parent.children.push(node);
  }

  /**
   * Get trace tree starting from a UUID
   */
  getTrace(uuid) {
    return this.nodes.get(uuid);
  }

  /**
   * Clean up a trace tree (call after storing)
   */
  cleanup(uuid) {
    const collectUUIDs = (node) => {
      const uuids = [node.id];
      for (const child of node.children || []) {
        if (child.id) uuids.push(...collectUUIDs(child));
      }
      return uuids;
    };

    const node = this.nodes.get(uuid);
    if (node) {
      for (const id of collectUUIDs(node)) {
        this.nodes.delete(id);
      }
    }
  }

  /**
   * Sanitize value - preserve full data, only handle non-serializable types
   */
  sanitize(value) {
    if (value === undefined || value === null) return value;
    try {
      return JSON.parse(JSON.stringify(value, (key, val) => {
        if (typeof val === 'function') return '[Function]';
        if (val instanceof Error) return { message: val.message, name: val.name, stack: val.stack };
        return val;
      }));
    } catch (err) {
      return `[Unable to serialize: ${err.message}]`;
    }
  }

  /**
   * Deep sanitize - same as sanitize, preserves all data
   */
  sanitizeDeep(value) {
    return this.sanitize(value);
  }

  sanitizeError(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) {
      return { message: error.message, name: error.name, stack: error.stack };
    }
    return String(error);
  }
}

// Global singleton
export const tracer = new TraceRouter();

/**
 * Create traced generate function that uses UUID from context
 */
export function createTracedGenerate(generate, traceUUID) {
  return async function tracedGenerate(options) {
    const startTime = performance.now();
    let result, error;
    let tokens = { input: 0, output: 0 };

    try {
      result = await generate(options);
      if (result?.usage) {
        tokens = {
          input: result.usage.input_tokens || result.usage.prompt_tokens || 0,
          output: result.usage.output_tokens || result.usage.completion_tokens || 0,
        };
      }
    } catch (err) {
      error = err;
    }

    const duration = performance.now() - startTime;
    const promptStr = options.messages
      ? options.messages.map(m => `[${m.role}]: ${m.content}`).join('\n')
      : options.prompt || '';

    tracer.traceLLM(traceUUID, options.model || 'unknown', promptStr, result, tokens, duration, error);

    if (error) throw error;
    return result;
  };
}
