/**
 * Actions registry - central export for all actions
 */
import type { Action, ActionsRegistry } from './types/index.js';
import { browserActions, browserActionRouter } from './browser-actions.js';
import { finalResponseAction } from './final-response-action.js';
import { llmAction } from './llm-action.js';
import { routerAction } from './router-action.js';
import { critiqueAction } from './critique-action.js';
import { knowledgeBaseActions } from './knowledge-base-action.js';
import { clarificationActions } from './clarification-actions.js';
import { preferenceExtractorActions } from './preference-extractor-action.js';
import logger from '../logger.js';

// Re-export constants
export { FINAL_RESPONSE } from './final-response-action.js';
export { LLM_TOOL } from './llm-action.js';
export { BROWSER_ROUTER } from './router-action.js';
export { BROWSER_ACTION } from './browser-actions.js';
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
