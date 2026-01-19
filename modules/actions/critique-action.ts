/**
 * Critique action - analyzes execution traces for improvements
 * Single LLM call that evaluates prompts, efficiency, and errors
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';
import { summarize } from '../summarize.js';

export const CRITIQUE = 'CRITIQUE';

const ISSUE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    location: { type: 'string', description: 'Where in trace, e.g. "BROWSER_ROUTER > Step 1 > system_prompt"' },
    problem: { type: 'string', description: 'What is wrong' },
    suggestion: { type: 'string', description: 'How to improve' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] }
  },
  required: ['location', 'problem', 'suggestion', 'severity'],
  additionalProperties: false
};

const ISSUES_OBJECT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    issues: { type: 'array', items: ISSUE_SCHEMA }
  },
  required: ['issues'],
  additionalProperties: false
};

const OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '1-2 sentence overview of the execution quality' },
    prompts: ISSUES_OBJECT_SCHEMA,
    efficiency: ISSUES_OBJECT_SCHEMA,
    errors: ISSUES_OBJECT_SCHEMA,
    topRecommendations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Top 3 prioritized improvements'
    }
  },
  required: ['summary', 'prompts', 'efficiency', 'errors', 'topRecommendations'],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are an expert at analyzing LLM-powered action execution traces.

Analyze the provided trace and identify improvements in three areas:

1. **Prompts**: Evaluate system prompts and messages for:
   - Clarity and specificity
   - Missing context that caused confusion
   - Overly verbose or redundant instructions
   - Ambiguous instructions that led to wrong actions

2. **Efficiency**: Look for:
   - Unnecessary LLM calls or iterations
   - Actions that could have been combined
   - Redundant data gathering
   - Suboptimal action selection

3. **Errors**: Analyze warnings and failures:
   - Root cause of failures
   - Whether errors were recoverable
   - Missing error handling
   - Patterns that lead to failures

Be specific - reference exact locations in the trace (action names, step numbers, turn numbers).
Be actionable - every issue should have a concrete suggestion.
Be prioritized - mark severity based on impact (low/medium/high).

If an area has no issues, return an empty array for that section.`;

interface CritiqueContext extends StepContext {
  trace: unknown;
}

export const critiqueAction: Action = {
  name: CRITIQUE,
  description: 'Analyzes execution traces for improvements in prompts, efficiency, and error handling',
  input_schema: {
    type: 'object',
    properties: {
      trace: {
        type: 'object',
        description: 'The execution trace to analyze'
      }
    },
    required: ['trace'],
    additionalProperties: false
  },

  steps: [
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const trace = (ctx as CritiqueContext).trace;
        const summarized = summarize(trace, {
          maxStringLength: 1000,
          maxArrayLength: 20,
          maxObjectKeys: 15,
          maxDepth: 8,
        });
        return {
          result: {
            traceJson: JSON.stringify(summarized, null, 2)
          }
        };
      }
    },
    {
      type: 'llm',
      system_prompt: SYSTEM_PROMPT,
      message: `Analyze this execution trace:\n\n{{{traceJson}}}`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};
