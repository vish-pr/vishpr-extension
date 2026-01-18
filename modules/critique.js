/**
 * Critique Module - Analyzes execution traces for improvements
 */

import { generate } from './llm/index.js';
import { updateTrace } from './trace-storage.js';

const CRITIQUE_SYSTEM_PROMPT = `You are an expert at analyzing LLM-powered action execution traces.

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

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '1-2 sentence overview of the execution quality'
    },
    prompts: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'Where in trace, e.g. "BROWSER_ROUTER > Step 1 > system_prompt"' },
              problem: { type: 'string', description: 'What is wrong' },
              suggestion: { type: 'string', description: 'How to improve' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] }
            },
            required: ['location', 'problem', 'suggestion', 'severity'],
            additionalProperties: false
          }
        }
      },
      required: ['issues'],
      additionalProperties: false
    },
    efficiency: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'Where in trace, e.g. "Turn 3/5"' },
              problem: { type: 'string', description: 'What is inefficient' },
              suggestion: { type: 'string', description: 'How to improve' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] }
            },
            required: ['location', 'problem', 'suggestion', 'severity'],
            additionalProperties: false
          }
        }
      },
      required: ['issues'],
      additionalProperties: false
    },
    errors: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'Where in trace, e.g. "CLICK_ELEMENT action"' },
              problem: { type: 'string', description: 'What failed and why' },
              suggestion: { type: 'string', description: 'How to prevent' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] }
            },
            required: ['location', 'problem', 'suggestion', 'severity'],
            additionalProperties: false
          }
        }
      },
      required: ['issues'],
      additionalProperties: false
    },
    topRecommendations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Top 3 prioritized improvements'
    }
  },
  required: ['summary', 'prompts', 'efficiency', 'errors', 'topRecommendations'],
  additionalProperties: false
};

/**
 * Generate critique from trace using LLM
 */
async function generateCritique(trace) {
  const traceJson = JSON.stringify(trace, null, 2);

  const response = await generate({
    messages: [
      { role: 'system', content: CRITIQUE_SYSTEM_PROMPT },
      { role: 'user', content: `Analyze this execution trace:\n\n${traceJson}` }
    ],
    intelligence: 'LOW',
    schema: CRITIQUE_SCHEMA
  });

  return response;
}

/**
 * Generate critique and update the stored trace record
 * This is the main entry point called from background.js
 */
export async function generateAndStoreCritique(runId, trace) {
  const critique = await generateCritique(trace);

  await updateTrace(runId, { critique });

  return critique;
}
