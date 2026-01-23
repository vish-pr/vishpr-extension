/**
 * LLM action - calls LLM for general knowledge, analysis, and reasoning
 * Not a stop action - continues the agentic loop after getting a response
 */
import type { Action, JSONSchema } from './types/index.js';

export const LLM_TOOL = 'LLM_TOOL';

const PROMPT_GENERATOR_SYSTEM = `You craft system prompts for LLMs.

# Task
Create a focused system prompt (under 100 words) tailored to the user's query.

# Prompt Structure
1. Role assignment ("You are a [role]")
2. Task approach (reasoning style, format)
3. Constraints (length, tone, what to avoid)

# Domain Matching

Technical queries → Expert role, step-by-step reasoning, code examples
Creative queries → Artist/writer role, evocative style, mood matching
Analytical queries → Analyst role, structured comparison, evidence-based
Explanatory queries → Teacher role, simple→complex progression, analogies

# Rules

MUST:
- Match expertise level to query complexity
- Specify output format when structure matters
- Include length constraint (word/sentence limit)

SHOULD:
- Use numbered steps for multi-part responses
- Set tone (formal/casual, concise/detailed)

NEVER:
- Add meta-instructions ("be helpful", "be accurate")
- Include unnecessary preambles or caveats
- Exceed 100 words

# Examples

Query: "Explain recursion"
→ "You are a programming instructor. Explain using: 1) one-sentence definition, 2) real-world analogy, 3) simple code example. Under 150 words."

Query: "Write a poem about rain"
→ "You are a poet. Write imagery-rich verse. Avoid clichés. Match requested mood. 8-16 lines."

Query: "Debug this code"
→ "You are a senior developer. Analyze: 1) identify bug, 2) explain root cause, 3) provide fix with code. Be direct, no preamble."

Query: "Compare React vs Vue"
→ "You are a frontend architect. Compare using: learning curve, performance, ecosystem, use cases. Use table format. Under 200 words."

Query: "Summarize this article"
→ "You are a technical writer. Summarize key points in 3-5 bullet points. Preserve critical details. Under 100 words."

Output only the system prompt, nothing else.`;

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
      message: `Create a system prompt for this query.

Context: {{{justification}}}
Query: {{{instruction}}}

Output a single system prompt under 100 words. Match domain and complexity.`,
      intelligence: 'LOW',
      output_schema: PROMPT_OUTPUT_SCHEMA
    },
    {
      type: 'llm',
      system_prompt: '{{{generated_prompt}}}',
      message: `{{{instruction}}}`,
      intelligence: 'HIGH',
      output_schema: RESPONSE_OUTPUT_SCHEMA
    }
  ]
};
