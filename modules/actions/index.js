/**
 * Actions registry - central export for all actions
 */
import Mustache from 'mustache';
import { browserActions, browserActionRouter } from './browser-actions.js';
import { finalResponseAction, FINAL_RESPONSE } from './final-response-action.js';
import { llmAction, LLM_TOOL } from './llm-action.js';
import { routerAction, BROWSER_ROUTER } from './router-action.js';
import logger from '../logger.js';

// Re-export constants
export { FINAL_RESPONSE } from './final-response-action.js';
export { LLM_TOOL } from './llm-action.js';
export { BROWSER_ROUTER } from './router-action.js';
export { BROWSER_ACTION } from './browser-actions.js';

// Build registry from all actions
const allActions = [
  ...browserActions,
  finalResponseAction,
  llmAction,
  routerAction,
  browserActionRouter
];

export const actionsRegistry = Object.fromEntries(
  allActions.map(a => [a.name, a])
);

logger.info(`Loaded ${Object.keys(actionsRegistry).length} actions`);

export const getAction = name => actionsRegistry[name];

/**
 * Build decision guide from action examples
 */
function buildDecisionGuide(availableActions) {
  return availableActions.flatMap(name => {
    const action = actionsRegistry[name];
    return (action?.examples || []).map(ex => `- "${ex}" → ${name}`);
  }).join('\n');
}

/**
 * Resolve system prompt template
 */
function resolvePrompt(promptConfig, context) {
  if (typeof promptConfig === 'string') return Mustache.render(promptConfig, context);
  return String(promptConfig);
}

/**
 * Resolve all templates for an LLM step
 * Returns { systemPrompt, message }
 */
export function resolveStepTemplates(step, action, context) {
  let systemPrompt;

  if (step.tool_choice?.available_actions) {
    const decisionGuide = buildDecisionGuide(step.tool_choice.available_actions);
    const template = `You are an assistant that can {{description}}. Execute the user's request by calling the appropriate tool.

**Decision Guide:**
{{decisionGuide}}

IMPORTANT: Always call a tool. Always finish with {{stopAction}}`;

    systemPrompt = Mustache.render(template, {
      description: action.description,
      decisionGuide,
      stopAction: step.tool_choice.stop_action
    });
  } else {
    systemPrompt = resolvePrompt(step.system_prompt, context);
  }

  const message = Mustache.render(step.message, context);

  return { systemPrompt, message };
}
