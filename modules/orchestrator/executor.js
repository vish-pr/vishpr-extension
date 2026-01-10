/**
 * Step execution engine for orchestrator
 * Handles polymorphic step execution, multi-turn loops, and context accumulation
 */

import { mapParamsFromContext, validateParams } from './context.js';
import { renderTemplate, resolveSystemPrompt } from './templates.js';
import logger from '../logger.js';
import { getBrowserStateBundle } from '../browser-state.js';
import { generate } from '../llm.js';
import { browserActions } from '../actions/browser-actions.js';
import { chatAction, CHAT_RESPONSE } from '../actions/chat-action.js';
import { routerAction } from '../actions/router-action.js';

/**
 * Execution timeout constants
 */
const STEP_TIMEOUT_MS = 20000;
const LLM_TIMEOUT_MS = 40000;

/**
 * Build the global actions registry
 * Combines all action definitions into a single lookup object
 */
function buildActionsRegistry() {
  const registry = {};

  // Combine all action modules
  const allActions = [
    ...browserActions,
    chatAction,
    routerAction
  ];

  // Build lookup by action name
  for (const action of allActions) {
    if (registry[action.name]) {
      logger.warn(`Duplicate action name: ${action.name}`);
    }
    registry[action.name] = action;
  }

  logger.info(`Loaded ${Object.keys(registry).length} actions`);
  return registry;
}

// Global actions registry
const actionsRegistry = buildActionsRegistry();

/**
 * Get an action by name from the registry
 * @param {string} actionName - Name of the action
 * @returns {Object|undefined} Action definition or undefined if not found
 */
export function getAction(actionName) {
  return actionsRegistry[actionName];
}

/**
 * Get browser state and prepare context with it
 * @param {Object} context - Current context
 * @returns {Object} { contextWithBrowserState, browserStateFormatted }
 */
function prepareBrowserStateContext(context) {
  const { formatted, json } = getBrowserStateBundle();

  return {
    contextWithBrowserState: {
      ...context,
      browser_state_formatted: formatted,
      browser_state_json: json
    },
    browserStateFormatted: formatted
  };
}

/**
 * Append browser state to the last user message in conversation
 * @param {Array} conversation - Array of message objects
 * @param {string} browserStateFormatted - Formatted browser state string
 * @returns {Array} New conversation with browser state appended to last user message
 */
function appendBrowserStateToLastMessage(conversation, browserStateFormatted) {
  const conversationCopy = conversation.map(msg => ({ ...msg }));

  for (let i = conversationCopy.length - 1; i >= 0; i--) {
    if (conversationCopy[i].role === 'user') {
      conversationCopy[i].content = `${conversationCopy[i].content}\n\n${browserStateFormatted}`;
      break;
    }
  }

  return conversationCopy;
}

/**
 * Prune conversation to prevent it from getting too long
 * Keeps first 2 messages (system + initial user) + last 6 messages
 * @param {Array} conversation - Conversation array to prune (modified in place)
 */
function pruneConversation(conversation) {
  if (conversation.length > 10) {
    conversation.splice(2, conversation.length - 8);
    conversation.splice(2, 0, {
      role: 'system',
      content: '... (earlier conversation history truncated) ...'
    });
  }
}

/**
 * Execute an action with its steps
 * @param {Object} action - Action definition
 * @param {Object} initialParams - Initial parameters
 * @returns {Promise<Object>} Action result
 */
export async function executeAction(action, initialParams = {}) {
  let context = { ...initialParams };
  let lastOutput = null;

  logger.info(`Action Start: ${action.name}`, { params: initialParams });

  // Validate input parameters if schema is provided
  if (action.input_schema) {
    const validation = validateParams(initialParams, action.input_schema);
    if (!validation.valid) {
      logger.warn(`Input validation warnings for ${action.name}`, { errors: validation.errors });
    }
  }

  // Execute each step sequentially
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    logger.info(`Step ${i + 1}/${action.steps.length}: ${action.name}`, {
      stepType: typeof step === 'function' ? 'function' : typeof step === 'string' ? 'action' : 'llm'
    });

    try {
      let result;

      // Type 1: Function step (custom logic)
      if (typeof step === 'function') {
        logger.debug(`Executing function step in ${action.name}`);
        result = await executeWithTimeout(
          step(context),
          STEP_TIMEOUT_MS
        );
        logger.debug(`Function step completed`, { result });
      }
      // Type 2: ACTION_NAME (call another action)
      else if (typeof step === 'string') {
        logger.info(`Calling sub-action: ${step}`);
        const subAction = actionsRegistry[step];
        if (!subAction) {
          throw new Error(`Action not found: ${step}`);
        }
        const subParams = mapParamsFromContext(subAction.input_schema, context);
        result = await executeAction(subAction, subParams);
        logger.info(`Sub-action completed: ${step}`);
      }
      // Type 3: LLMConfig (LLM call)
      else if (typeof step === 'object' && step !== null) {
        if (step.choice) {
          logger.info(`Starting multi-turn LLM loop`, { maxIterations: step.choice.max_iterations });
        } else {
          logger.info(`Executing single LLM call`);
        }
        result = await executeLLMStep(step, context);
      }
      else {
        throw new Error(`Invalid step type: ${typeof step}`);
      }

      // Accumulate context with step results
      if (result && typeof result === 'object') {
        Object.assign(context, result);
        lastOutput = result;
      }
    } catch (error) {
      logger.error(`Step ${i + 1} failed in ${action.name}`, { error: error.message, stack: error.stack });
      throw new Error(`Step ${i + 1} failed: ${error.message}`);
    }
  }

  logger.info(`Action Complete: ${action.name}`, { result: lastOutput });
  return lastOutput || context;
}

/**
 * Execute an LLM step (single call or multi-turn agentic loop)
 * @param {Object} llmConfig - LLM configuration (with or without choice)
 * @param {Object} context - Current execution context
 * @returns {Promise<Object>} LLM response or result from stop action
 */
async function executeLLMStep(llmConfig, context) {
  // Get browser state and prepare context
  const { contextWithBrowserState, browserStateFormatted } = prepareBrowserStateContext(context);

  // Resolve system prompt
  const systemPrompt = await resolveSystemPrompt(
    llmConfig.system_prompt,
    contextWithBrowserState,
    generate
  );

  // Initialize conversation
  const initialMessage = renderTemplate(llmConfig.message, contextWithBrowserState);
  const conversation = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialMessage }
  ];

  // Single LLM call (no choice)
  if (!llmConfig.choice) {
    const conversationWithBrowserState = appendBrowserStateToLastMessage(
      conversation,
      browserStateFormatted
    );

    return await executeWithTimeout(
      generate({
        messages: conversationWithBrowserState,
        intelligence: llmConfig.intelligence || 'MEDIUM',
        schema: llmConfig.schema
      }),
      LLM_TIMEOUT_MS
    );
  }

  // Multi-turn agentic loop
  const {
    available_actions,
    stop_action = CHAT_RESPONSE,
    max_iterations = 5
  } = llmConfig.choice;

  logger.info(`Multi-turn loop started`, {
    maxIterations: max_iterations,
    availableActions: available_actions,
    stopAction: stop_action
  });

  for (let iteration = 0; iteration < max_iterations; iteration++) {
    logger.info(`Iteration ${iteration + 1}/${max_iterations}`);

    // Build choice schema based on available actions
    const choiceSchema = buildChoiceSchema(
      available_actions,
      stop_action
    );

    // Prepare conversation with browser state appended
    const conversationWithBrowserState = appendBrowserStateToLastMessage(
      conversation,
      browserStateFormatted
    );

    // Get LLM choice
    const choice = await executeWithTimeout(
      generate({
        messages: conversationWithBrowserState,
        intelligence: llmConfig.intelligence || 'MEDIUM',
        schema: choiceSchema
      }),
      LLM_TIMEOUT_MS
    );

    logger.info(`LLM chose action: ${choice.tool}`, {
      tool: choice.tool,
      justification: choice.justification,
      params: Object.keys(choice).filter(k => k !== 'tool' && k !== 'justification')
    });

    // Add LLM's choice to conversation
    conversation.push({
      role: 'assistant',
      content: JSON.stringify(choice, null, 2)
    });

    // Check if stop action chosen
    if (choice.tool === stop_action) {
      logger.info(`Stop action reached: ${stop_action}`);
      const stopActionDef = actionsRegistry[stop_action];
      if (!stopActionDef) {
        throw new Error(`Stop action not found: ${stop_action}`);
      }

      return await executeAction(
        stopActionDef,
        { ...context, ...choice }
      );
    }

    // Execute chosen action
    const actionDef = actionsRegistry[choice.tool];
    if (!actionDef) {
      throw new Error(`Action not found: ${choice.tool}`);
    }

    const actionResult = await executeAction(
      actionDef,
      { ...context, ...choice }
    );

    logger.info(`Action result: ${choice.tool}`, { result: actionResult });

    // Add result to conversation
    conversation.push({
      role: 'user',
      content: `Action completed successfully. Result:\n${JSON.stringify(actionResult, null, 2)}`
    });

    // Accumulate context
    Object.assign(context, actionResult);

    // Prune conversation if getting too long
    pruneConversation(conversation);
  }

  // Max iterations reached - force stop action
  console.warn(`[Orchestrator] Max iterations (${max_iterations}) reached, forcing stop action`);
  logger.warn(`Max iterations reached (${max_iterations}), forcing stop action`);
  const stopActionDef = actionsRegistry[stop_action];
  return await executeAction(
    stopActionDef,
    {
      ...context,
      note: 'Maximum iterations reached',
      tool: stop_action
    }
  );
}

/**
 * Build JSON schema for action choice
 * @param {string[]} availableActions - List of available action names
 * @param {string} stopAction - Name of stop action
 * @returns {Object} JSON Schema for choice
 */
function buildChoiceSchema(availableActions, stopAction) {
  const actionDescriptions = [];
  const allParameters = {};

  // Build descriptions and collect parameters in single loop
  for (const actionName of availableActions) {
    const action = actionsRegistry[actionName];

    // Add to descriptions
    const desc = action?.description || actionName;
    const isStop = actionName === stopAction ? ' [STOP ACTION]' : '';
    actionDescriptions.push(`${actionName}: ${desc}${isStop}`);

    // Collect parameters (skip duplicates to avoid conflicts)
    if (action?.input_schema?.properties) {
      for (const [key, propSchema] of Object.entries(action.input_schema.properties)) {
        if (!allParameters[key]) {
          allParameters[key] = {
            ...propSchema,
            description: `${propSchema.description || ''} (for ${actionName})`.trim()
          };
        }
      }
    }
  }

  return {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        enum: availableActions,
        description: `Choose the next action to execute. Use ${stopAction} when the task is complete or you need to respond to the user.\n\nAvailable actions:\n${actionDescriptions.join('\n')}`
      },
      justification: {
        type: 'string',
        description: 'Explain why you chose this action and what you expect it to accomplish'
      },
      ...allParameters
    },
    required: ['tool', 'justification'],
    additionalProperties: false
  };
}

/**
 * Execute a promise with timeout
 * @param {Promise} promise - Promise to execute
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise} Result or timeout error
 */
async function executeWithTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}
