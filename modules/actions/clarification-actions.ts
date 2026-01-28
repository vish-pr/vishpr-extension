/**
 * USER_CLARIFICATION action
 *
 * Shows clarification UI with loading state, generates options via LLM,
 * updates UI with options, waits for user response or timeout.
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

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
  const generated = (ctx as Record<string, unknown>).generated as Array<{
    question_index: number;
    options: Option[];
  }>;

  let user_responses: UserResponse[] = [];
  if (pendingResponsePromise) {
    await updateOptionsUI({ type: 'user_clarification', questions, generated });
    user_responses = await pendingResponsePromise;
    pendingResponsePromise = null;
  }

  return {
    result: {
      answers: user_responses.map(r => {
        // Find the selected option to get its preference_source
        const questionGen = generated?.find(g => g.question_index === r.question_index);
        const selectedOption = questionGen?.options?.find(opt => opt.label === r.value);

        // Pass through preference_source directly (already text strings)
        const preferenceFacts = selectedOption?.preference_source || [];

        return {
          value: r.value,
          is_default: r.timed_out,
          preference_facts_used: preferenceFacts
        };
      })
    }
  };
}

// Input/output types
interface Question {
  question: string;
  complexity: 'low' | 'medium' | 'high';
}

interface Option {
  label: string;
  confidence: number;
  reasoning: string;
  preference_source?: string[];  // Quoted fact texts from KB that informed this option
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
  preference_facts_used?: string[];  // Facts from KB that informed the selected option
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
                reasoning: { type: 'string' },
                preference_source: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Quoted fact texts from KB that informed this option confidence'
                }
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

# Preference Tracking
When scoring confidence based on user_preferences KB:
MUST: Include the quoted preference text in preference_source array
Example:
  KB: "User prefers fast delivery. User uses Firefox."
  Option: {label: "Express", confidence: 88, reasoning: "User prefers fast delivery", preference_source: ["User prefers fast delivery"]}

If option is NOT based on a KB preference, omit preference_source or use empty array.

# Examples

Question: "What format do you want?"
Context: User building a web API
→ [
    {label: "JSON", confidence: 78, reasoning: "Web APIs use JSON by convention", preference_fact_indices: []},
    {label: "XML", confidence: 14, reasoning: "Legacy format, less common", preference_fact_indices: []},
    {label: "CSV", confidence: 8, reasoning: "Rarely used for APIs", preference_fact_indices: []}
  ]

Question: "Which product?"
Context: User wants headphones under $150. Page: Sony $199, Bose $149, AirPods $179
→ [
    {label: "Bose ($149)", confidence: 85, reasoning: "Only option within $150 budget", preference_fact_indices: []},
    {label: "AirPods ($179)", confidence: 10, reasoning: "$29 over budget", preference_fact_indices: []},
    {label: "Sony ($199)", confidence: 5, reasoning: "$49 over budget", preference_fact_indices: []}
  ]

Question: "Delete these files?"
Context: User asked to clean temp files, 3 selected
→ [
    {label: "Yes, delete all 3", confidence: 65, reasoning: "User requested cleanup", preference_fact_indices: []},
    {label: "No, keep them", confidence: 25, reasoning: "Deletion is irreversible", preference_fact_indices: []},
    {label: "Delete oldest only", confidence: 10, reasoning: "Partial compromise", preference_fact_indices: []}
  ]

Question: "Which shipping speed?"
Context: User preferences KB: "User prefers fast delivery."
→ [
    {label: "Express (2-day)", confidence: 88, reasoning: "User prefers fast delivery", preference_source: ["User prefers fast delivery"]},
    {label: "Standard (5-7 day)", confidence: 8, reasoning: "Cheaper but slower", preference_source: []},
    {label: "Economy (10+ day)", confidence: 4, reasoning: "Conflicts with preference", preference_source: []}
  ]

# Output Requirements
- Return exactly 3 options per question
- Order by confidence descending
- Keep reasoning under 15 words
- Scores must sum to roughly 100 (±10)
- Include preference_source array with quoted fact text when option is based on KB preferences`;

// Action definition
export const USER_CLARIFICATION_ACTION: Action = {
  name: 'USER_CLARIFICATION',
  description: 'Request user clarification with intelligent defaults. Generates options from context, ranks by predicted preference, shows overlay UI with countdown timer, and auto-selects best guess on timeout.',
  examples: [
    'Ask user which format they prefer',
    'Get user confirmation before proceeding with important action',
    'Clarify ambiguous request'
  ],
  input_schema: INPUT_SCHEMA,
  steps: [
    { type: 'function', handler: showLoadingUIStep },
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

