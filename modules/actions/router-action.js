/**
 * Router action (Tier-1) - High-level intent routing
 * Decides between browser actions vs direct chat response
 * Keeps prompt minimal - detailed browser info only shown if needed
 */

import { getBrowserState } from '../browser-state.js';
import { BROWSER_ACTION_ROUTER } from './browser-action-router.js';
import { CHAT_RESPONSE } from './chat-action.js';

/**
 * Action name constant
 */
export const BROWSER_ROUTER = 'BROWSER_ROUTER';

/**
 * Simplified tier-1 system prompt
 * Does NOT include detailed browser action info - that's in tier-2
 */
const TIER1_SYSTEM_PROMPT = `You are an assistant that helps users with their requests.

**Available Tools:**

1. **BROWSER_ACTION**: Interact with web pages
   - Use when: User wants to read page content, click elements, fill forms, navigate, scroll, or perform any browser interaction
   - Capabilities: Extract page content, click buttons/links, fill forms, select dropdowns, navigate URLs, scroll pages, wait for elements
   - Choose this if the user's request involves understanding or manipulating what's in the browser

2. **CHAT_RESPONSE**: Respond directly to user [STOP]
   - Use when: You can answer the question without browser interaction
   - Use when: The request is conversational, a clarification, or general knowledge
   - Use when: You need to ask the user for more information

**Decision Guide:**
- "What is this page?" → BROWSER_ACTION (need to read the page)
- "Click the login button" → BROWSER_ACTION (need to interact)
- "Fill in my email" → BROWSER_ACTION (need to fill form)
- "How are you?" → CHAT_RESPONSE (conversational)
- "What can you do?" → CHAT_RESPONSE (general question)

Choose the appropriate tool for the user's request.`;

/**
 * BROWSER_ROUTER action (Tier-1)
 * Routes between browser actions and direct chat responses
 */
export const routerAction = {
  name: BROWSER_ROUTER,
  description: 'Routes user requests - browser actions or direct response',
  input_schema: {
    type: 'object',
    properties: {
      user_message: {
        type: 'string',
        description: 'The user\'s natural language request'
      },
      page_url: {
        type: 'string',
        description: 'Current page URL'
      },
      tabId: {
        type: 'number',
        description: 'Browser tab ID'
      }
    },
    required: ['user_message', 'tabId'],
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
    // Pre-step: Register tab in browser state
    async (params) => {
      const browserState = getBrowserState();
      if (params.tabId) {
        await browserState.ensureTabRegistered(params.tabId, params.page_url);
      }
      return params;
    },
    {
      // Tier-1 LLM choice: BROWSER_ACTION or CHAT_RESPONSE
      llm: {
        system_prompt: TIER1_SYSTEM_PROMPT,
        message: `{{user_message}}

What tool should you use to handle this request?`,
        intelligence: 'MEDIUM'
      },
      choice: {
        available_actions: [
          BROWSER_ACTION_ROUTER,
          CHAT_RESPONSE
        ],
        stop_action: CHAT_RESPONSE,
        max_iterations: 1  // Single decision - no loop at tier-1
      },
      // Flag to use summary browser state (not full details)
      use_browser_summary: true
    }
  ]
};
