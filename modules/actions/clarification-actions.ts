/**
 * USER_CLARIFICATION action
 *
 * Generates options for a clarification question, returns special type for UI handling.
 * Executor shows modal, user picks option or times out, response injected back.
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

export const USER_CLARIFICATION = 'USER_CLARIFICATION';

// Input/output types
interface Question {
  question: string;
  complexity: 'low' | 'medium' | 'high';
}

interface Option {
  label: string;
  confidence: number;
  reasoning: string;
}

export interface ClarificationResult {
  type: 'user_clarification';
  questions: Question[];
  generated: Array<{
    question_index: number;
    options: Option[];
  }>;
  [key: string]: unknown;
}

// Schemas
const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          complexity: { type: 'string', enum: ['low', 'medium', 'high'] }
        },
        required: ['question', 'complexity']
      }
    },
    context: { type: 'string' },
    original_goal: { type: 'string' }
  },
  required: ['questions']
};

const OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    generated: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question_index: { type: 'number' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                confidence: { type: 'number' },
                reasoning: { type: 'string' }
              },
              required: ['label', 'confidence', 'reasoning']
            }
          }
        },
        required: ['question_index', 'options']
      }
    }
  },
  required: ['generated']
};

const SYSTEM_PROMPT = `You generate answer options for questions and rank them by predicted user preference.

# Task
For each question, generate realistic answer options and rank by likelihood the user would choose them.

# Option Generation

MUST:
- Generate exactly 3 options per question (no more, no less)
- Include common/expected answers first
- Make options mutually exclusive when possible
- Keep labels concise but descriptive

SHOULD:
- Derive options from page content and conversation context
- For yes/no questions, consider which is safer default

NEVER:
- Generate meta-options like "skip", "cancel", "other", "something else", "enter manually", "custom input" - the UI provides skip and manual input separately
- Duplicate options with different wording
- Generate options that defer the question rather than answer it

# Confidence Scoring (0-100)

MUST consider:
- Explicit preferences stated in conversation
- Current page content/URL indicating user intent
- Task goal and what would best achieve it
- Common patterns for this type of question

SHOULD consider:
- Implicit preferences in phrasing (formal/casual, technical/simple)
- Previous choices in conversation if available
- Domain conventions (e.g., developers prefer JSON, users prefer cheaper options)

Scoring:
- 80-100: Strong explicit signal (user said "I prefer X")
- 60-79: Clear implicit signal (context strongly suggests X)
- 40-59: Moderate signal (some evidence points to X)
- 20-39: Weak signal (slight preference or common default)
- 0-19: No signal (random guess)

# Rules

MUST:
- Return ALL generated options, ranked by confidence descending
- Keep reasoning under 15 words
- Ensure confidence scores reflect actual evidence

NEVER:
- Return equal confidence for all options
- Make up evidence not in context
- Score above 70 without clear contextual support

# Examples

Question: "What format do you want?"
Context: User is building a web API
→ options: [
    {label: "JSON", confidence: 82, reasoning: "Web APIs typically use JSON"},
    {label: "XML", confidence: 12, reasoning: "Legacy format, less common"},
    {label: "CSV", confidence: 6, reasoning: "Rarely used for APIs"}
  ]

Question: "Which product interests you?"
Context: User asked for budget headphones under $150, page shows Sony $199, Bose $149, AirPods $179
→ options: [
    {label: "Bose earbuds ($149)", confidence: 75, reasoning: "Only option under $150 budget"},
    {label: "Apple AirPods ($179)", confidence: 15, reasoning: "Slightly over budget"},
    {label: "Sony headphones ($199)", confidence: 10, reasoning: "Most over budget"}
  ]

Question: "Should I proceed with deletion?"
Context: User asked to clean up temp files, 3 files selected
→ options: [
    {label: "Yes, delete them", confidence: 60, reasoning: "User explicitly requested cleanup"},
    {label: "No, keep them", confidence: 30, reasoning: "Safer to confirm first"},
    {label: "Delete only oldest", confidence: 10, reasoning: "Partial cleanup option"}
  ]`;

function buildResult(ctx: StepContext): StepResult<ClarificationResult> {
  return {
    result: {
      type: 'user_clarification',
      questions: (ctx.questions as Question[]) || [],
      generated: ((ctx as Record<string, unknown>).generated as ClarificationResult['generated']) || []
    }
  };
}

// Action definition
export const userClarificationAction: Action = {
  name: USER_CLARIFICATION,
  description: 'Request user clarification with intelligent defaults. Generates options from context, ranks by predicted preference, shows overlay UI with countdown timer, and auto-selects best guess on timeout.',
  examples: [
    'Ask user which format they prefer',
    'Get user confirmation before proceeding with important action',
    'Clarify ambiguous request'
  ],
  input_schema: INPUT_SCHEMA,
  steps: [
    {
      type: 'llm',
      system_prompt: SYSTEM_PROMPT,
      message: `Generate and rank options for each question.

{{#original_goal}}
User's goal: {{{original_goal}}}
{{/original_goal}}

{{#browser_state}}
Current page: {{{browser_state}}}
{{/browser_state}}

{{#context}}
Context: {{{context}}}
{{/context}}

Questions:
{{#questions}}
- [{{complexity}}] {{question}}
{{/questions}}

Generate realistic options for each question and rank by confidence.`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    },
    { type: 'function', handler: buildResult }
  ]
};

export const clarificationActions: Action[] = [userClarificationAction];
