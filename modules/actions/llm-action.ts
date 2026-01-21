/**
 * LLM action - calls LLM for general knowledge, analysis, and reasoning
 * Not a stop action - continues the agentic loop after getting a response
 */
import type { Action, JSONSchema } from './types/index.js';

export const LLM_TOOL = 'LLM_TOOL';

const PROMPT_GENERATOR_SYSTEM = `You craft system prompts for LLMs.

# Task
Create a focused system prompt based on user intent.

# Requirements
MUST:
- Match knowledge domain (technical, creative, analytical)
- Specify reasoning approach (step-by-step, comparative, deductive)
- Set appropriate tone (expert, teacher, neutral)

SHOULD:
- Be concise (under 100 words)
- Include format constraints when applicable

NEVER:
- Add unnecessary preambles
- Include meta-instructions about "being helpful"

# Examples

Query: "Explain recursion"
→ "You are a programming instructor. Explain concepts using: 1) simple definition, 2) analogy, 3) code example. Keep explanations under 200 words."

Query: "Write a poem about rain"
→ "You are a poet. Write evocative, imagery-rich verse. Avoid clichés. Match the mood requested."

Query: "Debug this code"
→ "You are a senior developer. Analyze code systematically: 1) identify the bug, 2) explain root cause, 3) provide fix. Be direct."

Output a single system prompt, nothing else.`;

const PROMPT_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    generated_prompt: {
      type: 'string',
      description: 'System prompt for the main LLM call'
    }
  },
  required: ['generated_prompt'],
  additionalProperties: false
};

const RESPONSE_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    response: {
      type: 'string',
      description: 'The response to the user instruction'
    }
  },
  required: ['response'],
  additionalProperties: false
};

/**
 * LLM_TOOL action
 * Calls a large language model for general knowledge, analysis, reasoning, and planning
 * This is NOT a stop action - the loop continues after getting a response
 */
export const llmAction: Action = {
  name: LLM_TOOL,
  description: 'Calls a large language model for general knowledge, analysis, reasoning, and planning. Best for: answering knowledge questions, code generation, problem-solving, strategy development, and tasks requiring general world understanding. Limitations: No access to live/current information, web browsing, or file system.',
  examples: [
    'What is the capital of France?',
    'Explain how async/await works',
    'Help me plan a project structure'
  ],
  input_schema: {
    type: 'object',
    properties: {
      justification: {
        type: 'string',
        description: 'The justification for using the LLM tool'
      },
      instruction: {
        type: 'string',
        description: 'Instructions for what you want to achieve from this tool'
      }
    },
    required: ['justification', 'instruction'],
    additionalProperties: false
  },
  steps: [
    {
      type: 'llm',
      system_prompt: PROMPT_GENERATOR_SYSTEM,
      message: `Create a system prompt for the user's query.

Justification: {{{justification}}}
Query: {{{instruction}}}

Output a focused system prompt for this query.`,
      intelligence: 'LOW',
      output_schema: PROMPT_OUTPUT_SCHEMA
    },
    {
      type: 'llm',
      system_prompt: '{{{generated_prompt}}}',
      message: `Instruction: {{{instruction}}}`,
      intelligence: 'HIGH',
      output_schema: RESPONSE_OUTPUT_SCHEMA
    }
  ]
};
