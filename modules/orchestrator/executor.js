/**
 * Action executor - Params in, result out
 */
import { validateParams } from './context.js';
import { renderTemplate, resolveSystemPrompt } from './templates.js';
import logger from '../logger.js';
import { getBrowserStateBundle } from '../browser-state.js';
import { generate } from '../llm.js';
import { browserActions, browserActionRouter } from '../actions/browser-actions.js';
import { chatAction, CHAT_RESPONSE } from '../actions/chat-action.js';
import { routerAction } from '../actions/router-action.js';

const STEP_TIMEOUT_MS = 20000;
const LLM_TIMEOUT_MS = 40000;

const actionsRegistry = Object.fromEntries(
  [...browserActions, chatAction, routerAction, browserActionRouter].map(a => [a.name, a])
);
logger.info(`Loaded ${Object.keys(actionsRegistry).length} actions`);

export const getAction = name => actionsRegistry[name];

export async function executeAction(action, params = {}) {
  logger.info(`Action: ${action.name}`, { params });

  if (action.input_schema) {
    const validation = validateParams(params, action.input_schema);
    if (!validation.valid) {
      const error = new Error(`Validation failed for ${action.name}: ${validation.errors.join(', ')}`);
      error.isValidationError = true;
      error.validationErrors = validation.errors;
      logger.error(error.message, { errors: validation.errors });
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
  if (typeof step === 'function') {
    return withTimeout(step(params, prevResult), STEP_TIMEOUT_MS);
  }
  if (step.action) {
    const subAction = actionsRegistry[step.action];
    if (!subAction) throw new Error(`Action not found: ${step.action}`);
    return executeAction(subAction, step.mapParams ? step.mapParams(params, prevResult) : params);
  }
  if (step.llm) return executeLLMStep(step, params);
  throw new Error('Invalid step type');
}

async function executeLLMStep(step, params) {
  const { llm, choice } = step;

  const templateCtx = { ...params };

  // Inject available_tools and decision_guide for actions with choice
  if (choice?.available_actions) {
    templateCtx.available_tools = buildToolDescriptions(choice.available_actions, choice.stop_action);
    templateCtx.decision_guide = buildDecisionGuide(choice.available_actions);
  }

  const systemPrompt = await resolveSystemPrompt(llm.system_prompt, templateCtx, generate);
  const message = renderTemplate(llm.message, templateCtx);

  if (!choice) {
    // Single LLM call with schema - wrap schema in a tool
    const tools = [{
      type: 'function',
      function: {
        name: 'respond',
        description: 'Generate structured response',
        parameters: llm.schema
      }
    }];

    const messages = await insertBrowserState([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ]);

    const result = await withTimeout(
      generate({ messages, intelligence: llm.intelligence || 'MEDIUM', tools }),
      LLM_TIMEOUT_MS
    );

    // Extract arguments from tool call
    if (result.tool_calls?.length) {
      return JSON.parse(result.tool_calls[0].function.arguments || '{}');
    }
    // Fallback if no tool call
    return result.content ? { response: result.content, success: true } : result;
  }
  return executeMultiTurn(systemPrompt, message, choice, llm.intelligence);
}

async function executeMultiTurn(systemPrompt, initialMessage, choice, intelligence) {
  const { available_actions, stop_action = CHAT_RESPONSE, max_iterations = 5 } = choice;
  const conversation = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialMessage }
  ];
  const tools = buildTools(available_actions);

  for (let i = 0; i < max_iterations; i++) {
    logger.info(`Turn ${i + 1}/${max_iterations}`);
    const messagesWithBrowser = await insertBrowserState(conversation);

    const llmResponse = await withTimeout(
      generate({
        messages: messagesWithBrowser,
        intelligence: intelligence || 'MEDIUM',
        tools
      }),
      LLM_TIMEOUT_MS
    );

    if (!llmResponse.tool_calls?.length) {
      throw new Error('LLM did not return expected tool call');
    }

    const toolCall = llmResponse.tool_calls[0];
    const toolName = toolCall.function.name;
    const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

    logger.info(`Tool call: ${toolName}`, { id: toolCall.id });

    // Store assistant message with tool_calls
    conversation.push({
      role: 'assistant',
      content: null,
      tool_calls: llmResponse.tool_calls
    });

    const targetAction = actionsRegistry[toolName];
    if (!targetAction) {
      // Tool not found - send error as tool response
      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({ error: `Action not found: ${toolName}` })
      });
      continue;
    }

    const actionParams = pickParams(toolArgs, targetAction);
    if (toolName === stop_action) {
      actionParams.conversation_history = formatConversationHistory(conversation);
    }

    try {
      const result = await executeAction(targetAction, actionParams);
      if (toolName === stop_action) return result;

      // Send result as tool response
      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result, null, 2)
      });
    } catch (error) {
      const errorContent = error.isValidationError
        ? { error: 'Validation failed', details: error.validationErrors }
        : { error: error.message };

      logger.warn(`${toolName} failed`, errorContent);

      // Send error as tool response
      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(errorContent)
      });
    }

    // Trim conversation if too long (keep system + first user + last 8 messages)
    if (conversation.length > 12) {
      conversation.splice(2, conversation.length - 10);
    }
  }

  logger.error('Max iterations reached, invoking stop action');

  const syntheticToolCallId = `max-iter-${Date.now()}`;
  const stopResponse = 'I was unable to complete the task within the allowed number of steps. Here is what I accomplished so far.';

  conversation.push({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: syntheticToolCallId,
      type: 'function',
      function: {
        name: stop_action,
        arguments: JSON.stringify({ response: stopResponse, justification: 'Maximum iterations reached' })
      }
    }]
  });

  return executeAction(actionsRegistry[stop_action], {
    response: stopResponse,
    conversation_history: formatConversationHistory(conversation)
  });
}

function pickParams(source, actionDef) {
  if (!actionDef.input_schema?.properties) return {};
  return Object.fromEntries(
    Object.keys(actionDef.input_schema.properties).filter(k => k in source).map(k => [k, source[k]])
  );
}

function formatConversationHistory(conversation) {
  const lines = [];
  let turn = 0;

  for (let i = 0; i < conversation.length; i++) {
    const msg = conversation[i];
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;

    const toolCall = msg.tool_calls[0];
    const action = toolCall.function.name;
    const params = JSON.parse(toolCall.function.arguments || '{}');
    turn++;

    let line = `Turn ${turn}: ${action}`;
    if (params.instructions) line += `\n  Instructions: ${params.instructions}`;

    // Find corresponding tool response
    const toolResponse = conversation[i + 1];
    if (toolResponse?.role === 'tool') {
      const content = toolResponse.content;
      const truncated = content.length > 500 ? content.substring(0, 500) + '...' : content;
      line += `\n  Result: ${truncated}`;
    }

    lines.push(line);
  }

  return lines.length ? lines.join('\n\n') : 'No previous actions in this conversation.';
}

async function insertBrowserState(conversation) {
  const browserState = await getBrowserStateBundle();
  const copy = conversation.map(m => ({ ...m }));
  const lastUserIdx = copy.findLastIndex(m => m.role === 'user');
  const browserMsg = { role: 'user', content: `Current Browser State:\n${browserState}` };
  lastUserIdx > 0 ? copy.splice(lastUserIdx, 0, browserMsg) : copy.push(browserMsg);
  return copy;
}

/**
 * Convert action definitions to OpenRouter tools format
 * @param {string[]} availableActions - Action names to include
 * @returns {Array} Tools array for OpenRouter
 */
function buildTools(availableActions) {
  return availableActions.map(name => {
    const action = actionsRegistry[name];
    if (!action) return null;

    // Clone the input_schema and add common fields
    const parameters = {
      type: 'object',
      properties: {
        justification: { type: 'string', description: 'Why this tool is appropriate' },
        instructions: { type: 'string', description: 'Instructions for the tool' },
        ...(action.input_schema?.properties || {})
      },
      required: ['justification', 'instructions', ...(action.input_schema?.required || [])],
      additionalProperties: false
    };

    return {
      type: 'function',
      function: {
        name: action.name,
        description: action.description || `Execute ${action.name}`,
        parameters
      }
    };
  }).filter(Boolean);
}

/**
 * Build formatted tool descriptions from action names
 * Used for dynamic system prompt generation in actions with choice
 */
function buildToolDescriptions(actionNames, stopAction) {
  return actionNames.map((name, index) => {
    const action = actionsRegistry[name];
    const stopMarker = name === stopAction ? ' [STOP]' : '';
    const requiredFields = action?.input_schema?.required?.length
      ? `\n   Requires: ${action.input_schema.required.join(', ')}`
      : '';
    return `${index + 1}. **${name}**${stopMarker}: ${action?.description || 'No description'}${requiredFields}`;
  }).join('\n\n');
}

/**
 * Build decision guide from action examples
 * Maps example queries to their target actions
 */
function buildDecisionGuide(actionNames) {
  const lines = [];
  for (const name of actionNames) {
    const action = actionsRegistry[name];
    if (action?.examples) {
      for (const example of action.examples) {
        lines.push(`- "${example}" → ${name}`);
      }
    }
  }
  return lines.join('\n');
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms))
]);
