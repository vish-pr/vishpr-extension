/**
 * Preference Extractor Action - Extract user preferences from conversations
 *
 * Workflow:
 * 1. Extract conversation from trace and load existing KB from storage
 * 2. Clean transcript (remove system prompts, compress large blocks)
 * 3. Extract preferences via LLM (plain prose)
 * 4. Feed to KNOWLEDGE_BASE_ADAPTOR for testing and merging
 * 5. Save updated KB to storage
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';
import { summarize } from '../summarize.js';
import { KNOWLEDGE_BASE_ADAPTOR } from './knowledge-base-action.js';

export const PREFERENCE_EXTRACTOR = 'PREFERENCE_EXTRACTOR';

// Storage key for user preferences knowledge base
const PREFERENCES_KB_KEY = 'user_preferences_kb';

// =============================================================================
// Schemas
// =============================================================================

const EXTRACTION_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    extracted_preferences: {
      type: 'string',
      description: 'Plain prose summary of user preferences (2-5 sentences), or "No new preferences identified." if none found'
    }
  },
  required: ['extracted_preferences'],
  additionalProperties: false
};

// =============================================================================
// Prompts
// =============================================================================

const EXTRACTION_SYSTEM_PROMPT = `You extract user preferences and interests from conversations.

# Critical Rules
MUST: Extract ONLY preferences clearly evidenced in the conversation.
MUST: Write as factual statements ("User prefers X"), not inferences.
NEVER: Invent preferences or treat one-time requests as lasting preferences.

# What to Extract

| Category | Look For | Example Output |
|----------|----------|----------------|
| Communication | Formal/casual, verbose/concise | "User prefers concise responses" |
| Technical level | Jargon usage, explanation requests | "User understands technical terms" |
| Content format | Lists vs prose, detail level | "User prefers bullet points over paragraphs" |
| Browsing habits | Sites mentioned, content types | "User frequently uses Reddit for research" |
| Decision style | Quick vs deliberate, needs confirmation | "User wants confirmation before purchases" |
| Automation preference | Hands-on vs hands-off | "User prefers to review before submitting forms" |

# Evidence Strength

| Signal Type | Action |
|-------------|--------|
| Explicit statement ("I prefer X") | Extract as preference |
| Repeated behavior (3+ times) | Extract as preference |
| Single request ("show me X this time") | Do NOT extract |
| Implicit from context | Extract only if very clear |

# Rules

MUST:
- Be specific ("prefers dark mode" not "likes customization")
- Use present tense ("User prefers" not "User preferred")
- Limit to 2-5 sentences

SHOULD:
- Note if preference is situational ("prefers mobile view when traveling")
- Prioritize explicit statements over behavior

NEVER:
- Extract sensitive data (finances, health, relationships, passwords)
- Treat complaints as preferences ("hates X" → not useful)
- Include meta-observations ("user seems frustrated")

# Output Format
2-5 sentences of plain prose. Each sentence = one preference.
If nothing found: "No new preferences identified."

# Examples

Good: "User prefers JSON format for data exports. User wants confirmation before any purchase actions. User frequently shops on Amazon."

Bad: "User seems to like organized data. User might prefer confirmations. User was shopping today." (too vague, one-time observation)`;

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
 * Extract conversation from trace and load existing KB from storage
 */
async function extractConversationAndLoadKB(ctx: StepContext): Promise<StepResult> {
  const trace = ctx.trace as TraceNode;

  // Extract conversation from trace
  const conversation = extractConversationFromTrace(trace);

  // Load existing knowledge base from storage
  const storage = await chrome.storage.local.get(PREFERENCES_KB_KEY);
  const existing_knowledge_base = storage[PREFERENCES_KB_KEY] || '';

  // Skip if no conversation found
  if (!conversation || conversation.length === 0) {
    return {
      result: {
        conversation: [],
        existing_knowledge_base,
        skip_extraction: true
      }
    };
  }

  return {
    result: {
      conversation,
      existing_knowledge_base,
      skip_extraction: false
    }
  };
}

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
 * Clean transcript: remove system prompts and compress large content blocks
 */
function cleanTranscript(ctx: StepContext): StepResult {
  const { conversation, skip_extraction } = ctx as StepContext & {
    conversation: ConversationMessage[];
    skip_extraction: boolean;
  };

  if (skip_extraction || !conversation || !Array.isArray(conversation)) {
    return {
      result: {
        cleaned_transcript: '',
        message_count: 0
      }
    };
  }

  // Filter out system messages
  const filtered = conversation.filter(
    (msg): msg is ConversationMessage & { role: 'user' | 'assistant' | 'tool' } =>
      msg.role !== 'system' && msg.content !== null
  );

  // Compress each message content using summarize
  const compressed = filtered.map(msg => {
    const content = typeof msg.content === 'string' ? msg.content : '';
    const summarized = summarize(content, {
      maxStringLength: 1000,
      maxArrayLength: 20,
      maxObjectKeys: 15,
      maxDepth: 8
    });
    return {
      role: msg.role,
      content: typeof summarized === 'string' ? summarized : JSON.stringify(summarized)
    };
  });

  // Format as readable transcript
  const transcript = compressed
    .map(msg => `[${msg.role.toUpperCase()}]: ${msg.content}`)
    .join('\n\n');

  return {
    result: {
      cleaned_transcript: transcript,
      message_count: compressed.length
    }
  };
}

/**
 * Prepare input for KNOWLEDGE_BASE_ADAPTOR after extraction
 */
function prepareKnowledgeBaseInput(ctx: StepContext): StepResult {
  const { extracted_preferences, existing_knowledge_base, skip_extraction } = ctx as StepContext & {
    extracted_preferences: string;
    existing_knowledge_base: string;
    skip_extraction: boolean;
  };

  // Skip knowledge base update if no preferences found or extraction was skipped
  const noPreferences = skip_extraction ||
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
 * Build final result and save to storage if updated
 */
async function buildFinalResultAndSave(ctx: StepContext): Promise<StepResult> {
  const {
    extracted_preferences,
    skip_knowledge_update,
    skip_extraction,
    average_score,
    updated_knowledge_base,
    questions_tested,
    knowledge_updated,
    existing_knowledge_base
  } = ctx as StepContext & {
    extracted_preferences: string;
    skip_knowledge_update: boolean;
    skip_extraction: boolean;
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
      extracted_preferences: extracted_preferences || '',
      average_score: average_score ?? null,
      updated_knowledge_base: finalKB,
      questions_tested: questions_tested ?? 0,
      knowledge_updated: knowledge_updated ?? false,
      skipped: skip_extraction || skip_knowledge_update
    }
  };
}

// =============================================================================
// Action
// =============================================================================

export const preferenceExtractorAction: Action = {
  name: PREFERENCE_EXTRACTOR,
  description: 'Extracts user preferences from execution trace and merges them into the knowledge base.',
  examples: [
    'Extract preferences from this trace',
    'Learn user preferences from execution',
    'Update user profile from trace'
  ],
  input_schema: {
    type: 'object',
    properties: {
      trace: {
        type: 'object',
        description: 'Execution trace tree to extract conversation from'
      }
    },
    required: ['trace'],
    additionalProperties: false
  },
  steps: [
    // Step 1: Extract conversation from trace and load existing KB
    {
      type: 'function',
      handler: extractConversationAndLoadKB
    },

    // Step 2: Clean and compress transcript
    {
      type: 'function',
      handler: cleanTranscript
    },

    // Step 3: Extract preferences via LLM (skip if no conversation)
    {
      type: 'llm',
      system_prompt: EXTRACTION_SYSTEM_PROMPT,
      message: `Extract user preferences from this conversation.

<conversation>
{{{cleaned_transcript}}}
</conversation>

Extract preferences that are:
- Explicitly stated OR repeated 3+ times
- Specific and actionable (not vague)
- Not one-time requests

Output: 2-5 sentences, one preference each. Or: "No new preferences identified."`,
      intelligence: 'LOW',
      output_schema: EXTRACTION_OUTPUT_SCHEMA,
      skip_if: (ctx: StepContext) => (ctx as { skip_extraction?: boolean }).skip_extraction === true
    },

    // Step 4: Prepare input for knowledge base
    {
      type: 'function',
      handler: prepareKnowledgeBaseInput
    },

    // Step 5: Update knowledge base (skip if no preferences)
    {
      type: 'action',
      action: KNOWLEDGE_BASE_ADAPTOR
    },

    // Step 6: Build final result and save to storage
    {
      type: 'function',
      handler: buildFinalResultAndSave
    }
  ]
};

// =============================================================================
// Exports
// =============================================================================

export const preferenceExtractorActions: Action[] = [
  preferenceExtractorAction
];
