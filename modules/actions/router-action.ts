/**
 * Router action (Tier-1) - High-level intent routing
 * Decides between browser actions vs direct chat response
 */
import type { Action } from './types/index.js';
import { BROWSER_ACTION } from './browser-actions.js';
import { FINAL_RESPONSE } from './final-response-action.js';
import { LLM_TOOL } from './llm-action.js';

export const BROWSER_ROUTER = 'BROWSER_ROUTER';

/**
 * BROWSER_ROUTER action (Tier-1)
 * Routes between browser actions and direct chat responses
 */
export const routerAction: Action = {
  name: BROWSER_ROUTER,
  description: 'Route user requests to browser interaction, general knowledge, or final response',
  input_schema: {
    type: 'object',
    properties: {
      user_message: {
        type: 'string',
        description: 'The user\'s natural language request'
      }
    },
    required: ['user_message'],
    additionalProperties: false
  },
  steps: [
    {
      type: 'llm',
      system_prompt: `You are a browser assistant that routes user requests to appropriate tools.
Current time: {{{current_datetime}}}

Tools:
- BROWSER_ACTION: Web page interaction (reading, clicking, forms, navigation)
- LLM_TOOL: General knowledge, analysis, reasoning (no browser needed)
- FINAL_RESPONSE: Task complete, present result to user

Guidelines:
- Break complex tasks into smaller steps
- Use BROWSER_ACTION for anything involving web pages
- Use LLM_TOOL for general knowledge questions
- Always finish with FINAL_RESPONSE

{{{decisionGuide}}}`,
      message: `Browser: {{{browser_state}}}
Goal: {{{user_message}}}
Choose a tool. Use {{{stop_action}}} if complete.`,
      intelligence: 'MEDIUM',
      tool_choice: {
        available_actions: [
          BROWSER_ACTION,
          LLM_TOOL,
          FINAL_RESPONSE
        ],
        stop_action: FINAL_RESPONSE,
        max_iterations: 5
      }
    }
  ]
};
