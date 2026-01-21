/**
 * Router action (Tier-1) - High-level intent routing
 * Decides between browser actions vs direct chat response
 */
import type { Action } from './types/index.js';
import { BROWSER_ACTION } from './browser-actions.js';
import { FINAL_RESPONSE } from './final-response-action.js';
import { LLM_TOOL } from './llm-action.js';
import { USER_CLARIFICATION } from './clarification-actions.js';

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
      system_prompt: `You route user requests to appropriate tools.
Current time: {{{current_datetime}}}

# Tools
- BROWSER_ACTION: Web page interaction (read, click, type, navigate)
- LLM_TOOL: General knowledge, reasoning (no browser needed)
- USER_CLARIFICATION: Ask user for input when context is unclear or choice needed
- FINAL_RESPONSE: Task complete, present result

# Rules
MUST use BROWSER_ACTION for:
- Reading page content, clicking elements, filling forms
- Any task requiring current web data

MUST use LLM_TOOL for:
- General knowledge questions
- Analysis or reasoning tasks
- Planning without web interaction

MUST use USER_CLARIFICATION when:
- User request is ambiguous or lacks necessary context
- Multiple valid options exist and user preference matters
- Confirmation needed before important actions

MUST use FINAL_RESPONSE when:
- Task objective is achieved
- Sufficient information gathered

SHOULD:
- Break complex tasks into single steps
- Gather information before concluding
- Ask for clarification rather than assume

# Examples
"Search for X" → BROWSER_ACTION (needs web)
"What is X?" → LLM_TOOL (general knowledge)
"Find me a laptop" → USER_CLARIFICATION (needs budget, specs preference)
"I found the price is $99" → FINAL_RESPONSE (task done)

{{{decisionGuide}}}`,
      message: `Route this request to the appropriate tool.

Browser state: {{{browser_state}}}
User goal: {{{user_message}}}

Select the best tool. Use {{{stop_action}}} when objective is complete.`,
      intelligence: 'MEDIUM',
      tool_choice: {
        available_actions: [
          BROWSER_ACTION,
          LLM_TOOL,
          USER_CLARIFICATION,
          FINAL_RESPONSE
        ],
        stop_action: FINAL_RESPONSE,
        max_iterations: 5
      }
    }
  ]
};
