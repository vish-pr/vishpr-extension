/**
 * Chat action - the stop action that generates final responses
 */

import { generate } from '../llm.js';
import { getBrowserStateBundle } from '../browser-state.js';

/**
 * Action name constant
 */
export const CHAT_RESPONSE = 'CHAT_RESPONSE';

/**
 * CHAT_RESPONSE action
 * Generates a natural language response to the user based on accumulated context
 * This is the "stop action" that ends the agentic loop
 */
export const chatAction = {
  name: CHAT_RESPONSE,
  description: 'Generate a natural language response to the user. Use this when the task is complete or you need to communicate with the user.',
  input_schema: {
    type: 'object',
    properties: {
      user_message: {
        type: 'string',
        description: 'Original user message'
      },
      justification: {
        type: 'string',
        description: 'Why responding now (e.g., task complete, need clarification, error occurred)'
      },
      page_content: {
        type: 'string',
        description: 'Page content if extracted (can be any type)',
      },
      page_url: {
        type: 'string',
        description: 'Current page URL'
      },
      note: {
        type: 'string',
        description: 'Any additional notes or context'
      }
    },
    required: ['user_message', 'page_content'],
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
    async (context) => {
      // Get browser state
      const { formatted: browserStateFormatted, json: browserStateJSON } = getBrowserStateBundle();

      // Build a summary of actions taken
      const actionsSummary = buildActionsSummary(context);

      // Build system prompt for response generation with browser state
      const systemPrompt = `You are a helpful browser automation assistant. The user asked you to perform a task, and you've completed some actions.

Your job is to:
1. Summarize what you did
2. Present any relevant information you found
3. Indicate if the task was completed successfully or if there were issues
4. Be concise but informative

Context available to you:
- Original user request: ${context.user_message}
- Current page URL: ${context.page_url || 'unknown'}
- Actions performed: ${actionsSummary}
${context.note ? `- Note: ${context.note}` : ''}

Browser State:
${browserStateFormatted}

If page content was extracted, include relevant excerpts in your response.
If you clicked something or filled a form, confirm what you did.
If navigation occurred, mention where you went.
Be natural and conversational.`;

      // Build user prompt with context
      let userPrompt = `Generate a response for the user.\n\nOriginal request: "${context.user_message}"`;

      if (context.page_content) {
        userPrompt += `\n\nPage content summary:`;
        userPrompt += `\n- Title: ${context.page_content.title}`;
        if (context.page_content.text) {
          userPrompt += `\n- Text preview: ${context.page_content.text.substring(0, 500)}...`;
        }
        if (context.page_content.links?.length) {
          userPrompt += `\n- Links found: ${context.page_content.links.length}`;
        }
        if (context.page_content.buttons?.length) {
          userPrompt += `\n- Interactive buttons: ${context.page_content.buttons.length}`;
        }
      }

      if (context.clicked) {
        userPrompt += `\n\nAction performed: Clicked element with selector "${context.selector}"`;
      }

      if (context.filled_fields) {
        userPrompt += `\n\nAction performed: Filled ${context.filled_fields} form fields`;
        if (context.submitted) {
          userPrompt += ` and submitted the form`;
        }
      }

      if (context.navigated) {
        userPrompt += `\n\nAction performed: Navigated to ${context.new_url || 'new page'}`;
      }

      if (context.scrolled) {
        userPrompt += `\n\nAction performed: Scrolled page (${context.scrolled_pixels} pixels)`;
      }

      // Generate response using LLM
      const result = await generate({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        intelligence: 'MEDIUM',
        schema: {
          type: 'object',
          properties: {
            response: {
              type: 'string',
              description: 'Natural language response to the user'
            },
            success: {
              type: 'boolean',
              description: 'Whether the task was completed successfully'
            }
          },
          required: ['response', 'success'],
          additionalProperties: false
        }
      });

      // Add browser state to the result
      return {
        ...result,
        browser_state: browserStateJSON
      };
    }
  ]
};

/**
 * Helper to build a summary of actions taken
 * @param {Object} context - Execution context
 * @returns {string} Summary of actions
 */
function buildActionsSummary(context) {
  const actions = [];

  if (context.page_content) {
    actions.push('read page content');
  }
  if (context.clicked) {
    actions.push('clicked element');
  }
  if (context.filled_fields) {
    actions.push(`filled ${context.filled_fields} form fields`);
  }
  if (context.submitted) {
    actions.push('submitted form');
  }
  if (context.navigated) {
    actions.push('navigated to new URL');
  }
  if (context.scrolled) {
    actions.push('scrolled page');
  }
  if (context.selected) {
    actions.push('selected dropdown option');
  }

  return actions.length > 0 ? actions.join(', ') : 'no actions yet';
}
