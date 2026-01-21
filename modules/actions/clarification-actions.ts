/**
 * Clarification actions - handles user clarification flow
 *
 * USER_CLARIFICATION: Generates options, ranks by confidence, returns special type for UI
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

// =============================================================================
// Constants
// =============================================================================

export const USER_CLARIFICATION = 'USER_CLARIFICATION';

// Complexity to timeout mapping (milliseconds)
const TIMEOUT_MAP: Record<string, number> = {
  low: 8000,
  medium: 15000,
  high: 25000
};

// =============================================================================
// Types
// =============================================================================

interface InputQuestion {
  question: string;
  complexity: 'low' | 'medium' | 'high';
}

interface RankedOption {
  label: string;
  value: string;
  confidence: number;
  reasoning: string;
}

interface ProcessedQuestion {
  question: string;
  options: RankedOption[];
  complexity: 'low' | 'medium' | 'high';
  timeout_ms: number;
}

export interface ClarificationResult {
  type: 'user_clarification';
  questions: ProcessedQuestion[];
  default_answers: string[];
  ui_config: {
    pause_on_focus: boolean;
    idle_resume_ms: number;
    show_confidence_hints: boolean;
  };
  [key: string]: unknown;
}

// =============================================================================
// Schemas
// =============================================================================

const GENERATED_QUESTION_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    question_index: { type: 'number', description: 'Index of the question (0-based)' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Display text for the option' },
          value: { type: 'string', description: 'Value to return when selected (snake_case)' },
          confidence: { type: 'number', description: 'Confidence score 0-100' },
          reasoning: { type: 'string', description: 'Brief explanation (under 15 words)' }
        },
        required: ['label', 'value', 'confidence', 'reasoning']
      },
      description: 'Generated options ranked by confidence (highest first)'
    }
  },
  required: ['question_index', 'options']
};

const GENERATION_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    generated: {
      type: 'array',
      items: GENERATED_QUESTION_SCHEMA,
      description: 'Each question with generated options ranked by confidence'
    }
  },
  required: ['generated']
};

const CLARIFICATION_INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question text' },
          complexity: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'low: yes/no, simple choice (8s). medium: 3-4 options (15s). high: open-ended (25s)'
          }
        },
        required: ['question', 'complexity']
      },
      description: 'Questions to present to user'
    },
    context: {
      type: 'string',
      description: 'Why clarification is needed'
    },
    original_goal: {
      type: 'string',
      description: 'Initial user request for context'
    }
  },
  required: ['questions'],
  additionalProperties: false
};

// =============================================================================
// Prompts
// =============================================================================

const GENERATION_SYSTEM_PROMPT = `You generate answer options for questions and rank them by predicted user preference.

# Task
For each question, generate realistic answer options and rank by likelihood the user would choose them.

# Option Generation

MUST:
- Generate exactly 3 options per question (no more, no less)
- Include common/expected answers first
- Make options mutually exclusive when possible
- Use snake_case for values

SHOULD:
- Derive options from page content and conversation context
- Include "skip" or "cancel" for optional questions
- For yes/no questions, consider which is safer default

NEVER:
- Generate vague options like "other" or "something else"
- Duplicate options with different wording

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
    {label: "JSON", value: "json", confidence: 82, reasoning: "Web APIs typically use JSON"},
    {label: "CSV", value: "csv", confidence: 18, reasoning: "Less common for APIs"}
  ]

Question: "Which product interests you?"
Context: User asked for budget headphones under $150, page shows Sony $199, Bose $149, AirPods $179
→ options: [
    {label: "Bose earbuds ($149)", value: "bose_earbuds", confidence: 75, reasoning: "Only option under $150 budget"},
    {label: "Apple AirPods ($179)", value: "apple_airpods", confidence: 15, reasoning: "Slightly over budget"},
    {label: "Sony headphones ($199)", value: "sony_headphones", confidence: 10, reasoning: "Most over budget"}
  ]

Question: "Should I proceed with deletion?"
Context: No explicit preference
→ options: [
    {label: "No, cancel", value: "no", confidence: 55, reasoning: "Safer default for destructive action"},
    {label: "Yes, delete", value: "yes", confidence: 45, reasoning: "User initiated the action"}
  ]`;

// =============================================================================
// Step Handlers
// =============================================================================

/**
 * Format questions for the LLM generation step
 */
function formatQuestionsForGeneration(ctx: StepContext): StepResult {
  const questions = ctx.questions as InputQuestion[] || [];

  const questions_formatted = questions.map((q, i) =>
    `Question ${i} [${q.complexity}]: ${q.question}`
  ).join('\n');

  return { result: { questions_formatted } };
}

interface GeneratedQuestionOutput {
  question_index: number;
  options: RankedOption[];
}

/**
 * Build final clarification result from generated options
 */
function buildClarificationResult(ctx: StepContext): StepResult<ClarificationResult> {
  const inputQuestions = ctx.questions as InputQuestion[] || [];
  const generated = (ctx as Record<string, unknown>).generated as GeneratedQuestionOutput[] || [];

  // Create a map for quick lookup
  const generatedMap = new Map(generated.map(gq => [gq.question_index, gq.options]));

  const processedQuestions: ProcessedQuestion[] = inputQuestions.map((q, i) => {
    const options = generatedMap.get(i) || [];

    return {
      question: q.question,
      options,
      complexity: q.complexity,
      timeout_ms: TIMEOUT_MAP[q.complexity] || TIMEOUT_MAP.medium
    };
  });

  // Default answers are first (highest confidence) option of each question
  const defaultAnswers = processedQuestions.map(q => q.options[0]?.value || '');

  // Show confidence hints if we have generated options
  const hasOptions = generated.length > 0;

  const result: ClarificationResult = {
    type: 'user_clarification',
    questions: processedQuestions,
    default_answers: defaultAnswers,
    ui_config: {
      pause_on_focus: true,
      idle_resume_ms: 5000,
      show_confidence_hints: hasOptions
    }
  };

  return { result };
}

// =============================================================================
// Action
// =============================================================================

export const userClarificationAction: Action = {
  name: USER_CLARIFICATION,
  description: 'Request user clarification with intelligent defaults. Generates options from context, ranks by predicted preference, shows overlay UI with countdown timer, and auto-selects best guess on timeout.',
  examples: [
    'Ask user which format they prefer',
    'Get user confirmation before proceeding with important action',
    'Clarify ambiguous request'
  ],
  input_schema: CLARIFICATION_INPUT_SCHEMA,
  steps: [
    {
      type: 'function',
      handler: formatQuestionsForGeneration
    },
    {
      type: 'llm',
      system_prompt: GENERATION_SYSTEM_PROMPT,
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
{{{questions_formatted}}}

Generate realistic options for each question and rank by confidence.`,
      intelligence: 'LOW',
      output_schema: GENERATION_OUTPUT_SCHEMA
    },
    {
      type: 'function',
      handler: buildClarificationResult
    }
  ]
};

// =============================================================================
// Exports
// =============================================================================

export const clarificationActions: Action[] = [
  userClarificationAction
];
