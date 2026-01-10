/**
 * Router action - main entry point for orchestration
 * Uses LLM to select and chain actions based on user intent
 */

import { getBrowserState } from '../browser-state.js';
import {
  ACTION_READ_PAGE,
  ACTION_CLICK_ELEMENT,
  ACTION_FILL_FORM,
  ACTION_SELECT_OPTION,
  ACTION_CHECK_CHECKBOX,
  ACTION_SUBMIT_FORM,
  ACTION_NAVIGATE_TO,
  ACTION_SCROLL_TO,
  ACTION_WAIT_FOR_LOAD,
  ACTION_WAIT_FOR_ELEMENT,
  ACTION_GO_BACK,
  ACTION_GO_FORWARD
} from './browser-actions.js';
import { CHAT_RESPONSE } from './chat-action.js';

/**
 * Action name constant
 */
export const BROWSER_ROUTER = 'BROWSER_ROUTER';

/**
 * BROWSER_ROUTER action
 * Main orchestration action that uses LLM to select appropriate browser actions
 * This action implements multi-turn agentic workflow
 */
export const routerAction = {
  name: BROWSER_ROUTER,
  description: 'Routes user requests to appropriate browser actions using LLM reasoning',
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
    async (context) => {
      const browserState = getBrowserState();

      // Ensure tab is registered (will fetch URL if not provided)
      if (context.tabId) {
        return await browserState.ensureTabRegistered(context.tabId, context.page_url);
      }

      return { page_url: context.page_url || 'unknown' };
    },
    {
      // LLMConfig with multi-turn choice
      system_prompt: `You are an intelligent browser automation assistant. You help users interact with web pages by selecting and executing appropriate actions.

**Your capabilities:**

1. **READ_PAGE**: Extract and analyze page content (text, links, buttons, forms)
   - Use when: User wants to know what's on the page, find information, or understand page structure
   - Provides: Full page content for analysis

2. **CLICK_ELEMENT**: Click buttons, links, or interactive elements
   - Use when: User wants to click something, submit, navigate via link
   - Requires: CSS selector for the element (like "#button-id" or ".class-name")

3. **FILL_FORM**: Fill multiple form fields with values
   - Use when: User wants to enter data into forms
   - Requires: Array of {selector, value} pairs for each field

4. **SELECT_OPTION**: Select options from dropdown menus
   - Use when: User needs to pick from a dropdown
   - Requires: Selector for the select element and option value/text

5. **CHECK_CHECKBOX**: Check or uncheck checkboxes
   - Use when: User needs to toggle checkboxes
   - Requires: Selector and whether to check/uncheck

6. **SUBMIT_FORM**: Submit a form
   - Use when: Form is filled and needs to be submitted
   - Requires: Selector for submit button or form

7. **NAVIGATE_TO**: Navigate to a different URL
   - Use when: User wants to visit a specific website or URL
   - Requires: Valid URL (include https://)

8. **SCROLL_TO**: Scroll the page up, down, to top, or to bottom
   - Use when: User wants to scroll or content needs loading
   - Requires: Direction (up/down/top/bottom) and optional pixel amount

9. **WAIT_FOR_LOAD**: Wait for page to finish loading
   - Use when: Page is loading and you need to wait before proceeding
   - Use after navigation or clicking

10. **WAIT_FOR_ELEMENT**: Wait for a specific element to appear
    - Use when: Content loads dynamically and you need to wait for it
    - Requires: CSS selector for the element

11. **GO_BACK** / **GO_FORWARD**: Browser history navigation
    - Use when: User wants to go back/forward in browser history

12. **CHAT_RESPONSE**: Generate final response to user [STOP ACTION]
    - Use when: Task is complete, you need to respond, or have enough information
    - This ends the action loop

**How to use these actions:**

- **Start by understanding intent**: If unclear what's on the page, READ_PAGE first
- **Chain actions intelligently**: Example workflow:
  1. READ_PAGE to find login form
  2. FILL_FORM with credentials
  3. SUBMIT_FORM or CLICK_ELEMENT on submit button
  4. WAIT_FOR_LOAD for result
  5. CHAT_RESPONSE to confirm success

- **Be specific with selectors**: When you need CSS selectors:
  - Use specific IDs when available: "#login-button"
  - Use classes: ".submit-btn"
  - Use attribute selectors: "[type='submit']"
  - Combine: "form.login input[type='email']"

- **Think step-by-step**: Break complex tasks into atomic actions
- **Verify before proceeding**: If page content is unknown, READ_PAGE first
- **End with CHAT_RESPONSE**: Always finish by responding to the user

**Current context:**
- User request: {{user_message}}
- Page URL: {{page_url}}
- Browser state is available in each message, showing all tabs, URL history, and page content

Choose actions wisely. When the task is complete or you have information to share, use CHAT_RESPONSE.`,

      message: `{{user_message}}

Current page: {{page_url}}

What action should you take? Think step-by-step about what information you need and what actions to perform.`,

      intelligence: 'MEDIUM',

      choice: {
        available_actions: [
          ACTION_READ_PAGE,
          ACTION_CLICK_ELEMENT,
          ACTION_FILL_FORM,
          ACTION_SELECT_OPTION,
          ACTION_CHECK_CHECKBOX,
          ACTION_SUBMIT_FORM,
          ACTION_NAVIGATE_TO,
          ACTION_SCROLL_TO,
          ACTION_WAIT_FOR_LOAD,
          ACTION_WAIT_FOR_ELEMENT,
          ACTION_GO_BACK,
          ACTION_GO_FORWARD,
          CHAT_RESPONSE
        ],
        stop_action: CHAT_RESPONSE,
        max_iterations: 7
      }
    }
  ]
};
