/**
 * Router action (Tier-1) - High-level intent routing
 * Decides between browser actions vs direct chat response
 */
import type { Action } from './types/index.js';
import { BROWSER_ACTION_ROUTER } from './browser-actions.js';
import { FINAL_RESPONSE_ACTION } from './final-response-action.js';
import { LLM_ACTION } from './llm-action.js';
import { USER_CLARIFICATION_ACTION } from './clarification-actions.js';
import { CRITIQUE_ACTION } from './critique-action.js';
import { PREFERENCE_EXTRACTOR_ACTION } from './preference-extractor-action.js';
import { CONTEXT_SELECTOR_ACTION } from './context-selector-action.js';

/**
 * ROUTER_ACTION (Tier-1)
 * Routes between browser actions and direct chat responses
 */
export const ROUTER_ACTION: Action = {
  name: 'ROUTER',
  description: 'Route user requests to browser interaction, general knowledge, or final response',
  input_schema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The goal to accomplish'
      }
    },
    required: ['goal'],
    additionalProperties: true
  },
  steps: [
    // Step 1: Select relevant context
    {
      type: 'action',
      action: CONTEXT_SELECTOR_ACTION.name
    },
    // Step 2: Route with filtered context
    {
      type: 'llm',
      system_prompt: `You route user requests to appropriate tools.

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

Context:
{{{context}}}

Goal: {{{goal}}}

Select ONE tool. Use {{{stop_action}}} when objective complete or after 2 failed attempts.`,
      continuation_message: `Previous action completed. Review the result above. Note user does not see this message, they only see output of {{{stop_action}}}.


Original Goal was: {{{goal}}}

Decision:
- If the goal is FULLY satisfied by the previous result or all information is collected to slove user query → use {{{stop_action}}}
- Else select the MOST APPROPRIATE tool to continue progress towards the goal.
- If you encountered an error in the previous action, try ONE alternative approach.
- If you encounter the SAME error AGAIN, use {{{stop_action}}} to report the issue.`,
      intelligence: 'HIGH',
      tool_choice: {
        available_actions: [
          USER_CLARIFICATION_ACTION.name,
          BROWSER_ACTION_ROUTER.name,
          LLM_ACTION.name,
          FINAL_RESPONSE_ACTION.name
        ],
        stop_action: FINAL_RESPONSE_ACTION.name,
        max_iterations: 5
      }
    }
  ],
  post_steps: [
    { type: 'action', action: CRITIQUE_ACTION.name },
    { type: 'action', action: PREFERENCE_EXTRACTOR_ACTION.name }
  ]
};
