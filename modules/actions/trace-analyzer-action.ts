/**
 * Trace Analyzer Action - Combined critique and preference extraction
 *
 * Workflow:
 * 1. Preprocess trace and conversation
 * 2. Single LLM call for both critique and preference extraction
 * 3. Prepare KB input
 * 4. Update knowledge base (conditional)
 * 5. Save results to storage
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';
import { summarize } from '../summarize.js';
import { KNOWLEDGE_BASE_ADAPTOR_ACTION } from './knowledge-base-action.js';

// Storage key for user preferences knowledge base
const PREFERENCES_KB_KEY = 'user_preferences_kb';

// =============================================================================
// Schemas
// =============================================================================

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
    critique: {
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
    },
    extracted_preferences: {
      type: 'string',
      description: 'Plain prose summary of user preferences (2-5 sentences), or "No new preferences identified." if none found'
    }
  },
  required: ['critique', 'extracted_preferences'],
  additionalProperties: false
};

// =============================================================================
// System Prompt
// =============================================================================

const SYSTEM_PROMPT = `You analyze execution traces for quality issues and extract user preferences.

# Part 1: Critique

MUST: Reference exact locations (e.g., "BROWSER_ROUTER > Step 2 > system_prompt")
MUST: Return empty arrays for categories with no issues

## Severity

| Level | Meaning | Examples |
|-------|---------|----------|
| high | Task blocked/failed | Wrong tool, infinite loop, unrecoverable error |
| medium | Degraded but completed | Extra LLM calls, suboptimal path |
| low | Minor inefficiency | Verbose prompt, unnecessary field |

## Areas

### Prompts
- Vague instructions causing wrong actions
- Missing context forcing guessing
- Contradictory rules

### Efficiency
- Unnecessary LLM calls
- Redundant READ_PAGE without state change
- Same action retried without modification

### Errors
- Root cause of failures
- Missing error handling
- Error loops

## Example Issue
{
  "location": "ROUTER > Step 1 > system_prompt",
  "problem": "Vague 'handle the request' caused wrong tool selection",
  "suggestion": "Add rule: 'If task requires web data, MUST use BROWSER_ACTION'",
  "severity": "high"
}

# Part 2: Preferences

MUST: Extract ONLY preferences clearly evidenced in conversation
MUST: Write as factual statements ("User prefers X")
NEVER: Invent preferences or treat one-time requests as lasting

## What to Extract

| Category | Look For | Example |
|----------|----------|---------|
| Communication | Formal/casual, verbose/concise | "User prefers concise responses" |
| Technical level | Jargon usage, explanation requests | "User understands technical terms" |
| Content format | Lists vs prose | "User prefers bullet points" |
| Decision style | Quick vs deliberate | "User wants confirmation before purchases" |

## Evidence Rules

| Signal | Action |
|--------|--------|
| Explicit statement ("I prefer X") | Extract |
| Repeated behavior (3+ times) | Extract |
| Single request ("this time") | Do NOT extract |

## Output
2-5 sentences, one preference each. Or: "No new preferences identified."

NEVER extract sensitive data (finances, health, passwords).

# Output Requirements
- critique.summary: 1-2 sentences on execution quality
- critique.topRecommendations: Top 3 prioritized improvements
- extracted_preferences: 2-5 sentences or "No new preferences identified."`;

// =============================================================================
// Types
// =============================================================================

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

interface TraceNode {
  type: string;
  name?: string;
  input?: {
    parent_messages?: ConversationMessage[];
    [key: string]: unknown;
  };
  prompt?: string;
  children?: TraceNode[];
}

// =============================================================================
// Step Handlers
// =============================================================================

/**
 * Extract conversation messages from trace tree
 */
function extractConversationFromTrace(trace: TraceNode): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const seen = new Set<string>();

  function collect(node: TraceNode) {
    // Look for parent_messages in step inputs
    if (node.input?.parent_messages && Array.isArray(node.input.parent_messages)) {
      for (const msg of node.input.parent_messages) {
        // Deduplicate by content hash
        const key = `${msg.role}:${msg.content?.slice(0, 100)}`;
        if (!seen.has(key) && msg.content) {
          seen.add(key);
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // Look for LLM prompts and outputs as conversation
    if (node.type === 'llm' && node.prompt) {
      // Extract user messages from prompt
      const userMatch = node.prompt.match(/\[USER\]: ([\s\S]*?)(?=\[(?:ASSISTANT|SYSTEM|USER)\]:|$)/gi);
      if (userMatch) {
        for (const match of userMatch) {
          const content = match.replace(/^\[USER\]: /i, '').trim();
          const key = `user:${content.slice(0, 100)}`;
          if (!seen.has(key) && content) {
            seen.add(key);
            messages.push({ role: 'user', content });
          }
        }
      }
    }

    // Recurse into children
    for (const child of node.children || []) {
      collect(child);
    }
  }

  collect(trace);
  return messages;
}

/**
 * Step 1: Preprocess - Summarize trace, extract conversation, load KB
 */
async function preprocess(ctx: StepContext): Promise<StepResult> {
  const trace = ctx.trace as TraceNode;

  // Summarize trace
  const summarized = summarize(trace, {
    maxStringLength: 1000,
    maxArrayLength: 20,
    maxObjectKeys: 15,
    maxDepth: 8,
  });
  const traceJson = JSON.stringify(summarized, null, 2);

  // Extract conversation from trace
  const conversation = extractConversationFromTrace(trace);

  // Load existing knowledge base from storage
  const storage = await chrome.storage.local.get(PREFERENCES_KB_KEY);
  const existing_knowledge_base = storage[PREFERENCES_KB_KEY] || '';

  // Check if we should skip preference extraction
  const skip_preference_extraction = !conversation || conversation.length === 0;

  // Clean transcript: filter out system messages and compress
  let cleaned_transcript = '';
  if (!skip_preference_extraction) {
    const filtered = conversation.filter(
      (msg): msg is ConversationMessage & { role: 'user' | 'assistant' | 'tool' } =>
        msg.role !== 'system' && msg.content !== null
    );

    const compressed = filtered.map(msg => {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const summarizedContent = summarize(content, {
        maxStringLength: 1000,
        maxArrayLength: 20,
        maxObjectKeys: 15,
        maxDepth: 8
      });
      return {
        role: msg.role,
        content: typeof summarizedContent === 'string' ? summarizedContent : JSON.stringify(summarizedContent)
      };
    });

    cleaned_transcript = compressed
      .map(msg => `[${msg.role.toUpperCase()}]: ${msg.content}`)
      .join('\n\n');
  }

  return {
    result: {
      traceJson,
      cleaned_transcript,
      existing_knowledge_base,
      skip_preference_extraction
    }
  };
}

/**
 * Step 3: Prepare KB Input - Set skip flag if no preferences
 */
function prepareKBInput(ctx: StepContext): StepResult {
  const { extracted_preferences, existing_knowledge_base, skip_preference_extraction } = ctx as StepContext & {
    extracted_preferences: string;
    existing_knowledge_base: string;
    skip_preference_extraction: boolean;
  };

  // Skip knowledge base update if no preferences found or extraction was skipped
  const noPreferences = skip_preference_extraction ||
                        extracted_preferences === 'No new preferences identified.' ||
                        !extracted_preferences ||
                        extracted_preferences.trim() === '';

  return {
    result: {
      new_knowledge_chunk: extracted_preferences || '',
      existing_knowledge_base: existing_knowledge_base || '',
      skip_knowledge_update: noPreferences
    }
  };
}

/**
 * Step 5: Save Results - Save to storage if updated
 */
async function saveResults(ctx: StepContext): Promise<StepResult> {
  const {
    critique,
    extracted_preferences,
    skip_knowledge_update,
    average_score,
    updated_knowledge_base,
    questions_tested,
    knowledge_updated,
    existing_knowledge_base
  } = ctx as StepContext & {
    critique: unknown;
    extracted_preferences: string;
    skip_knowledge_update: boolean;
    average_score?: number;
    updated_knowledge_base?: string;
    questions_tested?: number;
    knowledge_updated?: boolean;
    existing_knowledge_base: string;
  };

  // Save to storage if knowledge was updated
  const finalKB = updated_knowledge_base || existing_knowledge_base;
  if (knowledge_updated && updated_knowledge_base) {
    await chrome.storage.local.set({ [PREFERENCES_KB_KEY]: updated_knowledge_base });
  }

  return {
    result: {
      // Flatten critique to top level for backwards compatibility with debug panel
      ...(critique as object),
      extracted_preferences: extracted_preferences || '',
      average_score: average_score ?? null,
      updated_knowledge_base: finalKB,
      questions_tested: questions_tested ?? 0,
      knowledge_updated: knowledge_updated ?? false,
      skipped_preferences: skip_knowledge_update
    }
  };
}

// =============================================================================
// Action
// =============================================================================

export const TRACE_ANALYZER_ACTION: Action = {
  name: 'TRACE_ANALYZER',
  description: 'Analyzes execution traces for improvements and extracts user preferences in a single LLM call.',
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
    // Step 1: Preprocess - summarize trace, extract conversation, load KB
    {
      type: 'function',
      handler: preprocess
    },

    // Step 2: Analyze - combined LLM call for critique and preferences
    {
      type: 'llm',
      system_prompt: SYSTEM_PROMPT,
      message: `Analyze this trace and extract preferences.

<trace>
{{{traceJson}}}
</trace>

<conversation>
{{{cleaned_transcript}}}
</conversation>

{{#skip_preference_extraction}}
No conversation found. Output "No new preferences identified." for extracted_preferences.
{{/skip_preference_extraction}}`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    },

    // Step 3: Prepare KB Input - set skip flag if no preferences
    {
      type: 'function',
      handler: prepareKBInput
    },

    // Step 4: Update KB - conditional on having preferences
    {
      type: 'action',
      action: KNOWLEDGE_BASE_ADAPTOR_ACTION.name,
      condition: (ctx: StepContext) => !(ctx as { skip_knowledge_update?: boolean }).skip_knowledge_update
    },

    // Step 5: Save Results - save to storage if updated
    {
      type: 'function',
      handler: saveResults
    }
  ]
};
