/**
 * Final response action - terminates the task with a user-facing answer
 *
 * Short-circuit optimization: If the last tool result already answers the query,
 * returns it directly (1 LLM call). Otherwise, generates extraction prompt and
 * extracts/summarizes (2 LLM calls).
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

export const FINAL_RESPONSE = 'FINAL_RESPONSE';

const DECISION_SYSTEM_PROMPT = `You decide whether the conversation already contains a complete answer or needs extraction.

# Decision Rules

MUST return final_answer directly when:
- Last tool result already contains a clear, complete answer to the user's query
- Information is already well-formatted and user-ready
- No additional summarization or extraction would add value

MUST return extraction_prompt when:
- Answer is scattered across multiple tool results
- Information needs summarization or reformatting
- Raw data needs to be converted to user-friendly prose

# Output

Return ONE of:
1. { "final_answer": "<answer>", "method": "<steps taken>" } - if answer is ready
2. { "extraction_prompt": "<system prompt for extraction>" } - if extraction needed

# Examples

## Example 1: Direct answer exists
Last tool returned: "The weather in Paris is 22°C and sunny"
User asked: "What's the weather in Paris?"
→ Return final_answer: "The weather in Paris is 22°C and sunny"

## Example 2: Extraction needed
Multiple tools returned raw API data, HTML content, or scattered facts
→ Return extraction_prompt with instructions to synthesize the information

IMPORTANT: Prefer returning final_answer when possible to avoid unnecessary processing.`;

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
    'The task is complete — show the result'
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
          messages_history: Array.isArray(ctx.parent_messages)
            ? JSON.stringify(ctx.parent_messages, null, 2)
            : ctx.parent_messages
        }
      })
    },
    {
      type: 'llm',
      system_prompt: DECISION_SYSTEM_PROMPT,
      message: `Analyze the conversation and decide: return final_answer directly OR return extraction_prompt.

<messages>
{{{messages_history}}}
</messages>

If the last tool result already answers the user's query completely, return:
- final_answer: The answer (use last tool's result if already well-formatted)
- method: Brief description of steps taken

Otherwise, return:
- extraction_prompt: A system prompt for extracting and summarizing the scattered information`,
      intelligence: 'LOW',
      output_schema: DECISION_OUTPUT_SCHEMA
    },
    {
      type: 'llm',
      skip_if: (ctx: StepContext) => !!ctx.final_answer,
      system_prompt: '{{{extraction_prompt}}}',
      message: `Extract and summarize the relevant information. Focus on data that directly addresses the user's intent.

<messages>
{{{messages_history}}}
</messages>

In your response:
1. 'final_answer' field: Provide a clean, user-friendly summary of the relevant information with no redundancy
2. 'method' field: Briefly describe the steps taken to gather this data (2-3 lines for bookkeeping purposes)`,
      intelligence: 'MEDIUM',
      output_schema: FINAL_OUTPUT_SCHEMA
    }
  ]
};
