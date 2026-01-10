/**
 * Action executor - Params in, result out
 */
import { validateParams } from './context.js';
import { renderTemplate, resolveSystemPrompt } from './templates.js';
import logger from '../logger.js';
import { getBrowserStateBundle } from '../browser-state.js';
import { generate } from '../llm.js';
import { browserActions } from '../actions/browser-actions.js';
import { chatAction, CHAT_RESPONSE } from '../actions/chat-action.js';
import { routerAction } from '../actions/router-action.js';
import { browserActionRouter } from '../actions/browser-action-router.js';

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
    return withTimeout(step(params, prevResult, await getBrowserStateBundle()), STEP_TIMEOUT_MS);
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
  const browser = await getBrowserStateBundle();
  const useSummary = step.use_browser_summary === true;
  const browserStateText = useSummary ? browser.summary : browser.formatted;

  const templateCtx = {
    ...params,
    browser_state_formatted: browser.formatted,
    browser_state_summary: browser.summary,
    browser_state_json: browser.json
  };

  const systemPrompt = await resolveSystemPrompt(llm.system_prompt, templateCtx, generate);
  const message = renderTemplate(llm.message, templateCtx);

  if (!choice) {
    const messages = insertBrowserStateMessage([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ], browserStateText);
    return withTimeout(
      generate({ messages, intelligence: llm.intelligence || 'MEDIUM', schema: llm.schema }),
      LLM_TIMEOUT_MS
    );
  }
  return executeMultiTurn(systemPrompt, message, choice, llm.intelligence, useSummary);
}

async function executeMultiTurn(systemPrompt, initialMessage, choice, intelligence, useSummary = false) {
  const { available_actions, stop_action = CHAT_RESPONSE, max_iterations = 5 } = choice;
  const conversation = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialMessage }
  ];
  const fullHistory = [];

  for (let i = 0; i < max_iterations; i++) {
    logger.info(`Turn ${i + 1}/${max_iterations}`);
    const browser = await getBrowserStateBundle();
    const messagesWithBrowser = insertBrowserStateMessage(
      conversation, useSummary ? browser.summary : browser.formatted
    );

    const llmChoice = await withTimeout(
      generate({
        messages: messagesWithBrowser,
        intelligence: intelligence || 'MEDIUM',
        schema: buildChoiceSchema(available_actions)
      }),
      LLM_TIMEOUT_MS
    );

    logger.info(`Chose: ${llmChoice.tool}`);
    conversation.push({ role: 'assistant', content: JSON.stringify(llmChoice, null, 2) });
    fullHistory.push({ turn: i + 1, action: llmChoice.tool, params: llmChoice, timestamp: new Date().toISOString() });

    const targetAction = actionsRegistry[llmChoice.tool];
    if (!targetAction) throw new Error(`Action not found: ${llmChoice.tool}`);

    const actionParams = pickParams(llmChoice, targetAction);
    if (llmChoice.tool === stop_action) {
      actionParams.conversation_history = formatConversationHistory(fullHistory);
    }

    try {
      const result = await executeAction(targetAction, actionParams);
      if (llmChoice.tool === stop_action) return result;
      fullHistory[fullHistory.length - 1].result = result;
      conversation.push({ role: 'user', content: `Result:\n${JSON.stringify(result, null, 2)}` });
    } catch (error) {
      if (error.isValidationError) {
        logger.warn(`${llmChoice.tool} validation failed`, { errors: error.validationErrors });
        fullHistory[fullHistory.length - 1].error = error.validationErrors.join(', ');
        conversation.push({
          role: 'user',
          content: `Error: ${llmChoice.tool} validation failed.\nErrors: ${error.validationErrors.join(', ')}\nPlease fix and retry.`
        });
        continue;
      }
      throw error;
    }

    if (conversation.length > 10) conversation.splice(2, conversation.length - 8);
  }

  logger.warn('Max iterations reached');
  return executeAction(actionsRegistry[stop_action], { response: 'Unable to complete within allowed iterations.' });
}

function pickParams(source, actionDef) {
  if (!actionDef.input_schema?.properties) return {};
  return Object.fromEntries(
    Object.keys(actionDef.input_schema.properties).filter(k => k in source).map(k => [k, source[k]])
  );
}

function formatConversationHistory(history) {
  if (!history?.length) return 'No previous actions in this conversation.';
  return history.map(e => {
    let line = `Turn ${e.turn}: ${e.action}`;
    if (e.params?.instructions) line += `\n  Instructions: ${e.params.instructions}`;
    if (e.result) {
      const str = typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2);
      line += `\n  Result: ${str.length > 500 ? str.substring(0, 500) + '...' : str}`;
    }
    if (e.error) line += `\n  Error: ${e.error}`;
    return line;
  }).join('\n\n');
}

function insertBrowserStateMessage(conversation, browserFormatted) {
  const copy = conversation.map(m => ({ ...m }));
  const lastUserIdx = copy.findLastIndex(m => m.role === 'user');
  const browserMsg = { role: 'user', content: `Current Browser State:\n${browserFormatted}` };
  lastUserIdx > 0 ? copy.splice(lastUserIdx, 0, browserMsg) : copy.push(browserMsg);
  return copy;
}

function buildChoiceSchema(availableActions) {
  const properties = {
    tool: { type: 'string', enum: availableActions, description: 'The tool to use' },
    justification: { type: 'string', description: 'Why this tool is appropriate' },
    instructions: { type: 'string', description: 'Instructions for the tool' },
    notes: { type: 'string', description: 'Additional context' }
  };
  for (const name of availableActions) {
    const action = actionsRegistry[name];
    if (action?.input_schema?.properties) {
      for (const [key, prop] of Object.entries(action.input_schema.properties)) {
        if (!properties[key]) properties[key] = prop;
      }
    }
  }
  return { type: 'object', properties, required: ['tool', 'justification', 'instructions', 'user_message'], additionalProperties: false };
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms))
]);
