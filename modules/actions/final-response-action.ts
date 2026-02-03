/**
 * Final response action - terminates the task with a user-facing answer
 *
 * Short-circuit optimization: If the last tool result already answers the query,
 * returns it directly (1 LLM call). Otherwise, generates extraction prompt and
 * extracts/summarizes (2 LLM calls).
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

const DECISION_SYSTEM_PROMPT = `You decide: return answer directly OR generate extraction prompt.

# Critical Rule
PREFER final_answer when possible - avoids unnecessary LLM call.

# Decision Matrix

| Condition | Action |
|-----------|--------|
| Last result answers query completely | final_answer |
| Information is user-ready, no formatting needed | final_answer |
| Simple factual answer found | final_answer |
| Error occurred, need to report it | final_answer |
| Answer scattered across multiple results | extraction_prompt |
| Raw data needs prose conversion | extraction_prompt |
| Complex summarization required | extraction_prompt |

# Output Format

Return exactly ONE of:

## Option 1: Direct Answer
{
  "final_answer": "<complete answer for user>",
  "method": "<1-2 sentence summary of steps taken>"
}

## Option 2: Need Extraction
{
  "extraction_prompt": "<system prompt for extraction LLM>"
}

# Examples

Query: "What's the weather in Paris?"
Last result: {"temp": "22°C", "condition": "sunny", "city": "Paris"}
→ final_answer: "The weather in Paris is 22°C and sunny."
   method: "Retrieved weather data from API."

Query: "Find the cheapest laptop"
Results: [3 pages of product listings as JSON]
→ extraction_prompt: "Extract laptop names and prices. Return the cheapest option with name, price, and link. Format as: 'The cheapest is [name] at [price]. [link]'"

Query: "Summarize this article"
Results: [2000 words of article text]
→ extraction_prompt: "Summarize key points in 3-5 bullet points. Focus on main arguments and conclusions. Under 100 words."

Query: "Click the login button" (action completed)
Last result: {"success": true, "clicked": "Login"}
→ final_answer: "Clicked the login button."
   method: "Located and clicked login button on page."

Query: "Find email" (error occurred)
Last result: {"error": "Element not found"}
→ final_answer: "Could not find an email field on this page."
   method: "Searched page but no email input was found."

Query: "List the main features"
Last result: {"features": ["Dark mode", "Export to PDF", "Real-time sync", "Offline support"]}
→ final_answer: "Main features:\n- Dark mode\n- Export to PDF\n- Real-time sync\n- Offline support"
   method: "Retrieved feature list from product page."

Query: "Show me how to install"
Last result: {"install_command": "npm install example-pkg"}
→ final_answer: "To install:\n\`\`\`bash\nnpm install example-pkg\n\`\`\`"
   method: "Found installation instructions."

# Formatting Rules
MUST: Use markdown when content benefits from structure:
  - Lists (3+ items) → bullet points or numbered lists
  - Code/commands → fenced code blocks with language
  - Comparisons → tables
  - Steps/instructions → numbered lists
  - Key terms → **bold** for emphasis

SHOULD: Keep plain text for:
  - Simple factual answers ("The price is $29.99")
  - Single values or short phrases
  - Error messages

# Output Rules
MUST: Include method field with final_answer
MUST: Keep final_answer concise and user-friendly
SHOULD: Prefer final_answer for simple responses
NEVER: Return both final_answer and extraction_prompt`;

const DECISION_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    final_answer: {
      type: 'string',
      description: 'Direct answer if last tool result already answers the query (empty string if using extraction_prompt)'
    },
    method: {
      type: 'string',
      description: 'Brief description of steps taken (empty string if using extraction_prompt)'
    },
    extraction_prompt: {
      type: 'string',
      description: 'System prompt for extraction if analysis is needed (empty string if using final_answer)'
    }
  },
  required: ['final_answer', 'method', 'extraction_prompt'],
  additionalProperties: false
};

const FINAL_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    final_answer: {
      type: 'string',
      description: 'The complete, polished answer to present to the user'
    },
    method: {
      type: 'string',
      description: 'Brief description of steps taken to gather this data'
    }
  },
  required: ['final_answer', 'method'],
  additionalProperties: false
};

export const FINAL_RESPONSE_ACTION: Action = {
  name: 'FINAL_RESPONSE',
  description: `MANDATORY FINAL STEP.

This tool MUST be called once sufficient information has been obtained
from previous tool calls. It produces the final user-facing answer.

Rules:
- This tool TERMINATES the task.
- After calling FINAL_RESPONSE, no other tools may be called.
- Do NOT call this tool until the objective is fully achieved.
- If the answer can be given to the user, this tool MUST be used.

Purpose:
- Format and present the final result to the user
- Remove internal reasoning and intermediate steps
- Convert tool outputs into a clean, user-readable response`,
  tool_doc: {
    use_when: [
      'Task objective is fully achieved',
      'Requested information has been gathered',
      'Progress is blocked (e.g., login required)',
      'Same error occurs twice'
    ],
    must: ['Use to terminate the task'],
    never: ['Call before objective is achieved'],
    examples: [
      'Give me the final answer',
      'Provide the result to the user',
      'Return the completed response',
      'Deliver the outcome',
      'The task is complete — show the result',
      'Same error has occurred twice, so instead of retrying, use FINAL_RESPONSE to finish the task'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      justification: {
        type: 'string',
        description: 'Why the task objective is now complete and ready to be delivered'
      }
    },
    required: ['justification'],
    additionalProperties: false
  },
  steps: [
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => ({
        result: {
          messages_history: JSON.stringify(
            (ctx.parent_messages ?? []).filter(m => m.role !== 'system'),
            null,
            2
          )
        }
      })
    },
    {
      type: 'llm',
      system_prompt: DECISION_SYSTEM_PROMPT,
      message: `Decide: final_answer (preferred) or extraction_prompt.

<messages>
{{{messages_history}}}
</messages>

If last result answers the query → final_answer + method, extraction_prompt = "".
If synthesis/formatting needed → extraction_prompt only, final_answer = "", method = "".
Prefer final_answer to avoid extra LLM call.`,
      intelligence: 'LOW',
      output_schema: DECISION_OUTPUT_SCHEMA
    },
    {
      type: 'llm',
      skip_if: (ctx: StepContext) => !!ctx.final_answer,
      system_prompt: '{{{extraction_prompt}}}',
      message: `Extract and format information for the user.

<messages>
{{{messages_history}}}
</messages>

Formatting:
- Use markdown when helpful: bullet lists, numbered steps, \`code\`, **bold**, tables
- Keep plain text for simple answers

Return:
- final_answer: Clean, user-friendly response (no JSON, no internal details)
- method: 1-2 sentence summary of steps taken`,
      intelligence: 'MEDIUM',
      output_schema: FINAL_OUTPUT_SCHEMA
    }
  ]
};
