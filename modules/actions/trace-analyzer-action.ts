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
import {
  KNOWLEDGE_BASE_ADAPTOR_ACTION,
  FACT_COUNT_UPDATER_ACTION,
  parseKnowledgeBase,
  formatKnowledgeBase,
  factsToProse,
  type Fact
} from './knowledge-base-action.js';

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
      description: 'Plain prose summary with relevance counts [N], e.g., "User prefers X [1]." (2-5 sentences), or "No new preferences identified." if none found'
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

MUST: Extract ONLY preferences clearly evidenced in trace
MUST: Write as factual statements ("User prefers X")
NEVER: Invent preferences or treat one-time requests as lasting
NEVER: Extract sensitive data (finances, health, passwords)

## Signal Sources (Priority Order)

### 1. Explicit Choices (Highest Weight)
Look for REQUEST_INPUT results where is_default=false:
- User actively selected this option over alternatives
- Extract as strong preference

Example trace:
  REQUEST_INPUT → { answers: [{ value: "Dark theme", is_default: false }] }
Extract: "User prefers dark theme."

Example trace:
  REQUEST_INPUT → { answers: [{ value: "Express shipping", is_default: true }] }
Do NOT extract (auto-selected, not user choice).

### 2. Browsing Patterns (Medium Weight)
Analyze READ_PAGE URLs and summaries to identify:

| Domain Pattern | Interest Category |
|----------------|-------------------|
| github.com, stackoverflow.com, docs.* | Technical/Developer |
| arxiv.org, nature.com, scholar.* | Scientific/Academic |
| reddit.com, twitter.com, facebook.com | Social Media |
| youtube.com, spotify.com, soundcloud.com | Media/Entertainment |
| medium.com, substack.com, news.* | News/Articles |
| amazon.com, ebay.com, shop.* | Shopping |
| deviantart.com, behance.net, dribbble.com | Art/Design |

Extract patterns only if 2+ pages in same category.

Example trace:
  READ_PAGE → { url: "https://github.com/user/repo", ... }
  READ_PAGE → { url: "https://stackoverflow.com/questions/...", ... }
Extract: "User browses technical/developer sites."

### 3. Content Interaction Patterns
From page summaries and actions taken:
- What content types user engages with (code, articles, videos, forums)
- How user navigates (deep research vs quick lookup)
- Form preferences (if FILL_FORM actions observed)

### 4. Communication Preferences (Lower Weight)
From conversation transcript:

| Signal | Preference |
|--------|------------|
| User uses technical jargon | "User understands technical terms" |
| User asks for explanations | "User prefers detailed explanations" |
| Short replies from user | "User prefers concise communication" |
| User requests confirmation | "User wants confirmation before actions" |

## Evidence Thresholds

| Signal Type | Threshold | Action |
|-------------|-----------|--------|
| Explicit selection (is_default=false) | 1 occurrence | Extract |
| Same site category | 2+ pages | Extract |
| Repeated behavior | 3+ times | Extract |
| Single request ("this time") | Any | Do NOT extract |
| Timeout selection (is_default=true) | Any | Do NOT extract |

## Interest Categories to Identify

Classify user into applicable categories based on browsing:
- Technical: Programming, DevOps, System Admin
- Scientific: Research, Academia, Data Science
- Creative: Art, Design, Music, Writing
- Social: Social media, Forums, Communities
- Professional: Business, Finance, Productivity
- Entertainment: Gaming, Streaming, Media
- Shopping: E-commerce, Product Research

## Output Format
Write preferences with relevance count [1] suffix:
- "User prefers dark theme [1]. User browses technical sites [1]."
- Each fact ends with [1] (new facts always start at 1)
- 2-5 sentences total

Or: "No new preferences identified."

# Output Requirements
- critique.summary: 1-2 sentences on execution quality
- critique.topRecommendations: Top 3 prioritized improvements
- extracted_preferences: 2-5 sentences with [1] counts, or "No new preferences identified."`;

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
  result?: {
    answers?: Array<{
      value: string;
      is_default: boolean;
      preference_facts_used?: string[];
    }>;
    [key: string]: unknown;
  };
  prompt?: string;
  children?: TraceNode[];
}

interface ClarificationSignal {
  facts: string[];
  explicit_selection: boolean;  // true = +2, false (timeout) = +1
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
 * Extract clarification confirmation signals from trace
 * These indicate when user preferences informed a clarification option that was selected
 */
function extractClarificationSignals(trace: TraceNode): ClarificationSignal[] {
  const signals: ClarificationSignal[] = [];

  function traverse(node: TraceNode) {
    if (node.name === 'REQUEST_INPUT' && node.result?.answers) {
      for (const answer of node.result.answers) {
        if (answer.preference_facts_used && answer.preference_facts_used.length > 0) {
          signals.push({
            facts: answer.preference_facts_used,
            explicit_selection: !answer.is_default,  // +2 if explicit, +1 if default/timeout
          });
        }
      }
    }
    // Recurse into children
    for (const child of node.children || []) {
      traverse(child);
    }
  }

  traverse(trace);
  return signals;
}

/**
 * Step 1: Preprocess - Summarize trace, extract conversation, load KB, build clarification boosts
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

  // Load existing knowledge base from storage (now JSON format)
  const storage = await chrome.storage.local.get(PREFERENCES_KB_KEY);
  const existingKBString: string = (storage[PREFERENCES_KB_KEY] as string) || '';

  // Parse KB into facts array
  const parsedFacts = parseKnowledgeBase(existingKBString);

  // Extract clarification signals and build facts_to_boost list
  const clarificationSignals = extractClarificationSignals(trace);
  const factsToBoost: Array<{ text: string; amount: number }> = [];

  for (const signal of clarificationSignals) {
    // +2 for explicit selection, +1 for timeout (passive confirmation)
    const amount = signal.explicit_selection ? 2 : 1;
    for (const factText of signal.facts) {
      const existing = factsToBoost.find(f => f.text.toLowerCase().trim() === factText.toLowerCase().trim());
      if (existing) {
        existing.amount += amount;
      } else {
        factsToBoost.push({ text: factText, amount });
      }
    }
  }

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

  // Convert facts to format for FACT_COUNT_UPDATER
  const existingFactsForUpdater = parsedFacts.map(f => ({ text: f.text, score: f.score }));

  // Convert to prose for backwards compat with KNOWLEDGE_BASE_ADAPTOR
  const existingKBProse = factsToProse(parsedFacts);

  return {
    result: {
      traceJson,
      cleaned_transcript,
      existing_knowledge_base: existingKBProse,
      existing_knowledge_base_json: existingKBString,
      parsed_facts: parsedFacts,
      existing_facts: existingFactsForUpdater,
      facts_to_boost: factsToBoost,
      needs_clarification_boost: factsToBoost.length > 0,
      skip_preference_extraction,
      clarification_increments: factsToBoost.length
    }
  };
}

/**
 * Step 3: Process clarification boost results and prepare KB input
 */
function processBoostResultsAndPrepareKB(ctx: StepContext): StepResult {
  const { extracted_preferences, skip_preference_extraction, parsed_facts, updated_facts } = ctx as StepContext & {
    extracted_preferences: string;
    skip_preference_extraction: boolean;
    parsed_facts: Fact[];
    updated_facts?: Fact[];
  };

  // Use updated facts from FACT_COUNT_UPDATER if available, otherwise use original
  const factsAfterBoost = updated_facts || parsed_facts || [];

  // Skip knowledge base update if no preferences found or extraction was skipped
  const noPreferences = skip_preference_extraction ||
                        extracted_preferences === 'No new preferences identified.' ||
                        !extracted_preferences ||
                        extracted_preferences.trim() === '';

  // Convert to prose for KNOWLEDGE_BASE_ADAPTOR (which still expects prose)
  const existingKBProse = factsToProse(factsAfterBoost);

  return {
    result: {
      new_knowledge_chunk: extracted_preferences || '',
      existing_knowledge_base: existingKBProse,
      facts_after_boost: factsAfterBoost,
      skip_knowledge_update: noPreferences
    }
  };
}

/**
 * Step 6: Save Results - Save to storage if updated
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
    facts_after_boost,
    clarification_increments,
    facts_incremented,
    needs_clarification_boost
  } = ctx as StepContext & {
    critique: unknown;
    extracted_preferences: string;
    skip_knowledge_update: boolean;
    average_score?: number;
    updated_knowledge_base?: string;
    questions_tested?: number;
    knowledge_updated?: boolean;
    facts_after_boost?: Fact[];
    clarification_increments?: number;
    facts_incremented?: boolean;
    needs_clarification_boost?: boolean;
  };

  // Determine final KB state
  let finalKB: string;

  if (knowledge_updated && updated_knowledge_base) {
    // KNOWLEDGE_BASE_ADAPTOR returned updated KB (already in JSON format)
    finalKB = updated_knowledge_base;
  } else if (facts_after_boost && facts_after_boost.length > 0) {
    // Use facts after clarification boost (may have been updated by FACT_COUNT_UPDATER)
    finalKB = formatKnowledgeBase(facts_after_boost);
  } else {
    // No updates - keep existing
    finalKB = ctx.existing_knowledge_base_json as string || '[]';
  }

  // Save to storage if anything changed
  const shouldSave = knowledge_updated || needs_clarification_boost;
  if (shouldSave) {
    await chrome.storage.local.set({ [PREFERENCES_KB_KEY]: finalKB });
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
      skipped_preferences: skip_knowledge_update,
      clarification_increments: clarification_increments ?? 0,
      facts_incremented: facts_incremented ?? false
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
    // Step 1: Preprocess - summarize trace, extract conversation, load KB, build clarification boosts
    {
      type: 'function',
      handler: preprocess
    },

    // Step 2: Apply clarification boosts via FACT_COUNT_UPDATER (if any)
    {
      type: 'action',
      action: FACT_COUNT_UPDATER_ACTION.name,
      condition: (ctx: StepContext) => (ctx as { needs_clarification_boost?: boolean }).needs_clarification_boost === true
    },

    // Step 3: Analyze - combined LLM call for critique and preferences
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
No conversation found. Focus on browsing patterns from READ_PAGE actions only.
{{/skip_preference_extraction}}

For preferences, examine:
1. REQUEST_INPUT results - look for is_default:false (explicit choices)
2. READ_PAGE URLs and summaries - identify browsing patterns
3. Conversation - communication style signals`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    },

    // Step 4: Process boost results and prepare KB Input
    {
      type: 'function',
      handler: processBoostResultsAndPrepareKB
    },

    // Step 5: Update KB - conditional on having new preferences
    {
      type: 'action',
      action: KNOWLEDGE_BASE_ADAPTOR_ACTION.name,
      condition: (ctx: StepContext) => !(ctx as { skip_knowledge_update?: boolean }).skip_knowledge_update
    },

    // Step 6: Save Results - save to storage if updated
    {
      type: 'function',
      handler: saveResults
    }
  ]
};
