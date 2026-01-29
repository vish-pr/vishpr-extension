/**
 * Action executor - Params in, result out
 * Uses tracer singleton for tracing and persistence
 */
// @ts-ignore - mustache module format differs from types
import Mustache from 'mustache';
import { generate } from './llm/index.js';
import { actionsRegistry } from './actions/index.js';
import { tracer, getTraceById } from './debug/trace-collector.js';
import { getActionStatsCounter } from './debug/time-bucket-counter.js';
import { resolveContextForTemplate } from './actions/context-provider.js';

/**
 * Render Mustache template with fresh context
 * Fetches context variables (browser_state, user_preferences, etc.) at render time
 */
async function renderWithContext(template, baseContext) {
  const freshContext = await resolveContextForTemplate(template);
  return Mustache.render(template, { ...baseContext, ...freshContext });
}

/**
 * Build TOOLS section from action definitions
 */
function buildToolsSection(availableActions) {
  return availableActions.map(name => {
    const action = actionsRegistry[name];
    if (!action?.tool_doc) return '';

    const lines = [`## ${name}`];
    const { use_when, must, never } = action.tool_doc;

    if (use_when?.length) {
      lines.push('Use when:');
      use_when.forEach(c => lines.push(`- ${c}`));
    }
    if (must?.length) {
      lines.push('MUST:');
      must.forEach(r => lines.push(`- ${r}`));
    }
    if (never?.length) {
      lines.push('NEVER:');
      never.forEach(r => lines.push(`- ${r}`));
    }

    return lines.join('\n');
  }).filter(Boolean).join('\n\n');
}

/**
 * Build shuffled EXAMPLES section
 */
function buildExamplesSection(availableActions) {
  const allExamples = availableActions.flatMap(name => {
    const action = actionsRegistry[name];
    return (action?.tool_doc?.examples || []).map(ex => ({ ex, name }));
  });

  // Fisher-Yates shuffle
  for (let i = allExamples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allExamples[i], allExamples[j]] = [allExamples[j], allExamples[i]];
  }

  return allExamples.map((item, i) =>
    `${i + 1}. "${item.ex}" → ${item.name}`
  ).join('\n');
}

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

// Fire-and-forget post-steps runner
async function runPostSteps(postSteps, actionUUID) {
  try {
    const traceData = await getTraceById(actionUUID);
    if (!traceData?.trace) return;

    const context = { trace: traceData.trace };

    for (const step of postSteps) {
      if (step.type === 'action') {
        const postStepUUID = `${actionUUID}_post_${crypto.randomUUID()}`;
        try {
          await executeAction(actionsRegistry[step.action], context, null, postStepUUID);
        } catch (e) {
          console.error(`Post-step ${step.action} failed:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('Post-steps failed:', e.message);
  }
}

/**
 * Execute an action
 * @param {object} action - Action definition
 * @param {object} params - Input parameters
 * @param {array} parent_messages - Conversation history for multi-turn
 * @param {string} traceUUID - Composite trace ID from parent (format: parentUUID_stepIndex_uuid), or null for root
 */
export async function executeAction(action, params, parent_messages = null, traceUUID = null) {
  // Collect all trace write promises for this action
  const traceWritePromises = [];

  // Start action trace (traceUUID is composite ID from parent, or null for root)
  const { uuid: actionUUID, startTime, writePromise: startWritePromise } = tracer.startAction(traceUUID, action.name, params);
  traceWritePromises.push(startWritePromise);

  if (action.input_schema) {
    const { valid, errors } = validateParams(params, action.input_schema);
    if (!valid) {
      const error = new Error(`Validation failed for ${action.name}: ${errors.join(', ')}`);
      Object.assign(error, { isValidationError: true, validationErrors: errors });
      const { writePromise } = tracer.endAction(actionUUID, startTime, null, error);
      traceWritePromises.push(writePromise);
      throw error;
    }
  }

  let context = { ...params, parent_messages };
  let lastStepOutput = {};

  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const { startTime: stepStartTime, writePromise: stepStartWritePromise } = tracer.startStep(actionUUID, i, step.type, {
      handler: step.handler?.name,
      action: step.action,
    }, context);
    traceWritePromises.push(stepStartWritePromise);

    try {
      let stepOutput;

      switch (step.type) {
        case 'function': {
          stepOutput = await withTimeout(step.handler(context), TIMEOUT_MS);
          break;
        }
        case 'llm': {
          stepOutput = await executeLLMStep(step, context, actionUUID, i, action.name, traceWritePromises);
          break;
        }
        case 'action': {
          // Check condition if defined
          if (step.condition && !step.condition(context)) {
            traceWritePromises.push(tracer.endStep(actionUUID, i, stepStartTime, { skipped: true }));
            continue;
          }
          const childUUID = `${actionUUID}_${i}_${crypto.randomUUID()}`;
          stepOutput = await executeAction(
            actionsRegistry[step.action],
            context,
            context.parent_messages,
            childUUID
          );
          // Collect child's trace write promises
          if (stepOutput._traceWrites) {
            traceWritePromises.push(...stepOutput._traceWrites);
            delete stepOutput._traceWrites;
          }
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

      traceWritePromises.push(tracer.endStep(actionUUID, i, stepStartTime, stepOutput));

    } catch (error) {
      traceWritePromises.push(tracer.endStep(actionUUID, i, stepStartTime, null, error));
      const { writePromise } = tracer.endAction(actionUUID, startTime, null, error);
      traceWritePromises.push(writePromise);
      getActionStatsCounter().increment(action.name, 'errors').catch(() => {});
      throw new Error(`Step ${i + 1} failed: ${error.message}`);
    }
  }

  const result = {
    result: lastStepOutput,
    ...(context.parent_messages && { parent_messages: context.parent_messages })
  };

  const { duration, writePromise: endWritePromise } = tracer.endAction(actionUUID, startTime, result);
  traceWritePromises.push(endWritePromise);

  // Track action stats (fire-and-forget)
  getActionStatsCounter().increment(action.name, 'executions').catch(() => {});

  // Root action: run post_steps if defined
  if (!traceUUID) {
    if (action.post_steps?.length) {
      // Wait for all trace writes to complete before running post_steps
      await Promise.all(traceWritePromises);
      // Fire-and-forget post_steps
      runPostSteps(action.post_steps, actionUUID);
    }
    return { ...result, _traceUUID: actionUUID, _duration: duration };
  }

  // Child action: return trace write promises for parent to collect
  return { ...result, _traceWrites: traceWritePromises };
}

async function executeLLMStep(step, context, actionUUID, stepIndex, actionName, traceWritePromises) {
  const { intelligence, output_schema, tool_choice, skip_if } = step;
  // Add stop_action to context if tool_choice is defined (used in message templates)
  if (tool_choice?.stop_action) {
    context = { ...context, stop_action: tool_choice.stop_action };
  }

  if (skip_if) {
    const skipped = skip_if(context);
    getActionStatsCounter().increment(`${actionName}:step${stepIndex}`, skipped ? 'skipped' : 'notSkipped').catch(() => {});
    if (skipped) return { skipped: true };
  }

  // Build tools and examples sections and render templates with fresh context
  const toolsSection = tool_choice?.available_actions
    ? buildToolsSection(tool_choice.available_actions)
    : '';
  const examplesSection = tool_choice?.available_actions
    ? buildExamplesSection(tool_choice.available_actions)
    : '';
  const templateContext = { ...context, tools_section: toolsSection, examples_section: examplesSection };
  const sysPrompt = await renderWithContext(step.system_prompt, templateContext);
  const userMsg = await renderWithContext(step.message, templateContext);

  const tracedGenerate = createTracedGenerate(generate, actionUUID, stepIndex, traceWritePromises);

  // Single-turn: no tool_choice
  if (!tool_choice) {
    const response = await tracedGenerate({
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }],
      intelligence, schema: output_schema
    });
    return { result: response.result };
  }

  // Multi-turn with tools
  const { available_actions, stop_action, max_iterations } = tool_choice;
  const tools = buildTools(available_actions);
  let conversation = [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }];
  const addToolResult = (id, content) => conversation.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(content) });

  for (let turn = 0; turn < max_iterations; turn++) {
    const response = await tracedGenerate({ messages: conversation, intelligence, tools }, turn, max_iterations);
    const message = response.result;

    if (!message.tool_calls?.length) {
      traceWritePromises.push(tracer.traceWarning(actionUUID, stepIndex, 'LLM returned text instead of tool call', { content: message.content }));
      getActionStatsCounter().increment(actionName, 'errors').catch(() => {});
      getActionStatsCounter().increment(actionName, 'textInsteadOfTool').catch(() => {});
      conversation.push({ role: 'assistant', content: message.content });
      conversation.push({ role: 'user', content: 'Please call one of the available tools to proceed. Use FINAL_RESPONSE if complete or if data is gathered and needs formatting or extraction.' });
      continue;
    }

    conversation.push({ role: 'assistant', content: null, tool_calls: message.tool_calls });

    for (const call of message.tool_calls) {
      const toolName = call.function.name;
      // Track which tool was chosen by this action
      getActionStatsCounter().increment(actionName, `choice:${toolName}`).catch(() => {});

      let args;
      try { args = JSON.parse(call.function.arguments); }
      catch {
        getActionStatsCounter().increment(actionName, 'errors').catch(() => {});
        getActionStatsCounter().increment(actionName, 'invalidJsonArgs').catch(() => {});
        addToolResult(call.id, { error: 'Invalid JSON in arguments' });
        break;
      }

      const action = actionsRegistry[toolName];
      if (!action) {
        getActionStatsCounter().increment(actionName, 'errors').catch(() => {});
        getActionStatsCounter().increment(actionName, 'unknownAction').catch(() => {});
        addToolResult(call.id, { error: `Unknown action: ${toolName}` });
        break;
      }

      try {
        const childUUID = `${actionUUID}_${stepIndex}_${crypto.randomUUID()}`;
        const res = await executeAction(action, args, conversation, childUUID);
        // Collect child's trace write promises
        if (res._traceWrites) {
          traceWritePromises.push(...res._traceWrites);
          delete res._traceWrites;
        }
        if (toolName === stop_action) {
          getActionStatsCounter().increment(actionName, 'iterations', turn + 1).catch(() => {});
          return { result: res.result };
        }
        if (res.parent_messages) conversation = res.parent_messages;
        addToolResult(call.id, res.result);
      } catch (err) {
        addToolResult(call.id, err.isValidationError ? { error: 'Validation failed', details: err.validationErrors } : { error: err.message });
        break;
      }
    }

    const continuationMsg = await renderWithContext(step.continuation_message, { ...context, tools_section: toolsSection, examples_section: examplesSection });
    conversation.push({ role: 'user', content: continuationMsg });
  }

  traceWritePromises.push(tracer.traceWarning(actionUUID, stepIndex, 'Max iterations reached', { max_iterations }));
  getActionStatsCounter().increment(actionName, 'maxIterationsReached').catch(() => {});
  getActionStatsCounter().increment(actionName, 'iterations', max_iterations).catch(() => {});
  const stopUUID = `${actionUUID}_${stepIndex}_${crypto.randomUUID()}`;
  const stopRes = await executeAction(actionsRegistry[stop_action], { justification: 'Max iterations reached' }, conversation, stopUUID);
  // Collect stop action's trace write promises
  if (stopRes._traceWrites) {
    traceWritePromises.push(...stopRes._traceWrites);
  }
  return { result: stopRes.result };
}

function createTracedGenerate(generateFn, actionUUID, stepIndex, traceWritePromises) {
  return async function tracedGenerate(options, turn = null, maxTurns = null) {
    const startTime = performance.now();
    let response, error;

    const onModelError = ({ endpoint, model, openrouterProvider, error: errMsg, phase }) => {
      const modelName = openrouterProvider ? `${model}@${openrouterProvider}` : `${endpoint}/${model}`;
      traceWritePromises.push(tracer.traceWarning(actionUUID, stepIndex, `Model error (${phase}): ${modelName}`, { error: errMsg }));
    };

    try {
      response = await generateFn({ ...options, onModelError });
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

    traceWritePromises.push(tracer.traceLLM(actionUUID, stepIndex, response?.model || 'unknown', promptStr, response, duration, turn, maxTurns, error));

    if (error) throw error;
    return response;
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
