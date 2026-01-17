/**
 * LLM action - calls LLM for general knowledge, analysis, and reasoning
 * Not a stop action - continues the agentic loop after getting a response
 */
import type { Action, JSONSchema } from './types/index.js';

export const LLM_TOOL = 'LLM_TOOL';

const PROMPT_GENERATOR_SYSTEM = `You are an expert at crafting system prompts that guide large language models to produce accurate, helpful, and relevant responses.

Your task is to create a tailored system prompt based on the user's specific intent. Consider:
1. What knowledge domain is required (technical, creative, analytical, etc.)
2. What reasoning approach would be most effective (step-by-step, comparative, deductive, etc.)
3. What perspective or tone is appropriate (expert, teacher, neutral, etc.)
4. What constraints or guidelines should be emphasized

The system prompt you create will be used by a high-intelligence LLM to address the user's query directly.`;

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
      message: `Create a system prompt for answering the user's query. This system prompt will be given to an LLM to generate a response.

Justification for using LLM tool: {{{justification}}}
User's instruction: {{{instruction}}}

Generate a clear, focused system prompt that will guide the LLM to provide the best possible response.`,
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
