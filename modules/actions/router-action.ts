/**
 * Router action (Tier-1) - High-level intent routing
 * Decides between browser actions vs direct chat response
 */
import type { Action } from './types/index.js';
import { BROWSER_ACTION } from './browser-actions.js';
import { FINAL_RESPONSE } from './final-response-action.js';
import { LLM_TOOL } from './llm-action.js';
import { USER_CLARIFICATION } from './clarification-actions.js';
import { CRITIQUE } from './critique-action.js';
import { PREFERENCE_EXTRACTOR } from './preference-extractor-action.js';
import { fetchBrowserState, fetchCurrentDateTime } from './context-steps.js';

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
    { type: 'function', handler: fetchBrowserState },
    { type: 'function', handler: fetchCurrentDateTime },
    {
      type: 'llm',
      system_prompt: `You route user requests to appropriate tools.
Current time: {{{current_datetime}}}

# Critical Rules
MUST: Select ONE tool per turn. Never skip tool selection.
MUST: Use FINAL_RESPONSE when objective is complete - do not over-iterate.
NEVER: Loop more than 3 times on the same action without progress.

# Tools

## BROWSER_ACTION
Web page interaction: read content, click, type, navigate, scroll.
Use when: Task requires current web data or page interaction.

## LLM_TOOL
General knowledge, reasoning, analysis, planning.
Use when: No browser interaction needed; question answerable from knowledge.

## USER_CLARIFICATION
Ask user for input when context unclear or choice needed.
Use when: Request is ambiguous, multiple valid options exist, or confirmation needed.

## FINAL_RESPONSE
Present result and terminate task.
Use when: Objective achieved OR sufficient information gathered OR error loop detected.

# Decision Rules

MUST use BROWSER_ACTION for:
- Reading current page content or finding elements
- Clicking, filling forms, navigating to URLs
- Any task requiring live/current web data

MUST use LLM_TOOL for:
- General knowledge questions ("What is X?", "Explain Y")
- Analysis, reasoning, or planning tasks
- Code generation or problem-solving

MUST use USER_CLARIFICATION when:
- Request lacks necessary specifics (budget, preferences, constraints)
- Multiple valid interpretations exist
- Destructive or irreversible action needs confirmation

MUST use FINAL_RESPONSE when:
- Task objective is fully achieved
- Information requested has been gathered
- Same error occurred 2+ times (report issue, don't retry)

SHOULD:
- Break complex tasks into single atomic steps
- Gather information before concluding
- Prefer clarification over assumption

NEVER:
- Use LLM_TOOL when current web data is needed
- Use BROWSER_ACTION for general knowledge questions
- Continue iterating after objective is met

# Examples

Query: "Search for cheap flights to Tokyo"
→ BROWSER_ACTION (needs live web data)

Query: "What is the capital of France?"
→ LLM_TOOL (general knowledge, no browser needed)

Query: "Find me a laptop"
→ USER_CLARIFICATION (needs budget, specs, brand preferences)

Query: "Book this flight" (after showing options)
→ USER_CLARIFICATION (confirm before purchase)

Query: "The price is $99" (after successful lookup)
→ FINAL_RESPONSE (objective achieved)

Query: "Page won't load" (after 2 failed attempts)
→ FINAL_RESPONSE (report error, stop retrying)

# Error Handling
- If action fails, try ONE alternative approach
- If same error occurs twice, use FINAL_RESPONSE to report issue
- Never loop indefinitely on errors

{{{decisionGuide}}}

# Reminder
Select exactly ONE tool. Use FINAL_RESPONSE when done or stuck.`,
      message: `Route this request.

Browser: {{{browser_state}}}
Goal: {{{user_message}}}

Select ONE tool. Use {{{stop_action}}} when objective complete or after 2 failed attempts.`,
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
  ],
  post_steps: [
    { type: 'action', action: CRITIQUE },
    { type: 'action', action: PREFERENCE_EXTRACTOR }
  ]
};
