/**
 * Context Selector Action - Intelligently filters context for tool execution
 *
 * Single LLM call that extracts and combines only the relevant parts
 * of available context for a given tool's execution.
 */
import type { Action, JSONSchema } from './types/index.js';

// =============================================================================
// Schemas
// =============================================================================

const OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    context: {
      type: 'string',
      description: 'Combined relevant context to append to the tool, or empty string if no context needed'
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of what was included/excluded (1-2 sentences)'
    }
  },
  required: ['context', 'reasoning'],
  additionalProperties: false
};

// =============================================================================
// Prompts
// =============================================================================

const SYSTEM_PROMPT = `You extract and combine relevant context for a task. Return a single context block containing only what the task needs.

# Context Sources

| Source | Contains | Extract When |
|--------|----------|--------------|
| datetime | Date, time, day of week | Time-sensitive tasks, scheduling, "today"/"now" references |
| browser | Tabs with URLs, summaries, tab IDs | Browser interactions, page-specific actions, navigation |
| preferences | User style, habits, saved settings | Personalized responses, user-specific choices |

# Extraction Rules

MUST:
- Extract ONLY parts relevant to the specific task
- For browser: include tab ID + URL + summary for relevant tabs, omit unrelated tabs entirely
- For preferences: extract only preferences that affect this task
- Combine extracted parts into a single coherent context block

SHOULD:
- Include datetime if task involves any time reference
- Include active tab details for browser-related tasks
- Err toward including if uncertain (missing context is worse than extra)

NEVER:
- Include full context dumps - be selective
- Include tabs unrelated to the task (e.g., music tab for a shopping task)
- Include preferences irrelevant to the task (e.g., food preferences for a code task)

# Output Format

Return a single context block. If nothing is relevant, return empty string "".

# Examples

## Task: "Click the login button"
Context output: "Tab 5 (active): https://example.com/home - Homepage with login button in header"
Reasoning: Only active tab needed for clicking. No time or preference relevance.

## Task: "Explain how React hooks work"
Context output: "User prefers concise technical explanations with code examples."
Reasoning: Communication style preference relevant. No browser or time context needed.

## Task: "Draft email about tomorrow's meeting"
Context output: "Current: Wednesday, January 15, 2025, 3:45 PM\n\nUser prefers professional tone in emails."
Reasoning: Datetime for "tomorrow" reference. Writing style from preferences. No browser needed.

## Task: "Compare the two products I'm looking at"
Context output: "Tab 3 (active): https://amazon.com/product/A - Laptop A: $999\nTab 7: https://amazon.com/product/B - Laptop B: $1299\n\nUser prioritizes value over premium features."
Reasoning: Both product tabs relevant. Purchase preference relevant. Datetime not needed.

## Task: "Calculate 15% tip on $45"
Context output: ""
Reasoning: No context needed for simple calculation.`;

// =============================================================================
// Action
// =============================================================================

export const CONTEXT_SELECTOR_ACTION: Action = {
  name: 'CONTEXT_SELECTOR',
  description: 'Extracts and combines relevant context for tool execution, filtering out unneeded information.',
  examples: [
    'Select context for a browser action',
    'Filter context for an LLM knowledge query',
    'Determine relevant context for form filling'
  ],
  input_schema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The goal to select context for'
      }
    },
    required: ['goal'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'llm',
      system_prompt: SYSTEM_PROMPT,
      message: `Extract relevant context for this task.

Task: {{{goal}}}

Available context to select from:

<datetime>
{{{current_datetime}}}
</datetime>

<browser_tabs>
{{{browser_state}}}
</browser_tabs>

<user_preferences>
{{{user_preferences}}}
</user_preferences>

Return a single combined context block with only the relevant parts, or empty string if nothing is relevant.`,
      intelligence: 'MEDIUM',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};

