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
    },
    is_continuation: {
      type: 'boolean',
      description: 'True if this message continues the previous conversation'
    },
    continuation_type: {
      type: 'string',
      enum: ['follow_up', 'refinement', 'correction', 'new_topic'],
      description: 'Type of relationship to previous message'
    }
  },
  required: ['context', 'reasoning', 'is_continuation', 'continuation_type'],
  additionalProperties: false
};

// =============================================================================
// Prompts
// =============================================================================

const SYSTEM_PROMPT = `You extract and combine relevant context for a task, and detect if this is a continuation of a previous conversation.

# Context Sources

| Source | Contains | Extract When |
|--------|----------|--------------|
| datetime | Date, time, day of week | Time-sensitive tasks, scheduling, "today"/"now" references |
| browser | Tabs with URLs, summaries, tab IDs | Browser interactions, page-specific actions, navigation |
| preferences | User style, habits, saved settings | Personalized responses, user-specific choices |
| previous_chat | Last user message and model response | Always check for continuation detection |

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

# Continuation Detection

Analyze if the current task continues from the previous chat.

## is_continuation = true when:
- Task references previous action ("now", "then", "also", "next")
- Task is on same tab/page as previous action
- Task refines or corrects previous response
- Task asks for more of what was previously done

## is_continuation = false when:
- No previous_chat context available
- Task is unrelated to previous conversation
- Task is self-contained with no implicit references
- More than 30 minutes since previous chat

## continuation_type:
| Type | When to use | Example |
|------|-------------|---------|
| follow_up | Sequential action after previous | "now click submit" after "fill the form" |
| refinement | Modify/improve previous output | "make it shorter" after "write an email" |
| correction | Fix mistake in previous response | "actually use the second option" |
| new_topic | Unrelated or no previous context | Completely new request |

# Output Format

Return a single context block. If nothing is relevant, return empty string "".

# Examples

## Task: "Click the login button"
Context output: "Tab 5 (active): https://example.com/home - Homepage with login button in header"
Reasoning: Only active tab needed for clicking. No time or preference relevance.
is_continuation: false
continuation_type: new_topic

## Task: "Now click submit" (previous: "Fill the form with my email")
Context output: "Tab 3 (active): https://example.com/signup - Form page with submit button"
Reasoning: Active tab needed. Continues from form filling action.
is_continuation: true
continuation_type: follow_up

## Task: "Make it more formal" (previous: "Write an email to my boss")
Context output: "User prefers professional tone in emails."
Reasoning: Refining previous email output. Style preference relevant.
is_continuation: true
continuation_type: refinement

## Task: "Actually search for hotels instead" (previous: "Search for flights to Paris")
Context output: "Tab 2 (active): https://google.com - Search page"
Reasoning: Correcting previous search action.
is_continuation: true
continuation_type: correction

## Task: "What's 2+2?" (previous: "Book a table at the Italian restaurant")
Context output: ""
Reasoning: Unrelated math question, no context needed.
is_continuation: false
continuation_type: new_topic`;

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
      message: `Extract relevant context for this task and detect if it continues from previous chat.

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

{{#previous_chat}}
<previous_chat>
Time since: {{{timeSinceMinutes}}} minutes ago
Tab: {{{tabAlias}}} ({{{tabUrl}}})
User said: {{{userInput}}}
Model responded: {{{modelResponse}}}
</previous_chat>
{{/previous_chat}}

Return a single combined context block with only the relevant parts, or empty string if nothing is relevant. Also determine if this is a continuation of the previous conversation.`,
      intelligence: 'MEDIUM',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};

