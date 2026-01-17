/**
 * TraceCollector - Collects execution trace for debugging
 *
 * Creates a tree structure representing the execution flow:
 * - Actions (top level)
 * - Steps (function, llm, action)
 * - Chrome API calls
 * - LLM calls with prompts/responses
 * - Context accumulation snapshots
 */

export class TraceCollector {
  constructor(runId) {
    this.runId = runId;
    this.root = null;
    this.nodeStack = [];
    this.nodeIdCounter = 0;
  }

  /**
   * Generate unique node ID
   */
  generateId() {
    return `node_${this.runId}_${++this.nodeIdCounter}`;
  }

  /**
   * Start tracing an action
   */
  startAction(actionName, input) {
    const node = {
      id: this.generateId(),
      type: 'action',
      name: actionName,
      input: this.sanitizeForTrace(input),
      status: 'running',
      startTime: performance.now(),
      children: [],
    };

    if (this.nodeStack.length === 0) {
      this.root = node;
    } else {
      this.getCurrentNode().children.push(node);
    }

    this.nodeStack.push(node);
    return node.id;
  }

  /**
   * End tracing an action
   */
  endAction(nodeId, output, error = null) {
    const node = this.findNode(nodeId);
    if (node) {
      node.endTime = performance.now();
      node.duration = node.endTime - node.startTime;
      node.output = this.sanitizeForTrace(output);
      node.status = error ? 'error' : 'success';
      if (error) {
        node.error = this.sanitizeError(error);
      }
    }
    this.popNode(nodeId);
  }

  /**
   * Start tracing a step
   */
  startStep(stepIndex, stepType, stepInfo = {}) {
    const node = {
      id: this.generateId(),
      type: 'step',
      name: `Step ${stepIndex + 1}`,
      stepType: stepType,
      status: 'running',
      startTime: performance.now(),
      children: [],
      ...stepInfo,
    };

    const parent = this.getCurrentNode();
    if (parent) {
      parent.children.push(node);
    }

    this.nodeStack.push(node);
    return node.id;
  }

  /**
   * End tracing a step
   */
  endStep(nodeId, result, error = null) {
    const node = this.findNode(nodeId);
    if (node) {
      node.endTime = performance.now();
      node.duration = node.endTime - node.startTime;
      node.output = this.sanitizeForTrace(result);
      node.status = error ? 'error' : 'success';
      if (error) {
        node.error = this.sanitizeError(error);
      }
    }
    this.popNode(nodeId);
  }

  /**
   * Trace a function call
   */
  traceFunction(handlerName, input, output, duration, error = null) {
    const node = {
      id: this.generateId(),
      type: 'function',
      name: handlerName,
      handler: handlerName,
      input: this.sanitizeForTrace(input),
      output: this.sanitizeForTrace(output),
      duration: duration,
      status: error ? 'error' : 'success',
      children: [],
    };

    if (error) {
      node.error = this.sanitizeError(error);
    }

    const parent = this.getCurrentNode();
    if (parent) {
      parent.children.push(node);
    }

    return node.id;
  }

  /**
   * Trace an LLM call
   */
  traceLLM(model, prompt, response, tokens, duration, error = null) {
    const node = {
      id: this.generateId(),
      type: 'llm',
      name: `LLM Call`,
      model: model,
      prompt: this.truncateString(prompt, 2000),
      output: this.sanitizeForTrace(response),
      tokens: tokens,
      duration: duration,
      status: error ? 'error' : 'success',
      children: [],
    };

    if (error) {
      node.error = this.sanitizeError(error);
    }

    const parent = this.getCurrentNode();
    if (parent) {
      parent.children.push(node);
    }

    return node.id;
  }

  /**
   * Trace a Chrome API call
   */
  traceChromeAPI(method, args, result, duration, error = null) {
    const node = {
      id: this.generateId(),
      type: 'chrome',
      name: method,
      handler: `chrome.${method}`,
      input: this.sanitizeForTrace(args),
      output: this.sanitizeForTrace(result),
      duration: duration,
      status: error ? 'error' : 'success',
      children: [],
    };

    if (error) {
      node.error = this.sanitizeError(error);
    }

    const parent = this.getCurrentNode();
    if (parent) {
      parent.children.push(node);
    }

    return node.id;
  }

  /**
   * Trace context snapshot
   */
  traceContext(context) {
    const node = {
      id: this.generateId(),
      type: 'context',
      name: 'Context Snapshot',
      context: this.sanitizeForTrace(context),
      status: 'success',
      children: [],
    };

    const parent = this.getCurrentNode();
    if (parent) {
      parent.children.push(node);
    }

    return node.id;
  }

  /**
   * Get current node from stack
   */
  getCurrentNode() {
    return this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null;
  }

  /**
   * Find node by ID
   */
  findNode(nodeId) {
    const search = (node) => {
      if (!node) return null;
      if (node.id === nodeId) return node;
      for (const child of node.children || []) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this.root);
  }

  /**
   * Pop node from stack
   */
  popNode(nodeId) {
    const index = this.nodeStack.findIndex(n => n.id === nodeId);
    if (index >= 0) {
      this.nodeStack.splice(index, 1);
    }
  }

  /**
   * Get the complete trace
   */
  getTrace() {
    return this.root;
  }

  /**
   * Sanitize value for trace (handle circular refs, large objects)
   */
  sanitizeForTrace(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;

    try {
      // Try to serialize to detect circular refs
      const str = JSON.stringify(value, (key, val) => {
        // Skip large binary/base64 data
        if (typeof val === 'string' && val.length > 10000) {
          return `[String: ${val.length} chars]`;
        }
        // Skip functions
        if (typeof val === 'function') {
          return '[Function]';
        }
        return val;
      });

      // If serialized is too large, truncate
      if (str.length > 50000) {
        return JSON.parse(str.substring(0, 50000) + '..."}}');
      }

      return JSON.parse(str);
    } catch (err) {
      // Circular reference or other issue
      return `[Unable to serialize: ${err.message}]`;
    }
  }

  /**
   * Sanitize error for trace
   */
  sanitizeError(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) {
      return {
        message: error.message,
        name: error.name,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      };
    }
    return String(error);
  }

  /**
   * Truncate string to max length
   */
  truncateString(str, maxLength) {
    if (typeof str !== 'string') {
      str = JSON.stringify(str);
    }
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '... [truncated]';
  }
}

/**
 * Create a traced version of the chrome API
 */
export function createTracedChromeAPI(chromeAPI, collector) {
  if (!collector) return chromeAPI;

  const handler = {
    get(target, prop) {
      const original = target[prop];
      if (typeof original !== 'function') {
        return original;
      }

      return async function (...args) {
        const startTime = performance.now();
        let result, error;

        try {
          result = await original.apply(target, args);
        } catch (err) {
          error = err;
        }

        const duration = performance.now() - startTime;
        collector.traceChromeAPI(prop, args, result, duration, error);

        if (error) throw error;
        return result;
      };
    }
  };

  return new Proxy(chromeAPI, handler);
}

/**
 * Create a traced version of the LLM generate function
 */
export function createTracedGenerate(generate, collector) {
  if (!collector) return generate;

  return async function tracedGenerate(options) {
    const startTime = performance.now();
    let result, error;
    let tokens = { input: 0, output: 0 };

    try {
      result = await generate(options);
      // Try to extract token counts from response
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

    // Build prompt string for trace
    let promptStr = '';
    if (options.messages) {
      promptStr = options.messages.map(m => `[${m.role}]: ${m.content}`).join('\n');
    } else if (options.prompt) {
      promptStr = options.prompt;
    }

    collector.traceLLM(
      options.model || 'unknown',
      promptStr,
      result,
      tokens,
      duration,
      error
    );

    if (error) throw error;
    return result;
  };
}
