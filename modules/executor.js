/**
 * Action executor - Params in, result out
 */
import Mustache from 'mustache';
import logger from './logger.js';
import { getBrowserStateBundle } from './browser-state.js';
import { generate } from './llm/index.js';
import { actionsRegistry } from './actions/index.js';

const STEP_TIMEOUT_MS = 20000;
const LLM_TIMEOUT_MS = 40000;

const TYPE_CHECKS = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number',
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => typeof v === 'object' && !Array.isArray(v)
};

async function resolveSystemPrompt(systemPrompt, context) {
  if (typeof systemPrompt === 'string') return Mustache.render(systemPrompt, context);
  if (systemPrompt && typeof systemPrompt === 'object') {
    const result = await generate({
      messages: [
        { role: 'system', content: await resolveSystemPrompt(systemPrompt.system_prompt, context) },
        { role: 'user', content: Mustache.render(systemPrompt.message, context) }
      ],
      intelligence: systemPrompt.intelligence,
      schema: {
        type: 'object',
        properties: { system_description: { type: 'string', description: 'Generated system prompt' } },
        required: ['system_description'],
        additionalProperties: false
      }
    });
    return result.system_description;
  }
  return String(systemPrompt);
}

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

export async function executeAction(action, params = {}) {
  logger.info(`Action: ${action.name}`, { params });

  if (action.input_schema) {
    const { valid, errors } = validateParams(params, action.input_schema);
    if (!valid) {
      const error = new Error(`Validation failed for ${action.name}: ${errors.join(', ')}`);
      Object.assign(error, { isValidationError: true, validationErrors: errors });
      logger.error(error.message, { errors });
      throw error;
    }
  }

  let result = null;
  for (let i = 0; i < action.steps.length; i++) {
    try {
      result = await executeStep(action.steps[i], params, result);
    } catch (error) {
      logger.error(`Step ${i + 1} failed: ${action.name}`, { error: error.message });
      throw new Error(`Step ${i + 1} failed: ${error.message}`);
    }
  }
  logger.info(`Action complete: ${action.name}`);
  return result;
}

async function executeStep(step, params, prevResult) {
  if (typeof step === 'function') return withTimeout(step(params, prevResult), STEP_TIMEOUT_MS);
  if (step.type === 'llm') return executeLLMStep(step, params, prevResult);
  throw new Error(`Unknown step type: ${JSON.stringify(step)}`);
}

async function executeLLMStep(step, params, prevResult = {}) {
  const { system_prompt, message, intelligence, output_schema, tool_choice } = step;
  const templateCtx = { ...params, ...prevResult };

  if (tool_choice?.available_actions) {
    templateCtx.available_tools = buildToolDescriptions(tool_choice.available_actions, tool_choice.stop_action);
    templateCtx.decision_guide = buildDecisionGuide(tool_choice.available_actions);
  }

  const resolvedSystemPrompt = await resolveSystemPrompt(system_prompt, templateCtx);
  const resolvedMessage = Mustache.render(message, templateCtx);

  if (!tool_choice) {
    return withTimeout(
      generate({
        messages: await insertBrowserState([
          { role: 'system', content: resolvedSystemPrompt },
          { role: 'user', content: resolvedMessage }
        ]),
        intelligence,
        schema: output_schema
      }),
      LLM_TIMEOUT_MS
    );
  }
  return executeMultiTurn(resolvedSystemPrompt, resolvedMessage, tool_choice, intelligence);
}

async function executeMultiTurn(systemPrompt, initialMessage, choice, intelligence) {
  const { available_actions, stop_action, max_iterations } = choice;
  const conversation = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialMessage }
  ];
  const tools = buildTools(available_actions);
  const addToolResponse = (id, content) => conversation.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(content) });

  for (let i = 0; i < max_iterations; i++) {
    logger.info(`Turn ${i + 1}/${max_iterations}`);

    const llmResponse = await withTimeout(
      generate({ messages: await insertBrowserState(conversation), intelligence, tools }),
      LLM_TIMEOUT_MS
    );

    if (!llmResponse.tool_calls?.length) {
      logger.warn('LLM returned text instead of tool call, prompting to use tools');
      conversation.push({ role: 'assistant', content: llmResponse.content || 'I need to use a tool to help with this.' });
      conversation.push({ role: 'user', content: 'Please call one of the available tools to proceed.' });
      continue;
    }

    conversation.push({ role: 'assistant', content: null, tool_calls: llmResponse.tool_calls });

    // Execute all tool calls serially with individual timeouts
    for (const toolCall of llmResponse.tool_calls) {
      const { name: toolName } = toolCall.function;
      let toolArgs;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        logger.error('Invalid JSON in tool arguments', { raw: toolCall.function.arguments });
        addToolResponse(toolCall.id, { error: 'Invalid JSON in tool arguments' });
        break;
      }

      logger.info(`Tool call: ${toolName}`, { id: toolCall.id });

      const targetAction = actionsRegistry[toolName];
      if (!targetAction) {
        addToolResponse(toolCall.id, { error: `Action not found: ${toolName}` });
        break;
      }

      const actionParams = pickParams(toolArgs, targetAction);
      if (toolName === stop_action) actionParams.messages = JSON.stringify(conversation, null, 2);

      try {
        const result = await withTimeout(executeAction(targetAction, actionParams), STEP_TIMEOUT_MS);
        if (toolName === stop_action) return unwrapStopResult(result);
        addToolResponse(toolCall.id, result);
      } catch (error) {
        const errorContent = error.isValidationError
          ? { error: 'Validation failed', details: error.validationErrors }
          : { error: error.message };
        logger.warn(`${toolName} failed`, errorContent);
        addToolResponse(toolCall.id, errorContent);
        break; // Stop executing remaining tool calls on error
      }
    }

    if (conversation.length > 12) conversation.splice(2, conversation.length - 10);
  }

  logger.error('Max iterations reached, invoking stop action');
  const stopResponse = 'I was unable to complete the task within the allowed number of steps. Here is what I accomplished so far.';
  conversation.push({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: `max-iter-${Date.now()}`,
      type: 'function',
      function: { name: stop_action, arguments: JSON.stringify({ response: stopResponse, justification: 'Maximum iterations reached' }) }
    }]
  });

  return unwrapStopResult(await executeAction(actionsRegistry[stop_action], {
    response: stopResponse,
    messages: JSON.stringify(conversation, null, 2)
  }));
}

function pickParams(source, actionDef) {
  if (!actionDef.input_schema?.properties) return {};
  return Object.fromEntries(
    Object.keys(actionDef.input_schema.properties).filter(k => k in source).map(k => [k, source[k]])
  );
}

async function insertBrowserState(conversation) {
  const browserState = await getBrowserStateBundle();
  const copy = conversation.map(m => ({ ...m }));
  const lastUserIdx = copy.findLastIndex(m => m.role === 'user');
  const browserMsg = { role: 'user', content: `Current Browser State:\n${browserState}` };
  lastUserIdx > 0 ? copy.splice(lastUserIdx, 0, browserMsg) : copy.push(browserMsg);
  return copy;
}

function buildTools(availableActions) {
  return availableActions.map(name => {
    const action = actionsRegistry[name];
    return action && {
      type: 'function',
      function: {
        name: action.name,
        description: action.description,
        parameters: {
          type: 'object',
          properties: {
            justification: { type: 'string', description: 'Why this tool is appropriate' },
            instructions: { type: 'string', description: 'Instructions for the tool' },
            ...(action.input_schema?.properties || {})
          },
          required: ['justification', 'instructions', ...(action.input_schema?.required || [])],
          additionalProperties: false
        }
      }
    };
  }).filter(Boolean);
}

function buildToolDescriptions(actionNames, stopAction) {
  return actionNames.map((name, i) => {
    const action = actionsRegistry[name];
    const required = action?.input_schema?.required?.length ? `\n   Requires: ${action.input_schema.required.join(', ')}` : '';
    return `${i + 1}. **${name}**${name === stopAction ? ' [STOP]' : ''}: ${action.description}${required}`;
  }).join('\n\n');
}

function buildDecisionGuide(actionNames) {
  return actionNames.flatMap(name => {
    const action = actionsRegistry[name];
    return (action?.examples || []).map(ex => `- "${ex}" → ${name}`);
  }).join('\n');
}

function unwrapStopResult(result) {
  return typeof result === 'string' ? result : result?.message || result?.response || JSON.stringify(result);
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms))
]);
