/**
 * Actions registry - central export for all actions
 */
import type { Action, ActionsRegistry } from './types/index.js';
import { browserActions, BROWSER_ACTION_ROUTER } from './browser-actions.js';
import { FINAL_RESPONSE_ACTION } from './final-response-action.js';
import { LLM_ACTION } from './llm-action.js';
import { ROUTER_ACTION } from './router-action.js';
import { knowledgeBaseActions } from './knowledge-base-action.js';
import { USER_CLARIFICATION_ACTION } from './clarification-actions.js';
import { TRACE_ANALYZER_ACTION } from './trace-analyzer-action.js';
import { CONTEXT_SELECTOR_ACTION } from './context-selector-action.js';
import logger from '../logger.js';

export type { ClarificationAnswer } from './clarification-actions.js';

// Re-export types
export type { Action, ActionsRegistry, StepResult, StepContext, Message } from './types/index.js';

// Build registry from all actions
const allActions: Action[] = [
  ...browserActions,
  FINAL_RESPONSE_ACTION,
  LLM_ACTION,
  ROUTER_ACTION,
  BROWSER_ACTION_ROUTER,
  TRACE_ANALYZER_ACTION,
  ...knowledgeBaseActions,
  USER_CLARIFICATION_ACTION,
  CONTEXT_SELECTOR_ACTION
];

export const actionsRegistry: ActionsRegistry = Object.fromEntries(
  allActions.map(a => [a.name, a])
);

logger.info(`Loaded ${Object.keys(actionsRegistry).length} actions`);

export const getAction = (name: string): Action | undefined => actionsRegistry[name];
