/**
 * Action executor - Params in, result out
 * Uses context accumulation: each step's result merges into context
 */
import logger from './logger.js';
import { getBrowserStateBundle } from './chrome-api.js';
import { generate } from './llm/index.js';
import { actionsRegistry, resolveStepTemplates } from './actions/index.js';
import { createTracedGenerate } from './trace-collector.js';

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


export async function executeAction(action, params, parent_messages = null, traceCollector = null) {
  logger.info(`Action: ${action.name}`, { params: Object.keys(params) });

  // Start tracing this action
  const actionNodeId = traceCollector?.startAction(action.name, params);

  if (action.input_schema) {
    const { valid, errors } = validateParams(params, action.input_schema);
    if (!valid) {
      const error = new Error(`Validation failed for ${action.name}: ${errors.join(', ')}`);
      Object.assign(error, { isValidationError: true, validationErrors: errors });
      logger.error(error.message, { errors });
      traceCollector?.endAction(actionNodeId, null, error);
      throw error;
    }
  }

  let context = { ...params, parent_messages };
  let lastStepOutput = {};

  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const stepNodeId = traceCollector?.startStep(i, step.type, {
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
          traceCollector?.traceFunction(step.handler?.name || 'anonymous', context, stepOutput, duration);
          break;
        }
        case 'llm': {
          stepOutput = await executeLLMStep(step, context, traceCollector);
          break;
        }
        case 'action': {
          stepOutput = await executeAction(actionsRegistry[step.action], context, context.parent_messages, traceCollector);
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

      // Trace context snapshot after step
      traceCollector?.traceContext(context);
      traceCollector?.endStep(stepNodeId, stepOutput);

    } catch (error) {
      logger.error(`Step ${i + 1} failed: ${action.name}`, { error: error.message });
      traceCollector?.endStep(stepNodeId, null, error);
      traceCollector?.endAction(actionNodeId, null, error);
      throw new Error(`Step ${i + 1} failed: ${error.message}`);
    }
  }

  logger.info(`Action complete: ${action.name}`);

  const result = {
    result: lastStepOutput,
    ...(context.parent_messages && { parent_messages: context.parent_messages })
  };

  traceCollector?.endAction(actionNodeId, result);

  // Return last step output as result, pass through parent_messages if modified
  return result;
}

async function executeLLMStep(step, parent_context, traceCollector = null) {
  const { intelligence, output_schema, tool_choice, skip_if } = step;
  const context = { ...parent_context, browser_state: await getBrowserStateBundle(), stop_action: tool_choice?.stop_action };

  if (skip_if && skip_if(context)) {
    logger.info('Skipping LLM step');
    return {};
  }

  const { systemPrompt, renderMessage } = resolveStepTemplates(step);
  const sysPrompt = systemPrompt(context);
  const userMsg = renderMessage(context);

  // Create traced generate function if collector is present
  const tracedGenerate = traceCollector ? createTracedGenerate(generate, traceCollector) : generate;

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
    logger.info(`Turn ${turn + 1}/${max_iterations}`);
    const response = await withTimeout(tracedGenerate({ messages: conversation, intelligence, tools }), TIMEOUT_MS);

    if (!response.tool_calls?.length) {
      logger.warn('LLM returned text instead of tool call');
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
        const res = await executeAction(action, args, conversation, traceCollector);
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

  // Max iterations - force stop
  logger.error('Max iterations reached');
  const stopRes = await executeAction(actionsRegistry[stop_action], { justification: 'Max iterations reached' }, conversation, traceCollector);
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
  // Traverse nested result objects to find final_answer
  const inner = result?.result || result;
  if (typeof inner === 'string') return inner;
  return inner?.final_answer || inner?.result?.final_answer || JSON.stringify(inner);
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms))
]);
