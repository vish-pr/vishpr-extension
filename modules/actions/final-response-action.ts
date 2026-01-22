/**
 * Final response action - terminates the task with a user-facing answer
 *
 * Short-circuit optimization: If the last tool result already answers the query,
 * returns it directly (1 LLM call). Otherwise, generates extraction prompt and
 * extracts/summarizes (2 LLM calls).
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

export const FINAL_RESPONSE = 'FINAL_RESPONSE';

const DECISION_SYSTEM_PROMPT = `You decide: return answer directly OR generate extraction prompt.

# Decision Rules

MUST return final_answer when:
- Last tool result answers the query completely
- Information is user-ready (no reformatting needed)

MUST return extraction_prompt when:
- Answer scattered across multiple results
- Raw data needs conversion to prose
- Information needs summarization

# Output Format
Return ONE of:
- { "final_answer": "<answer>", "method": "<steps>" }
- { "extraction_prompt": "<system prompt>" }

# Examples

Query: "What's the weather in Paris?"
Last result: "22°C and sunny in Paris"
→ final_answer: "The weather in Paris is 22°C and sunny"

Query: "Compare prices across sites"
Results: [raw JSON from 3 sites]
→ extraction_prompt: "Extract prices from each site, format as comparison table"

PREFER final_answer to avoid unnecessary processing.`;

const DECISION_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    final_answer: {
      type: 'string',
      description: 'Direct answer if last tool result already answers the query'
    },
    method: {
      type: 'string',
      description: 'Brief description of steps taken (required with final_answer)'
    },
    extraction_prompt: {
      type: 'string',
      description: 'System prompt for extraction if analysis is needed'
    }
  },
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

export const finalResponseAction: Action = {
  name: FINAL_RESPONSE,
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
  examples: [
    'Give me the final answer',
    'Provide the result to the user',
    'Return the completed response',
    'Deliver the outcome',
    'The task is complete — show the result',
    'Same error has occurred twice, so instead of retrying, use FINAL_RESPONSE to finish the task'

  ],
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
      message: `Decide: return final_answer directly OR return extraction_prompt.

<messages>
{{{messages_history}}}
</messages>

Return final_answer if last result answers the query. Return extraction_prompt if synthesis needed.`,
      intelligence: 'LOW',
      output_schema: DECISION_OUTPUT_SCHEMA
    },
    {
      type: 'llm',
      skip_if: (ctx: StepContext) => !!ctx.final_answer,
      system_prompt: '{{{extraction_prompt}}}',
      message: `Extract and summarize information for the user.

<messages>
{{{messages_history}}}
</messages>

Provide: final_answer (clean, user-friendly summary) and method (brief steps taken).`,
      intelligence: 'MEDIUM',
      output_schema: FINAL_OUTPUT_SCHEMA
    }
  ]
};
