/**
 * Chat action - the stop action that generates final responses
 * Note: Browser state is injected by the executor, not here
 */

import { generate } from '../llm.js';

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
      tabId: {
        type: 'number',
        description: 'Tab ID to get page content from'
      },
      justification: {
        type: 'string',
        description: 'Why responding now (e.g., task complete, need clarification, error occurred)'
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
    async (params, prevResult, browser) => {
      // Browser state is passed in by executor
      const page_content = browser?.json?.tabs?.[params.tabId]?.content || params.page_content;

      // Build a summary of actions taken
      const actionsSummary = buildActionsSummary(params);

      // Build system prompt for response generation
      const systemPrompt = `You are a helpful browser automation assistant. The user asked you to perform a task, and you've completed some actions.

Your job is to:
1. Summarize what you did
2. Present any relevant information you found
3. Indicate if the task was completed successfully or if there were issues
4. Be concise but informative

Context available to you:
- Original user request: ${params.user_message}
- Current page URL: ${params.page_url || 'unknown'}
- Actions performed: ${actionsSummary}
${params.note ? `- Note: ${params.note}` : ''}

If page content was extracted, include relevant excerpts in your response.
If you clicked something or filled a form, confirm what you did.
If navigation occurred, mention where you went.
Be natural and conversational.`;

      // Build user prompt
      let userPrompt = `Generate a response for the user.\n\nOriginal request: "${params.user_message}"`;

      if (page_content) {
        userPrompt += `\n\nPage content summary:`;
        userPrompt += `\n- Title: ${page_content.title}`;
        if (page_content.text) {
          userPrompt += `\n- Text preview: ${page_content.text.substring(0, 500)}...`;
        }
        if (page_content.links?.length) {
          userPrompt += `\n- Links found: ${page_content.links.length}`;
        }
        if (page_content.buttons?.length) {
          userPrompt += `\n- Interactive buttons: ${page_content.buttons.length}`;
        }
      }

      if (params.justification) {
        userPrompt += `\n\nReason for responding: ${params.justification}`;
      }

      // Note: Browser state is injected as second-to-last message by executor
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

      return result;
    }
  ]
};

/**
 * Helper to build a summary of actions taken
 * @param {Object} params - Input params
 * @returns {string} Summary of actions
 */
function buildActionsSummary(params) {
  // Use justification as summary since we no longer accumulate action results
  return params.justification || 'responding to user';
}
