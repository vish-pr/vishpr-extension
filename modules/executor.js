/**
 * Action executor - Params in, result out
 * Uses tracer singleton for tracing and persistence
 */
import { getBrowserStateBundle } from './chrome-api.js';
import { generate } from './llm/index.js';
import { actionsRegistry, resolveStepTemplates, CRITIQUE } from './actions/index.js';
import { tracer, getTraceById } from './trace-collector.js';

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
 * @param {object} params - Input parameters
 * @param {array} parent_messages - Conversation history for multi-turn
 * @param {string} traceUUID - Composite trace ID from parent (format: parentUUID_stepIndex_uuid), or null for root
 */
export async function executeAction(action, params, parent_messages = null, traceUUID = null) {
  // Start action trace (traceUUID is composite ID from parent, or null for root)
  const { uuid: actionUUID, startTime } = tracer.startAction(traceUUID, action.name, params);

  if (action.input_schema) {
    const { valid, errors } = validateParams(params, action.input_schema);
    if (!valid) {
      const error = new Error(`Validation failed for ${action.name}: ${errors.join(', ')}`);
      Object.assign(error, { isValidationError: true, validationErrors: errors });
      tracer.endAction(actionUUID, startTime, null, error);
      throw error;
    }
  }

  let context = { ...params, parent_messages };
  let lastStepOutput = {};

  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const { startTime: stepStartTime } = tracer.startStep(actionUUID, i, step.type, {
      handler: step.handler?.name,
      action: step.action,
    }, context);

    try {
      let stepOutput;

      switch (step.type) {
        case 'function': {
          stepOutput = await withTimeout(step.handler(context), TIMEOUT_MS);
          break;
        }
        case 'llm': {
          stepOutput = await executeLLMStep(step, context, actionUUID, i);
          break;
        }
        case 'action': {
          const childUUID = `${actionUUID}_${i}_${crypto.randomUUID()}`;
          stepOutput = await executeAction(
            actionsRegistry[step.action],
            context,
            context.parent_messages,
            childUUID
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

      tracer.endStep(actionUUID, i, stepStartTime, stepOutput);

    } catch (error) {
      tracer.endStep(actionUUID, i, stepStartTime, null, error);
      tracer.endAction(actionUUID, startTime, null, error);
      throw new Error(`Step ${i + 1} failed: ${error.message}`);
    }
  }

  const result = {
    result: lastStepOutput,
    ...(context.parent_messages && { parent_messages: context.parent_messages })
  };

  const endEvent = tracer.endAction(actionUUID, startTime, result);

  // Only return trace info for root action (no parent)
  if (!traceUUID) {
    // Fire-and-forget critique for root actions (except CRITIQUE itself)
    if (action.name !== CRITIQUE) {
      runCritiqueAsync(actionUUID);
    }
    return { ...result, _traceUUID: actionUUID, _duration: endEvent.duration };
  }

  return result;
}

// Fire-and-forget critique runner
async function runCritiqueAsync(parentUUID) {
  try {
    const trace = await getTraceById(parentUUID);
    if (!trace?.trace) return;
    const critiqueUUID = `${parentUUID}_critique_${crypto.randomUUID()}`;
    await executeAction(actionsRegistry[CRITIQUE], { trace: trace.trace }, null, critiqueUUID);
  } catch (e) {
    console.error('Critique failed:', e.message);
  }
}

async function executeLLMStep(step, context, actionUUID, stepIndex) {
  const { intelligence, output_schema, tool_choice, skip_if } = step;
  const current_datetime = new Date().toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
  context = { ...context, browser_state: await getBrowserStateBundle(), current_datetime, stop_action: tool_choice?.stop_action };

  if (skip_if && skip_if(context)) {
    return {};
  }

  const { systemPrompt, renderMessage } = resolveStepTemplates(step);
  const sysPrompt = systemPrompt(context);
  const userMsg = renderMessage(context);

  const tracedGenerate = createTracedGenerate(generate, actionUUID, stepIndex);

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
    const response = await withTimeout(tracedGenerate({ messages: conversation, intelligence, tools }, turn, max_iterations), TIMEOUT_MS);

    if (!response.tool_calls?.length) {
      tracer.traceWarning(actionUUID, stepIndex, 'LLM returned text instead of tool call', { content: response.content });
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
        const childUUID = `${actionUUID}_${stepIndex}_${crypto.randomUUID()}`;
        const res = await executeAction(action, args, conversation, childUUID);
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

  tracer.traceWarning(actionUUID, stepIndex, 'Max iterations reached', { max_iterations });
  const stopUUID = `${actionUUID}_${stepIndex}_${crypto.randomUUID()}`;
  const stopRes = await executeAction(actionsRegistry[stop_action], { justification: 'Max iterations reached' }, conversation, stopUUID);
  return { result: stopRes.result };
}

function createTracedGenerate(generateFn, actionUUID, stepIndex) {
  return async function tracedGenerate(options, turn = null, maxTurns = null) {
    const startTime = performance.now();
    let result, error;

    try {
      result = await generateFn(options);
    } catch (err) {
      error = err;
    }

    const duration = performance.now() - startTime;
    const formatMessage = (m) => {
      if (m.content) return `[${m.role}]: ${m.content}`;
      if (m.tool_calls) return `[${m.role}]: ${m.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(', ')}`;
      return `[${m.role}]: (empty)`;
    };
    const promptStr = options.messages
      ? options.messages.map(formatMessage).join('\n')
      : options.prompt || '';

    tracer.traceLLM(actionUUID, stepIndex, result?.model || 'unknown', promptStr, result, duration, turn, maxTurns, error);

    if (error) throw error;
    return result;
  };
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
