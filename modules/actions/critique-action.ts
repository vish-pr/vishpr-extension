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

const SYSTEM_PROMPT = `You analyze LLM action execution traces for improvements.

# Analysis Areas

## 1. Prompts
- Clarity and specificity
- Missing context causing confusion
- Verbose or redundant instructions
- Ambiguous instructions causing wrong actions

## 2. Efficiency
- Unnecessary LLM calls or iterations
- Actions that could be combined
- Redundant data gathering
- Suboptimal action selection

## 3. Errors
- Root cause of failures
- Recoverability of errors
- Missing error handling
- Failure patterns

# Requirements
MUST:
- Reference exact locations (e.g., "BROWSER_ROUTER > Step 2 > system_prompt")
- Provide concrete suggestions for each issue
- Rate severity: high (blocked task), medium (degraded quality), low (minor)

SHOULD:
- Prioritize high-impact issues first
- Identify patterns across multiple issues

# Example Issue
{
  "location": "ROUTER > Step 1 > message",
  "problem": "Vague instruction 'handle the request' caused wrong tool selection",
  "suggestion": "Specify criteria: 'If URL present, use BROWSER_ACTION'",
  "severity": "high"
}

Return empty arrays for areas with no issues.`;

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
      message: `Analyze this execution trace for improvements.

<trace>
{{{traceJson}}}
</trace>

Identify issues in prompts, efficiency, and errors. Provide actionable suggestions.`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};
