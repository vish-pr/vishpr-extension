/**
 * USER_CLARIFICATION action
 *
 * Shows clarification UI with loading state, generates options via LLM,
 * updates UI with options, waits for user response or timeout.
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';
import { fetchBrowserState, fetchUserPreferences } from './context-steps.js';

declare const chrome: {
  runtime: {
    sendMessage: (msg: unknown) => Promise<void>;
    onMessage: {
      addListener: (fn: (msg: { action: string; responses?: unknown[] }) => void) => void;
      removeListener: (fn: (msg: { action: string; responses?: unknown[] }) => void) => void;
    };
  };
};

// Module-level state for pending response promise
let pendingResponsePromise: Promise<UserResponse[]> | null = null;

interface UserResponse {
  value: string;
  timed_out: boolean;
  question_index: number;
}

// Context-aware UI helpers (handle both document and service worker contexts)
async function showLoadingUI(questions: Question[]): Promise<UserResponse[]> {
  if (typeof document !== 'undefined') {
    const ui = await import('../clarification-ui.js');
    ui.showClarificationLoading(questions);
    return ui.getClarificationResponse();
  }

  // Service worker context - send message to sidepanel
  return new Promise((resolve) => {
    const handleResponse = (message: { action: string; responses?: unknown[] }) => {
      if (message.action === 'clarificationResponse') {
        chrome.runtime.onMessage.removeListener(handleResponse);
        resolve((message.responses as UserResponse[]) || []);
      }
    };
    chrome.runtime.onMessage.addListener(handleResponse);

    chrome.runtime.sendMessage({
      action: 'showClarificationLoading',
      questions
    }).catch(() => {
      chrome.runtime.onMessage.removeListener(handleResponse);
      resolve(questions.map((_, i) => ({ value: '', timed_out: true, question_index: i })));
    });
  });
}

async function updateOptionsUI(config: ClarificationUIConfig): Promise<void> {
  if (typeof document !== 'undefined') {
    const { updateClarificationOptions } = await import('../clarification-ui.js');
    updateClarificationOptions(config);
  } else {
    chrome.runtime.sendMessage({ action: 'updateClarificationOptions', config }).catch(() => {});
  }
}

// Step 1: Show loading UI immediately
async function showLoadingUIStep(ctx: StepContext): Promise<StepResult> {
  const questions = ctx.questions as Question[];
  if (questions?.length > 0) {
    pendingResponsePromise = showLoadingUI(questions);
  }
  return { result: {} };
}

// Step 3: Wait for user response and build final result
async function waitForResponseStep(ctx: StepContext): Promise<StepResult> {
  const questions = ctx.questions as Question[];
  const generated = (ctx as Record<string, unknown>).generated as ClarificationUIConfig['generated'];

  let user_responses: UserResponse[] = [];
  if (pendingResponsePromise) {
    await updateOptionsUI({ type: 'user_clarification', questions, generated });
    user_responses = await pendingResponsePromise;
    pendingResponsePromise = null;
  }

  return {
    result: {
      answers: user_responses.map(r => ({
        value: r.value,
        is_default: r.timed_out
      }))
    }
  };
}

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

// Internal config for UI update (not the final result)
interface ClarificationUIConfig {
  type: 'user_clarification';
  questions: Question[];
  generated: Array<{
    question_index: number;
    options: Option[];
  }>;
}

export interface ClarificationAnswer {
  value: string;
  is_default: boolean;  // true if auto-selected due to timeout
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

const SYSTEM_PROMPT = `You generate answer options for questions and rank by predicted user preference.

# Critical Rules
MUST: Generate exactly 3 options per question.
MUST: Rank options by confidence descending.
NEVER: Generate meta-options (skip, cancel, other, custom, something else) - UI provides these.

# Option Generation

MUST:
- Generate exactly 3 concrete answer options
- Make options mutually exclusive
- Keep labels concise (2-6 words)
- Derive options from page content and context

SHOULD:
- Put most likely answer first
- For yes/no questions, consider safer default

NEVER:
- Generate "skip", "cancel", "other", "custom input", "something else", "enter manually"
- Duplicate options with different wording
- Generate options that defer rather than answer ("let me think", "ask again later")

# Confidence Scoring (0-100)

## Evidence Strength → Score Range
| Evidence Type | Score Range |
|---------------|-------------|
| User preferences KB says "I prefer X" | 80-100 |
| User stated preference in conversation | 70-90 |
| Page content/URL strongly indicates X | 60-79 |
| Task goal suggests X is best path | 50-69 |
| Domain convention favors X | 40-59 |
| Common default, weak signal | 20-39 |
| No evidence, random guess | 0-19 |

## Scoring Rules
MUST: Base scores on actual evidence in context
MUST: Differentiate scores (no equal confidence for all)
NEVER: Score above 70 without explicit evidence
NEVER: Invent evidence not present in context

# Examples

Question: "What format do you want?"
Context: User building a web API
→ [
    {label: "JSON", confidence: 78, reasoning: "Web APIs use JSON by convention"},
    {label: "XML", confidence: 14, reasoning: "Legacy format, less common"},
    {label: "CSV", confidence: 8, reasoning: "Rarely used for APIs"}
  ]

Question: "Which product?"
Context: User wants headphones under $150. Page: Sony $199, Bose $149, AirPods $179
→ [
    {label: "Bose ($149)", confidence: 85, reasoning: "Only option within $150 budget"},
    {label: "AirPods ($179)", confidence: 10, reasoning: "$29 over budget"},
    {label: "Sony ($199)", confidence: 5, reasoning: "$49 over budget"}
  ]

Question: "Delete these files?"
Context: User asked to clean temp files, 3 selected
→ [
    {label: "Yes, delete all 3", confidence: 65, reasoning: "User requested cleanup"},
    {label: "No, keep them", confidence: 25, reasoning: "Deletion is irreversible"},
    {label: "Delete oldest only", confidence: 10, reasoning: "Partial compromise"}
  ]

Question: "Which shipping speed?"
Context: User preferences KB says "prefers fast delivery"
→ [
    {label: "Express (2-day)", confidence: 88, reasoning: "User prefers fast delivery"},
    {label: "Standard (5-7 day)", confidence: 8, reasoning: "Cheaper but slower"},
    {label: "Economy (10+ day)", confidence: 4, reasoning: "Conflicts with preference"}
  ]

# Output Requirements
- Return exactly 3 options per question
- Order by confidence descending
- Keep reasoning under 15 words
- Scores must sum to roughly 100 (±10)`;

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
    { type: 'function', handler: showLoadingUIStep },
    { type: 'function', handler: fetchBrowserState },
    { type: 'function', handler: fetchUserPreferences },
    {
      type: 'llm',
      system_prompt: SYSTEM_PROMPT,
      message: `Generate exactly 3 options per question, ranked by confidence.

{{#user_preferences}}
# User Preferences (strongest signal for scoring)
{{{user_preferences}}}
{{/user_preferences}}

{{#original_goal}}
# Goal: {{{original_goal}}}
{{/original_goal}}

{{#browser_state}}
# Current Page: {{{browser_state}}}
{{/browser_state}}

{{#context}}
# Context: {{{context}}}
{{/context}}

# Questions
{{#questions}}
- [{{complexity}}] {{question}}
{{/questions}}

For each question: 3 options, confidence descending, reasoning under 15 words.
NEVER include skip/cancel/other options.`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    },
    { type: 'function', handler: waitForResponseStep }
  ]
};

export const clarificationActions: Action[] = [userClarificationAction];
