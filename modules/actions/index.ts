/**
 * Actions registry - central export for all actions
 */
import mustache from 'mustache';
import type { Action, ActionsRegistry, LLMStep, StepContext } from './types/index.js';
import { browserActions, browserActionRouter } from './browser-actions.js';
import { finalResponseAction, FINAL_RESPONSE } from './final-response-action.js';
import { llmAction, LLM_TOOL } from './llm-action.js';
import { routerAction, BROWSER_ROUTER } from './router-action.js';
import { cleanContentAction, CLEAN_CONTENT } from './clean-content-action.js';
import { critiqueAction, CRITIQUE } from './critique-action.js';
import {
  knowledgeBaseActions,
  RIDDLER,
  ANSWERER,
  CHECKER,
  ADAPTAR,
  KNOWLEDGE_BASE_ADAPTOR
} from './knowledge-base-action.js';
import { clarificationActions } from './clarification-actions.js';
import {
  preferenceExtractorActions,
  PREFERENCE_EXTRACTOR
} from './preference-extractor-action.js';
import logger from '../logger.js';

// Re-export constants
export { FINAL_RESPONSE } from './final-response-action.js';
export { LLM_TOOL } from './llm-action.js';
export { BROWSER_ROUTER } from './router-action.js';
export { BROWSER_ACTION } from './browser-actions.js';
export { CLEAN_CONTENT } from './clean-content-action.js';
export { CRITIQUE } from './critique-action.js';
export { RIDDLER, ANSWERER, CHECKER, ADAPTAR, KNOWLEDGE_BASE_ADAPTOR } from './knowledge-base-action.js';
export { USER_CLARIFICATION } from './clarification-actions.js';
export { PREFERENCE_EXTRACTOR } from './preference-extractor-action.js';
export type { ClarificationAnswer } from './clarification-actions.js';

// Re-export types
export type { Action, ActionsRegistry, StepResult, StepContext, Message } from './types/index.js';

// Build registry from all actions
const allActions: Action[] = [
  ...browserActions,
  finalResponseAction,
  llmAction,
  routerAction,
  browserActionRouter,
  cleanContentAction,
  critiqueAction,
  ...knowledgeBaseActions,
  ...clarificationActions,
  ...preferenceExtractorActions
];

export const actionsRegistry: ActionsRegistry = Object.fromEntries(
  allActions.map(a => [a.name, a])
);

logger.info(`Loaded ${Object.keys(actionsRegistry).length} actions`);

export const getAction = (name: string): Action | undefined => actionsRegistry[name];

/**
 * Build decision guide from action examples
 */
function buildDecisionGuide(availableActions: string[]): string {
  return availableActions.flatMap(name => {
    const action = actionsRegistry[name];
    return (action?.examples || []).map(ex => `- "${ex}" → ${name}`);
  }).join('\n');
}

interface ResolvedTemplates {
  systemPrompt: (ctx: StepContext) => string;
  renderMessage: (ctx: StepContext) => string;
}

/**
 * Resolve all templates for an LLM step
 * Returns { systemPrompt, renderMessage }
 */
export function resolveStepTemplates(step: LLMStep): ResolvedTemplates {
  const decisionGuide = step.tool_choice?.available_actions
    ? buildDecisionGuide(step.tool_choice.available_actions)
    : '';

  const render = (template: string, ctx: StepContext): string =>
    mustache.render(template, { ...ctx, decisionGuide });

  return {
    systemPrompt: (ctx: StepContext) => render(step.system_prompt, ctx),
    renderMessage: (ctx: StepContext) => render(step.message, ctx)
  };
}
