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

# Critical Rules
MUST: Reference exact locations (e.g., "BROWSER_ROUTER > Step 2 > system_prompt")
MUST: Provide actionable suggestions, not vague advice
MUST: Return empty arrays for areas with no issues

# Severity Definitions

| Severity | Meaning | Examples |
|----------|---------|----------|
| high | Task blocked or failed | Wrong tool selected, infinite loop, unrecoverable error |
| medium | Task degraded but completed | Extra LLM calls, suboptimal path, partial results |
| low | Minor inefficiency | Verbose prompt, unnecessary field, style issue |

# Analysis Areas

## 1. Prompts
Look for:
- Vague instructions causing wrong actions ("handle this" → "click submit button")
- Missing context that forced guessing
- Contradictory rules
- Overly verbose instructions (could be 50% shorter)
- Missing examples for complex decisions

## 2. Efficiency
Look for:
- Unnecessary LLM calls (could skip or combine)
- Redundant READ_PAGE calls without state change
- Same action retried without modification
- Data gathered but never used
- Could have short-circuited earlier

## 3. Errors
Look for:
- Root cause of failures (not just symptoms)
- Missing error handling paths
- Recoverable errors treated as fatal
- Error loops (same failure repeated)
- Cascading failures from single issue

# Examples

## Prompt Issue
{
  "location": "ROUTER > Step 1 > system_prompt",
  "problem": "Vague 'handle the request' caused LLM_TOOL selection when BROWSER_ACTION needed",
  "suggestion": "Add rule: 'If task requires current web data, MUST use BROWSER_ACTION'",
  "severity": "high"
}

## Efficiency Issue
{
  "location": "BROWSER_ROUTER > Steps 3-5",
  "problem": "Three consecutive READ_PAGE calls with no actions between them",
  "suggestion": "Cache page state; only READ_PAGE after navigation or interaction",
  "severity": "medium"
}

## Error Issue
{
  "location": "BROWSER_ROUTER > Step 4 > CLICK_ELEMENT",
  "problem": "Element not found error repeated 3 times with same selector",
  "suggestion": "After 2 failures, READ_PAGE to refresh element IDs or report error",
  "severity": "high"
}

# Output Requirements
- Top 3 recommendations should be highest-impact, most actionable items
- Summary should be 1-2 sentences assessing overall execution quality
- Empty arrays for categories with no issues found`;

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
        const trace = ctx.trace;
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
      message: `Analyze this execution trace.

<trace>
{{{traceJson}}}
</trace>

For each issue found:
1. Exact location (action > step > field)
2. Specific problem (what went wrong)
3. Concrete suggestion (how to fix)
4. Severity (high/medium/low)

Return empty arrays for categories with no issues.`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};
