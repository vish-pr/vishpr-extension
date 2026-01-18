/**
 * Action executor - Params in, result out
 * Uses context accumulation: each step's result merges into context
 * Tracing via global tracer with UUID-based parent-child linking
 */
import { getBrowserStateBundle } from './chrome-api.js';
import { generate } from './llm/index.js';
import { actionsRegistry, resolveStepTemplates } from './actions/index.js';
import { tracer, createTracedGenerate } from './trace-collector.js';

const TIMEOUT_MS = 20000;

const TYPE_CHECKS = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number',
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => typeof v === 'object' && !Array.isArray(v)
};

function validateParams(params, schema) {
  const errors = [];
  for (const field of schema.required || []) {
    if (!(field in params) || params[field] === undefined) errors.push(`Missing required field: ${field}`);
  }
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (key in params && params[key] !== undefined && TYPE_CHECKS[prop.type] && !TYPE_CHECKS[prop.type](params[key])) {
      errors.push(`Field ${key} must be a ${prop.type}`);
    }
  }
  return { valid: !errors.length, errors };
}

/**
 * Execute an action
 * @param {object} action - Action definition
 * @param {object} params - Input parameters (may include _parentTraceUUID for child actions)
 * @param {array} parent_messages - Conversation history for multi-turn
 * @returns {object} Result with _traceUUID for trace retrieval
 */
export async function executeAction(action, params, parent_messages = null) {
  // Extract trace UUID from params, start new action linked to parent
  const { _parentTraceUUID, ...cleanParams } = params;
  const actionUUID = tracer.startAction(_parentTraceUUID || null, action.name, cleanParams);

  if (action.input_schema) {
    const { valid, errors } = validateParams(cleanParams, action.input_schema);
    if (!valid) {
      const error = new Error(`Validation failed for ${action.name}: ${errors.join(', ')}`);
      Object.assign(error, { isValidationError: true, validationErrors: errors });
      tracer.endAction(actionUUID, null, error);
      throw error;
    }
  }

  let context = { ...cleanParams, parent_messages, _traceUUID: actionUUID };
  let lastStepOutput = {};

  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const stepUUID = tracer.startStep(actionUUID, i, step.type, {
      handler: step.handler?.name,
      action: step.action,
    });

    try {
      let stepOutput;
      const startTime = performance.now();

      switch (step.type) {
        case 'function': {
          stepOutput = await withTimeout(step.handler(context), TIMEOUT_MS);
          const duration = performance.now() - startTime;
          tracer.traceFunction(stepUUID, step.handler?.name || 'anonymous', context, stepOutput, duration);
          break;
        }
        case 'llm': {
          stepOutput = await executeLLMStep(step, context);
          break;
        }
        case 'action': {
          // Child action: pass current actionUUID as parent
          stepOutput = await executeAction(
            actionsRegistry[step.action],
            { ...context, _parentTraceUUID: actionUUID },
            context.parent_messages
          );
          break;
        }
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }

      if (stepOutput.result) {
        lastStepOutput = stepOutput.result;
        context = { ...context, ...lastStepOutput };
      }
      if (stepOutput.parent_messages) context.parent_messages = stepOutput.parent_messages;

      tracer.traceContext(stepUUID, context);
      tracer.endStep(stepUUID, stepOutput);

    } catch (error) {
      tracer.endStep(stepUUID, null, error);
      tracer.endAction(actionUUID, null, error);
      throw new Error(`Step ${i + 1} failed: ${error.message}`);
    }
  }

  const result = {
    result: lastStepOutput,
    _traceUUID: actionUUID,
    ...(context.parent_messages && { parent_messages: context.parent_messages })
  };

  tracer.endAction(actionUUID, result);
  return result;
}

async function executeLLMStep(step, parent_context) {
  const { intelligence, output_schema, tool_choice, skip_if } = step;
  const traceUUID = parent_context._traceUUID;
  const context = { ...parent_context, browser_state: await getBrowserStateBundle(), stop_action: tool_choice?.stop_action };

  if (skip_if && skip_if(context)) {
    return {};
  }

  const { systemPrompt, renderMessage } = resolveStepTemplates(step);
  const sysPrompt = systemPrompt(context);
  const userMsg = renderMessage(context);

  const tracedGenerate = createTracedGenerate(generate, traceUUID);

  // Single-turn: no tool_choice
  if (!tool_choice) {
    const result = await withTimeout(tracedGenerate({
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }],
      intelligence, schema: output_schema
    }), TIMEOUT_MS);
    return { result };
  }

  // Multi-turn with tools
  const { available_actions, stop_action, max_iterations } = tool_choice;
  const tools = buildTools(available_actions);
  let conversation = [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }];
  const addToolResult = (id, content) => conversation.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(content) });

  for (let turn = 0; turn < max_iterations; turn++) {
    tracer.traceIteration(traceUUID, turn, max_iterations);
    const response = await withTimeout(tracedGenerate({ messages: conversation, intelligence, tools }), TIMEOUT_MS);

    if (!response.tool_calls?.length) {
      tracer.traceWarning(traceUUID, 'LLM returned text instead of tool call', { content: response.content });
      conversation.push({ role: 'assistant', content: response.content });
      conversation.push({ role: 'user', content: 'Please call one of the available tools to proceed. Use FINAL_RESPONSE if complete or if data is gathered and needs formatting or extraction.' });
      continue;
    }

    conversation.push({ role: 'assistant', content: null, tool_calls: response.tool_calls });

    for (const call of response.tool_calls) {
      const toolName = call.function.name;
      let args;
      try { args = JSON.parse(call.function.arguments); }
      catch { addToolResult(call.id, { error: 'Invalid JSON in arguments' }); break; }

      const action = actionsRegistry[toolName];
      if (!action) { addToolResult(call.id, { error: `Unknown action: ${toolName}` }); break; }

      try {
        // Tool actions: parent is current step's trace UUID
        const res = await executeAction(action, { ...args, _parentTraceUUID: traceUUID }, conversation);
        if (toolName === stop_action) return { result: res.result };
        if (res.parent_messages) conversation = res.parent_messages;
        addToolResult(call.id, res.result);
      } catch (err) {
        addToolResult(call.id, err.isValidationError ? { error: 'Validation failed', details: err.validationErrors } : { error: err.message });
        break;
      }
    }

    conversation.push({ role: 'user', content: renderMessage({ ...context, browser_state: await getBrowserStateBundle() }) });
  }

  tracer.traceWarning(traceUUID, 'Max iterations reached', { max_iterations });
  const stopRes = await executeAction(actionsRegistry[stop_action], { justification: 'Max iterations reached', _parentTraceUUID: traceUUID }, conversation);
  return { result: stopRes.result };
}

function buildTools(availableActions) {
  return availableActions.map(name => {
    const action = actionsRegistry[name];
    return action && {
      type: 'function',
      function: {
        name: action.name,
        description: action.description,
        parameters: action.input_schema
      }
    };
  }).filter(Boolean);
}

// Extract final answer from nested result - use at top level only
export function unwrapFinalAnswer(result) {
  if (typeof result === 'string') return result;
  const inner = result?.result || result;
  if (typeof inner === 'string') return inner;
  return inner?.final_answer || inner?.result?.final_answer || JSON.stringify(inner);
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms))
]);
