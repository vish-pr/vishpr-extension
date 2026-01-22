/**
 * Preference Extractor Action - Extract user preferences from conversations
 *
 * Workflow:
 * 1. Clean transcript (remove system prompts, compress large blocks)
 * 2. Extract preferences via LLM (plain prose)
 * 3. Feed to KNOWLEDGE_BASE_ADAPTOR for testing and merging
 */
import type { Action, JSONSchema, Message, StepContext, StepResult } from './types/index.js';
import { summarize } from '../summarize.js';
import { KNOWLEDGE_BASE_ADAPTOR } from './knowledge-base-action.js';

export const PREFERENCE_EXTRACTOR = 'PREFERENCE_EXTRACTOR';

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

# What to Extract

## Broad Categories
- Communication style (formal/casual, verbose/concise, technical level)
- Personality signals (patience level, decision-making style)
- General interests and topics they engage with
- Work patterns (time preferences, workflow habits)

## Task-Specific (Browser Assistant)
- Browsing habits (sites frequented, content types preferred)
- Search behavior (how they phrase queries, what they look for)
- Content preferences (formats, sources they trust)
- Interaction patterns (when they want automation vs control)

# Rules

MUST:
- Extract ONLY what is clearly evidenced in the conversation
- Write as factual statements, not inferences
- Be specific ("prefers bullet points" not "likes structure")

SHOULD:
- Note contradictions if user changed preference mid-conversation
- Prioritize explicit statements over implicit signals
- Include context when preference is situational

NEVER:
- Invent preferences not supported by conversation
- Include one-time requests as lasting preferences
- Extract sensitive personal data (finances, health, relationships)

# Output Format
Write 2-5 sentences of plain prose summarizing discovered preferences.
If no meaningful preferences found, output: "No new preferences identified."`;

// =============================================================================
// Types
// =============================================================================

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

interface PreferenceExtractorContext extends StepContext {
  conversation: ConversationMessage[];
  existing_knowledge_base: string;
}

// =============================================================================
// Step Handlers
// =============================================================================

/**
 * Clean transcript: remove system prompts and compress large content blocks
 */
function cleanTranscript(ctx: StepContext): StepResult {
  const { conversation } = ctx as PreferenceExtractorContext;

  if (!conversation || !Array.isArray(conversation)) {
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
  const { extracted_preferences, existing_knowledge_base } = ctx as StepContext & {
    extracted_preferences: string;
    existing_knowledge_base: string;
  };

  // Skip knowledge base update if no preferences found
  const noPreferences = extracted_preferences === 'No new preferences identified.' ||
                        !extracted_preferences ||
                        extracted_preferences.trim() === '';

  return {
    result: {
      new_knowledge_chunk: extracted_preferences,
      existing_knowledge_base: existing_knowledge_base || '',
      skip_knowledge_update: noPreferences
    }
  };
}

/**
 * Build final result combining extraction and knowledge base update
 */
function buildFinalResult(ctx: StepContext): StepResult {
  const {
    extracted_preferences,
    skip_knowledge_update,
    average_score,
    updated_knowledge_base,
    questions_tested,
    knowledge_updated,
    existing_knowledge_base
  } = ctx as StepContext & {
    extracted_preferences: string;
    skip_knowledge_update: boolean;
    average_score?: number;
    updated_knowledge_base?: string;
    questions_tested?: number;
    knowledge_updated?: boolean;
    existing_knowledge_base: string;
  };

  return {
    result: {
      extracted_preferences,
      average_score: average_score ?? null,
      updated_knowledge_base: updated_knowledge_base || existing_knowledge_base,
      questions_tested: questions_tested ?? 0,
      knowledge_updated: knowledge_updated ?? false,
      skipped: skip_knowledge_update
    }
  };
}

// =============================================================================
// Action
// =============================================================================

export const preferenceExtractorAction: Action = {
  name: PREFERENCE_EXTRACTOR,
  description: 'Extracts user preferences and interests from conversation transcripts and merges them into the knowledge base using the RIDDLER→ANSWERER→CHECKER→ADAPTAR workflow.',
  examples: [
    'Extract preferences from this conversation',
    'Learn user preferences from chat history',
    'Update user profile from conversation'
  ],
  input_schema: {
    type: 'object',
    properties: {
      conversation: {
        type: 'array',
        description: 'Full conversation transcript as array of {role, content} messages'
      },
      existing_knowledge_base: {
        type: 'string',
        description: 'Current knowledge base of user preferences'
      }
    },
    required: ['conversation', 'existing_knowledge_base'],
    additionalProperties: false
  },
  steps: [
    // Step 1: Clean and compress transcript
    {
      type: 'function',
      handler: cleanTranscript
    },

    // Step 2: Extract preferences via LLM
    {
      type: 'llm',
      system_prompt: EXTRACTION_SYSTEM_PROMPT,
      message: `Extract user preferences from this conversation.

<conversation>
{{{cleaned_transcript}}}
</conversation>

Identify preferences evidenced in the conversation. Write 2-5 sentences of plain prose, or "No new preferences identified." if none found.`,
      intelligence: 'LOW',
      output_schema: EXTRACTION_OUTPUT_SCHEMA
    },

    // Step 3: Prepare input for knowledge base
    {
      type: 'function',
      handler: prepareKnowledgeBaseInput
    },

    // Step 4: Update knowledge base (skip if no preferences)
    {
      type: 'action',
      action: KNOWLEDGE_BASE_ADAPTOR
    },

    // Step 5: Build final result
    {
      type: 'function',
      handler: buildFinalResult
    }
  ]
};

// =============================================================================
// Exports
// =============================================================================

export const preferenceExtractorActions: Action[] = [
  preferenceExtractorAction
];
