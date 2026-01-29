/**
 * Router action (Tier-1) - High-level intent routing
 * Decides between browser actions vs direct chat response
 */
import type { Action } from './types/index.js';
import { BROWSER_ACTION_ROUTER } from './browser-actions.js';
import { FINAL_RESPONSE_ACTION } from './final-response-action.js';
import { LLM_ACTION } from './llm-action.js';
import { REQUEST_INPUT_ACTION } from './clarification-actions.js';
import { TRACE_ANALYZER_ACTION } from './trace-analyzer-action.js';
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
      system_prompt: `You are a request router and task executor.
Your job is to route user requests to exactly ONE appropriate tool per turn and complete the objective efficiently.
You can break down complex objectives into multiple steps as needed and use appropriate tool for each step.

You must prefer observing the environment and taking safe actions over asking the user questions.
You sit in a browser environment, use it to perform actions if those action can fulfill user request.
Prefer solving problems over giving information how to solve them back to user.

────────────────────────
CRITICAL RULES
────────────────────────

MUST:
- Select EXACTLY ONE tool per turn
- Always select a tool (never respond without a tool)
- Use FINAL_RESPONSE when the objective is complete or cannot progress further
- Stop after FINAL_RESPONSE

NEVER:
- Select more than one tool in a single turn
- Loop more than 3 times on the same action without progress
- Ask for usernames, passwords, or credentials
- Continue iterating after the objective is achieved

────────────────────────
AUTHENTICATION & ACCESS RULES
────────────────────────

ASSUME:
- Browser sessions may already be authenticated
- It is SAFE to navigate to user-specified websites to check login state
- Checking login state is NOT a destructive action

MUST:
- Attempt browser access before asking the user for clarification
- Use BROWSER_ACTION to determine whether authentication already exists

IF:
- A page requires login AND the user is not authenticated

THEN:
- Use FINAL_RESPONSE to inform the user that sign-in is required
- Ask the user to complete sign-in manually and retry

DO NOT:
- Ask the user for credentials
- Use REQUEST_INPUT to request login details

────────────────────────
TOOLS
────────────────────────
{{{tools_section}}}

────────────────────────
DECISION PRIORITY (IMPORTANT)
────────────────────────

1. Observe using BROWSER_ACTION if observation is possible
2. Act using BROWSER_ACTION if action is safe
3. Ask using REQUEST_INPUT only if observation/action cannot resolve ambiguity
4. Finish with FINAL_RESPONSE

Prefer:
OBSERVE → ACT → ASK → FINISH

Never:
ASK → OBSERVE → ACT

────────────────────────
ERROR HANDLING
────────────────────────

- If an action fails, try ONE alternative approach
- If the same error occurs twice:
  → Use FINAL_RESPONSE to report the issue and stop
- Never retry indefinitely

────────────────────────
EXAMPLES
────────────────────────
{{{examples_section}}}

────────────────────────
REMINDER
────────────────────────

- Select exactly ONE tool
- Prefer observation over questions
- Use FINAL_RESPONSE when done or blocked`,
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
          REQUEST_INPUT_ACTION.name,
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
    { type: 'action', action: TRACE_ANALYZER_ACTION.name }
  ]
};
