/**
 * Router action (Tier-1) - High-level intent routing
 * Decides between browser actions vs direct chat response
 * Keeps prompt minimal - detailed browser info only shown if needed
 */

import { BROWSER_ACTION } from './browser-actions.js';
import { CHAT_RESPONSE } from './chat-action.js';

/**
 * Action name constant
 */
export const BROWSER_ROUTER = 'BROWSER_ROUTER';

/**
 * Tier-1 system prompt - uses {{available_tools}} injected by executor
 */
const TIER1_SYSTEM_PROMPT = `You are a browser automation assistant. Execute the user's request by calling the appropriate tool.

**Decision Guide:**
{{decision_guide}}

IMPORTANT: Always call a tool.`;

/**
 * BROWSER_ROUTER action (Tier-1)
 * Routes between browser actions and direct chat responses
 */
export const routerAction = {
  name: BROWSER_ROUTER,
  description: 'Top-level router that decides whether a user request needs browser interaction or can be answered directly. Routes to BROWSER_ACTION for page reading, clicking, form filling, navigation, or CHAT_RESPONSE for conversational replies.',
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
  output_schema: {
    type: 'object',
    properties: {
      response: { type: 'string' },
      success: { type: 'boolean' }
    },
    additionalProperties: false
  },
  steps: [
    {
      // Tier-1 LLM choice: BROWSER_ACTION or CHAT_RESPONSE
      llm: {
        system_prompt: TIER1_SYSTEM_PROMPT,
        message: `{{user_message}}`,
        intelligence: 'MEDIUM'
      },
      choice: {
        available_actions: [
          BROWSER_ACTION,
          CHAT_RESPONSE
        ],
        stop_action: CHAT_RESPONSE
      }
    }
  ]
};
