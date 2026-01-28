/**
 * Knowledge Base Actions - Generate, validate, and incorporate knowledge
 *
 * Workflow: RIDDLER → ANSWERER → CHECKER → ADAPTAR
 * - RIDDLER: Generate Q&A pairs from new knowledge
 * - ANSWERER: Answer questions using existing knowledge base
 * - CHECKER: Rate answer correctness (0-10)
 * - ADAPTAR: Incorporate new knowledge if answers were poor
 *
 * Facts are stored as JSON: [{text, score, lastModified}, ...]
 * Scores are integers, LLM handles semantic matching + merging
 * Pruning: timestamp-based, max 20 facts, delete oldest when full
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

// =============================================================================
// Types and Constants
// =============================================================================

export interface Fact {
  text: string;
  score: number;        // Integer only
  lastModified: number; // Unix timestamp (ms)
}

const MAX_FACTS = 20;

// =============================================================================
// Knowledge Base Utilities
// =============================================================================

/**
 * Parse KB JSON string into facts array
 */
export function parseKnowledgeBase(kb: string): Fact[] {
  if (!kb?.trim()) return [];

  try {
    const parsed = JSON.parse(kb);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is Fact =>
      typeof f === 'object' && f !== null &&
      typeof f.text === 'string' &&
      typeof f.score === 'number' &&
      typeof f.lastModified === 'number'
    );
  } catch {
    return [];
  }
}

/**
 * Parse prose with [N] counts into facts (used internally for ADAPTAR output)
 */
function parseProseWithCounts(prose: string): Fact[] {
  const COUNT_REGEX = /\s*\[(\d+(?:\.\d+)?)\]\s*$/;
  // Split on pattern: "] " or "]." followed by space (end of count marker)
  const parts = prose.split(/\](?:\s*\.\s*|\s+)/).filter(s => s.trim());
  const now = Date.now();

  return parts
    .map(p => {
      const withBracket = p.trim() + ']';
      const match = withBracket.match(COUNT_REGEX);
      if (!match) return null;
      return {
        text: withBracket.replace(COUNT_REGEX, '').trim(),
        score: Math.round(parseFloat(match[1])),
        lastModified: now
      };
    })
    .filter((f): f is Fact => f !== null);
}

/**
 * Format facts array to JSON string for storage
 */
export function formatKnowledgeBase(facts: Fact[]): string {
  return JSON.stringify(facts);
}

/**
 * Convert facts to prose for LLM consumption
 */
export function factsToProse(facts: Fact[]): string {
  if (facts.length === 0) return '';
  return facts.map(f => f.text).join('. ') + '.';
}

/**
 * Prune oldest facts if over limit
 */
export function pruneOldestFacts(facts: Fact[], maxFacts = MAX_FACTS): Fact[] {
  if (facts.length <= maxFacts) return facts;
  // Sort by lastModified descending, keep newest
  return [...facts]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, maxFacts);
}

/**
 * Increment scores for matching fact texts (used for clarification boosts)
 * Matches by exact text comparison (case-insensitive)
 */
export function incrementCounts(facts: Fact[], matchedTexts: string[], amount = 1): void {
  const now = Date.now();
  matchedTexts.forEach(text => {
    const normalizedSearch = text.toLowerCase().trim();
    const fact = facts.find(f => f.text.toLowerCase().trim() === normalizedSearch);
    if (fact) {
      fact.score += amount;
      fact.lastModified = now;
    }
  });
}

/**
 * Apply time decay to all facts (for backwards compat during migration)
 * Note: New system uses timestamp-based pruning, not score decay
 */
export function applyDecay(facts: Fact[], factor = 0.95): Fact[] {
  return facts.map(f => ({
    ...f,
    score: Math.max(1, Math.round(f.score * factor))
  }));
}

// =============================================================================
// FACT_COUNT_UPDATER Action
// =============================================================================

const FACT_COUNT_UPDATER_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          score: { type: 'number', description: 'Integer score' },
          modified: { type: 'boolean', description: 'True if score changed or fact was merged' }
        },
        required: ['text', 'score', 'modified']
      }
    }
  },
  required: ['facts']
};

/**
 * FACT_COUNT_UPDATER - LLM-based semantic score updates
 *
 * Handles:
 * - Semantic matching of "facts to boost" against existing facts
 * - Merging similar facts
 * - Returning integer scores with modified flags
 *
 * Post-processing (in code):
 * - For modified=true facts → set lastModified = Date.now()
 * - If facts.length > 20 → delete oldest by lastModified
 */
export const FACT_COUNT_UPDATER_ACTION: Action = {
  name: 'FACT_COUNT_UPDATER',
  description: 'Updates fact scores using semantic matching. Merges similar facts.',
  input_schema: {
    type: 'object',
    properties: {
      existing_facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            score: { type: 'number' }
          }
        },
        description: 'Current facts with scores'
      },
      facts_to_boost: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            amount: { type: 'number' }
          }
        },
        description: 'Facts to boost with amounts'
      }
    },
    required: ['existing_facts', 'facts_to_boost']
  },
  steps: [
    // Prepare JSON for LLM
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const existingFacts = (ctx.existing_facts || []) as Array<{ text: string; score: number }>;
        const factsToBoost = (ctx.facts_to_boost || []) as Array<{ text: string; amount: number }>;
        return {
          result: {
            existing_facts_json: JSON.stringify(existingFacts, null, 2),
            facts_to_boost_json: JSON.stringify(factsToBoost, null, 2)
          }
        };
      }
    },
    {
      type: 'llm',
      system_prompt: `You update fact relevance scores using semantic matching.

# Task
1. Match each "fact to boost" against existing facts (semantic similarity)
2. Add the boost amount to matched facts
3. Merge semantically equivalent facts: combine text, average scores (round to int)
4. Mark modified=true for any fact whose score changed or was merged

# Matching Rules
- "User likes coffee" matches "User prefers coffee" (same concept)
- "User prefers dark mode" matches "User likes dark theme" (same preference)
- "User uses Firefox" does NOT match "User likes fast browsers" (different)

# Merging Rules
When facts are semantically equivalent:
- Keep the more specific/detailed text
- Score = round(average of scores) + any boost
- Mark modified=true

# Examples

Input:
  existing_facts: [{"text": "User likes coffee", "score": 4}]
  facts_to_boost: [{"text": "User prefers coffee drinks", "amount": 2}]
Output:
  facts: [{"text": "User likes coffee", "score": 6, "modified": true}]

Input:
  existing_facts: [
    {"text": "User likes coffee", "score": 4},
    {"text": "User prefers black coffee", "score": 2}
  ]
  facts_to_boost: []
Output:
  facts: [{"text": "User prefers black coffee", "score": 3, "modified": true}]
  // Merged: avg(4,2)=3, kept more specific text

Input:
  existing_facts: [{"text": "User uses Firefox", "score": 5}]
  facts_to_boost: [{"text": "User likes Chrome", "amount": 1}]
Output:
  facts: [{"text": "User uses Firefox", "score": 5, "modified": false}]
  // No match found, unchanged

# Rules
MUST: Use integer scores only
MUST: Set modified=true when score changes OR facts merged
MUST: Merge semantically equivalent facts
NEVER: Add new facts not derived from existing_facts`,
      message: `Update fact scores.

<existing_facts>
{{{existing_facts_json}}}
</existing_facts>

<facts_to_boost>
{{{facts_to_boost_json}}}
</facts_to_boost>

Return facts array with text, score (integer), modified (boolean).`,
      intelligence: 'LOW',
      output_schema: FACT_COUNT_UPDATER_OUTPUT_SCHEMA
    },
    // Post-process: add timestamps for modified facts, prune if needed
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const llmFacts = (ctx.facts || []) as Array<{ text: string; score: number; modified: boolean }>;
        const existingFacts = (ctx.existing_facts || []) as Fact[];
        const now = Date.now();

        // Build updated facts with timestamps
        const updatedFacts: Fact[] = llmFacts.map(f => {
          // Find original to preserve timestamp if not modified
          const original = existingFacts.find(e => e.text === f.text);
          return {
            text: f.text,
            score: f.score,
            lastModified: f.modified ? now : (original?.lastModified || now)
          };
        });

        // Prune oldest if over limit
        const pruned = pruneOldestFacts(updatedFacts);

        return { result: { updated_facts: pruned } };
      }
    }
  ]
};

// =============================================================================
// Shared Schemas
// =============================================================================

// Shared schemas
const RIDDLER_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    qa_pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' }
        },
        required: ['question', 'answer'],
        additionalProperties: false
      },
      description: 'List of question-answer pairs generated from the knowledge chunk'
    }
  },
  required: ['qa_pairs'],
  additionalProperties: false
};

const ANSWERER_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: 'The answer to the question' },
          facts_used: {
            type: 'array',
            items: { type: 'string' },
            description: 'Quoted fact texts from KB that provided this answer'
          }
        },
        required: ['answer', 'facts_used'],
        additionalProperties: false
      },
      description: 'List of answers with the facts used to derive them'
    }
  },
  required: ['answers'],
  additionalProperties: false
};

const CHECKER_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    ratings: {
      type: 'array',
      items: { type: 'number' },
      description: 'List of ratings (0-10) for each answer'
    }
  },
  required: ['ratings'],
  additionalProperties: false
};

const ADAPTAR_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    updated_knowledge_base: {
      type: 'string',
      description: 'The updated knowledge base incorporating new information'
    }
  },
  required: ['updated_knowledge_base'],
  additionalProperties: false
};

/**
 * RIDDLER - Generate questions and answers from a knowledge chunk
 */
export const RIDDLER_ACTION: Action = {
  name: 'RIDDLER',
  description: 'Generates question-answer pairs from a chunk of knowledge. Creates 2-5 questions depending on complexity, with short concise answers.',
  examples: [
    'Generate quiz questions from this article',
    'Create Q&A from documentation'
  ],
  input_schema: {
    type: 'object',
    properties: {
      knowledge_chunk: {
        type: 'string',
        description: 'The chunk of knowledge to process'
      }
    },
    required: ['knowledge_chunk'],
    additionalProperties: false
  },
  steps: [
    {
      type: 'llm',
      system_prompt: `You generate Q&A pairs from knowledge chunks.

# Critical Rules
MUST: Use ONLY information explicitly stated in the knowledge chunk.
MUST: Generate 2-5 questions based on content density.
NEVER: Invent facts not present in the source.

# Question Guidelines

| Content Type | Question Style |
|--------------|----------------|
| Facts/data | "What is X?" / "How many X?" |
| Processes | "How does X work?" / "What steps are involved?" |
| Preferences | "What does the user prefer for X?" |
| Relationships | "How are X and Y related?" |

# Answer Guidelines
- 1-2 sentences maximum
- Direct, factual phrasing
- Quotable from source when possible

# Examples

Knowledge: "User prefers dark mode and uses Firefox browser."
→ Q: "What color theme does the user prefer?"
  A: "The user prefers dark mode."
→ Q: "Which browser does the user use?"
  A: "The user uses Firefox."

Knowledge: "The API returns JSON with fields: id, name, timestamp."
→ Q: "What format does the API return?"
  A: "The API returns JSON."
→ Q: "What fields are in the API response?"
  A: "The response contains id, name, and timestamp fields."`,
      message: `Generate Q&A pairs from this knowledge.

<knowledge_chunk>
{{{knowledge_chunk}}}
</knowledge_chunk>

Create 2-5 questions testing key concepts. Answers must be 1-2 sentences, directly from source.`,
      intelligence: 'MEDIUM',
      output_schema: RIDDLER_OUTPUT_SCHEMA
    }
  ]
};

/**
 * ANSWERER - Answer questions using existing knowledge base
 */
export const ANSWERER_ACTION: Action = {
  name: 'ANSWERER',
  description: 'Answers questions based on an existing knowledge base. Returns the original questions with answers derived only from the provided knowledge.',
  examples: [
    'Answer these questions from the knowledge base',
    'Test knowledge base against questions'
  ],
  input_schema: {
    type: 'object',
    properties: {
      existing_knowledge_base: {
        type: 'string',
        description: 'The existing knowledge base as prose'
      },
      questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of questions to answer'
      }
    },
    required: ['existing_knowledge_base', 'questions'],
    additionalProperties: false
  },
  steps: [
    {
      type: 'llm',
      system_prompt: `You answer questions using ONLY the provided knowledge base.

# Critical Rules
MUST: Answer using ONLY information in the knowledge base.
MUST: Return "Not found in knowledge base" if answer not present.
MUST: Return the quoted fact texts used.
NEVER: Use external knowledge or make inferences.

# Answer Format
For each question, return:
- answer: The response (1-2 sentences or "Not found in knowledge base")
- facts_used: Array of quoted fact texts that provided the answer

# Examples

Knowledge base: "User prefers dark mode. User uses Firefox."

Q: "What theme does the user prefer?"
→ { "answer": "The user prefers dark mode.", "facts_used": ["User prefers dark mode"] }

Q: "What browser does the user use?"
→ { "answer": "The user uses Firefox.", "facts_used": ["User uses Firefox"] }

Q: "What operating system does the user use?"
→ { "answer": "Not found in knowledge base.", "facts_used": [] }

Knowledge base: "User likes coffee and prefers it black."

Q: "What beverages does the user like?"
→ { "answer": "The user likes coffee and prefers it black.", "facts_used": ["User likes coffee and prefers it black"] }`,
      message: `Answer each question using ONLY the knowledge base.

<knowledge_base>
{{{existing_knowledge_base}}}
</knowledge_base>

<questions>
{{#questions}}
- {{{.}}}
{{/questions}}
</questions>

For each question: answer from knowledge base OR "Not found in knowledge base".
Include facts_used array with quoted fact texts that provided each answer.`,
      intelligence: 'MEDIUM',
      output_schema: ANSWERER_OUTPUT_SCHEMA
    }
  ]
};

/**
 * CHECKER - Validate answer correctness
 */
export const CHECKER_ACTION: Action = {
  name: 'CHECKER',
  description: 'Checks if student answers are correct compared to reference answers. Rates each answer 0-10 based on accuracy.',
  examples: [
    'Grade these answers against the correct ones',
    'Check answer accuracy'
  ],
  input_schema: {
    type: 'object',
    properties: {
      knowledge_chunk: {
        type: 'string',
        description: 'Original knowledge for context'
      },
      comparisons: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            correct_answer: { type: 'string' },
            student_answer: { type: 'string' }
          },
          required: ['question', 'correct_answer', 'student_answer'],
          additionalProperties: false
        },
        description: 'List of {question, correct_answer, student_answer} to check'
      }
    },
    required: ['knowledge_chunk', 'comparisons'],
    additionalProperties: false
  },
  steps: [
    // Format comparisons for the LLM prompt
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const comparisons = (ctx.comparisons || []) as Array<{
          question: string;
          correct_answer: string;
          student_answer: string;
        }>;
        const formatted = comparisons.map((c, i) =>
          `<item index="${i + 1}">
  <question>${c.question}</question>
  <correct_answer>${c.correct_answer}</correct_answer>
  <student_answer>${c.student_answer}</student_answer>
</item>`
        ).join('\n');
        return { result: { formatted_comparisons: formatted } };
      }
    },
    {
      type: 'llm',
      system_prompt: `You rate answer correctness on a 0-10 scale.

# Rating Scale

| Score | Meaning | When to Use |
|-------|---------|-------------|
| 10 | Perfect | Exact match or semantically equivalent |
| 8-9 | Excellent | Correct with minor phrasing differences |
| 6-7 | Good | Mostly correct, small omissions |
| 4-5 | Partial | Some correct info, significant gaps |
| 2-3 | Poor | Mostly wrong, few correct elements |
| 0-1 | Wrong | Incorrect, unrelated, or "Not found" |

# Critical Rules
MUST: Compare student_answer against correct_answer.
MUST: Rate based on factual accuracy, not phrasing.
MUST: Give 0-1 for "Not found in knowledge base" responses.

# Examples

Correct: "User prefers dark mode"
Student: "The user likes dark mode"
→ Rating: 10 (semantically equivalent)

Correct: "User prefers dark mode and large fonts"
Student: "User prefers dark mode"
→ Rating: 6 (partial, missing fonts)

Correct: "API returns JSON"
Student: "Not found in knowledge base"
→ Rating: 0 (failed to find answer)`,
      message: `Rate each student answer against the correct answer.

<knowledge_chunk>
{{{knowledge_chunk}}}
</knowledge_chunk>

<comparisons>
{{{formatted_comparisons}}}
</comparisons>

For each: compare student vs correct answer, rate 0-10. "Not found" = 0-1.`,
      intelligence: 'MEDIUM',
      output_schema: CHECKER_OUTPUT_SCHEMA
    }
  ]
};

/**
 * ADAPTAR - Incorporate new knowledge into existing knowledge base
 */
export const ADAPTAR_ACTION: Action = {
  name: 'ADAPTAR',
  description: 'Incorporates new knowledge into an existing knowledge base. Adds information needed to answer previously unanswerable questions while keeping the base concise.',
  examples: [
    'Update knowledge base with new information',
    'Merge new knowledge into existing base'
  ],
  input_schema: {
    type: 'object',
    properties: {
      new_knowledge_chunk: {
        type: 'string',
        description: 'New knowledge to incorporate'
      },
      existing_knowledge_base: {
        type: 'string',
        description: 'Current knowledge base'
      },
      questions_not_answered: {
        type: 'array',
        items: { type: 'string' },
        description: 'Questions the existing base could not answer'
      }
    },
    required: ['new_knowledge_chunk', 'existing_knowledge_base'],
    additionalProperties: false
  },
  steps: [
    {
      type: 'llm',
      system_prompt: `You merge new knowledge into existing knowledge bases.

# Critical Rules
MUST: Preserve ALL existing content - never delete facts.
MUST: Preserve relevance counts [N] on all facts.
MUST: Add only information from provided sources.

# Relevance Count Rules

| Action | Count Rule |
|--------|------------|
| Add new fact | Start with [1] |
| Fact unchanged | Keep existing [N] |
| Merge similar facts | Use max(1, higher_count * 0.5) |
| Edit existing fact | Reduce to max(1, count * 0.5) |

# Examples

Existing: "User prefers dark mode [8]."
New: "User prefers dark mode and large fonts."
→ Updated: "User prefers dark mode and large fonts [4]." (edited, count halved)

Existing: "User likes coffee [3]."
New: "User drinks tea."
→ Updated: "User likes coffee [3]. User drinks tea [1]." (new fact added)

Existing: "User likes coffee [6]. User likes tea [2]."
New: "User enjoys hot beverages."
→ Updated: "User enjoys hot beverages including coffee and tea [3]." (merged, max(6,2)*0.5=3)

Existing: "User prefers Python [4]."
New: (no change to this fact)
→ Updated: "User prefers Python [4]." (unchanged, keep count)

# Merge Process
1. Keep all existing facts with their counts
2. Add new facts with [1]
3. Merge overlapping facts (halve the higher count, min 1)
4. Group related information

IMPORTANT: Every fact MUST end with [N] where N ≥ 1.`,
      message: `Merge new knowledge into the existing base.

<new_knowledge>
{{{new_knowledge_chunk}}}
</new_knowledge>

<existing_knowledge_base>
{{{existing_knowledge_base}}}
</existing_knowledge_base>

{{#questions_not_answered}}
<questions_needing_answers>
{{#questions_not_answered}}
- {{{.}}}
{{/questions_not_answered}}
</questions_needing_answers>
{{/questions_not_answered}}

Preserve all existing content with counts. Add new facts with [1]. Merge overlapping facts (halve count). Every fact MUST have [N] suffix.`,
      intelligence: 'MEDIUM',
      output_schema: ADAPTAR_OUTPUT_SCHEMA
    }
  ]
};

/**
 * KNOWLEDGE_BASE_ADAPTOR - Full orchestrated workflow
 *
 * Flow:
 * 1. Parse KB and convert to numbered list for RIDDLER
 * 2. RIDDLER: Generate Q&A from new knowledge
 * 3. ANSWERER: Answer using numbered KB
 * 4. CHECKER: Rate answers
 * 5. Build facts_to_boost from high-scoring answers (rating >= 6)
 * 6. FACT_COUNT_UPDATER: Semantic match, merge, update scores
 * 7. ADAPTAR: Add new facts if needed
 * 8. Build final result
 */
export const KNOWLEDGE_BASE_ADAPTOR_ACTION: Action = {
  name: 'KNOWLEDGE_BASE_ADAPTOR',
  description: 'Full knowledge base update workflow. Generates questions from new knowledge, tests existing knowledge base, and incorporates new information where gaps exist.',
  examples: [
    'Learn this new information',
    'Update knowledge base with this content',
    'Incorporate new knowledge'
  ],
  input_schema: {
    type: 'object',
    properties: {
      new_knowledge_chunk: {
        type: 'string',
        description: 'New knowledge to potentially incorporate'
      },
      existing_knowledge_base: {
        type: 'string',
        description: 'Current knowledge base (JSON format) to test and update'
      }
    },
    required: ['new_knowledge_chunk', 'existing_knowledge_base'],
    additionalProperties: false
  },
  steps: [
    // Step 1: Parse KB and prepare for RIDDLER
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const newKnowledge = (ctx as StepContext & { new_knowledge_chunk: string }).new_knowledge_chunk;
        const existingKB = ctx.existing_knowledge_base as string;

        // Parse KB into facts array
        const facts = parseKnowledgeBase(existingKB);

        // Convert to prose for ANSWERER
        const proseKB = factsToProse(facts);

        return {
          result: {
            knowledge_chunk: newKnowledge,
            parsed_facts: facts,
            existing_knowledge_base: proseKB  // Override with prose format for ANSWERER
          }
        };
      }
    },

    // Step 2: Generate Q&A from new knowledge
    { type: 'action', action: RIDDLER_ACTION.name },

    // Step 3: Extract questions for answerer
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const qaPairs = (ctx.qa_pairs || []) as Array<{ question: string; answer: string }>;
        return {
          result: {
            questions: qaPairs.map(item => item.question),
            riddler_answers: qaPairs
          }
        };
      }
    },

    // Step 4: Answer questions using existing knowledge (numbered list)
    { type: 'action', action: ANSWERER_ACTION.name },

    // Step 5: Build comparisons for checker
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const riddlerAnswers = (ctx.riddler_answers || []) as Array<{ question: string; answer: string }>;
        const studentAnswers = (ctx.answers || []) as Array<{ answer: string; facts_used: string[] }>;

        return {
          result: {
            comparisons: riddlerAnswers.map((item, i) => ({
              question: item.question,
              correct_answer: item.answer,
              student_answer: studentAnswers[i]?.answer || 'Not found in knowledge base'
            })),
            answerer_results: studentAnswers
          }
        };
      }
    },

    // Step 6: Check answer correctness
    { type: 'action', action: CHECKER_ACTION.name },

    // Step 7: Build facts_to_boost from high-scoring answers
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const ratings = (ctx.ratings || []) as number[];
        const comparisons = (ctx.comparisons || []) as Array<{ question: string }>;
        const answererResults = (ctx.answerer_results || []) as Array<{ answer: string; facts_used: string[] }>;
        const parsedFacts = (ctx.parsed_facts || []) as Fact[];

        // Filter questions with low scores
        const questionsNotAnswered = ratings
          .map((rating, i) => ({ rating, question: comparisons[i]?.question }))
          .filter(item => item.rating <= 5)
          .map(item => item.question);

        const avgScore = ratings.length > 0
          ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length
          : 0;

        // Build facts_to_boost from high-scoring answers (rating >= 6)
        // facts_used is now an array of text strings directly
        const factsToBoost: Array<{ text: string; amount: number }> = [];
        ratings.forEach((rating, i) => {
          if (rating >= 6 && answererResults[i]?.facts_used?.length > 0) {
            answererResults[i].facts_used.forEach(factText => {
              const existing = factsToBoost.find(f => f.text.toLowerCase().trim() === factText.toLowerCase().trim());
              if (existing) {
                existing.amount += 1;
              } else {
                factsToBoost.push({ text: factText, amount: 1 });
              }
            });
          }
        });

        // Convert facts to format for FACT_COUNT_UPDATER
        const existingFactsForUpdater = parsedFacts.map(f => ({ text: f.text, score: f.score }));

        return {
          result: {
            questions_not_answered: questionsNotAnswered,
            average_score: avgScore,
            needs_update: questionsNotAnswered.length > 0,
            needs_score_update: factsToBoost.length > 0,
            existing_facts: existingFactsForUpdater,
            facts_to_boost: factsToBoost,
            parsed_facts: parsedFacts  // Preserve for later
          }
        };
      }
    },

    // Step 8: Update fact scores via FACT_COUNT_UPDATER (skip if no boosts)
    {
      type: 'action',
      action: FACT_COUNT_UPDATER_ACTION.name,
      condition: (ctx: StepContext) => (ctx as { needs_score_update?: boolean }).needs_score_update === true
    },

    // Step 9: Merge updated facts back
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const updatedFacts = (ctx.updated_facts || ctx.parsed_facts || []) as Fact[];

        // Convert back to JSON for ADAPTAR (keeping prose format for backwards compat)
        const kbForAdaptar = factsToProse(updatedFacts);

        return {
          result: {
            existing_knowledge_base: kbForAdaptar,
            updated_facts_internal: updatedFacts,
            facts_incremented: ctx.needs_score_update || false
          }
        };
      }
    },

    // Step 10: Update knowledge base if needed (skip if no gaps) - adds new facts
    {
      type: 'llm',
      skip_if: (ctx: StepContext) => !ctx.needs_update,
      system_prompt: `You add new facts to an existing knowledge base.

# Critical Rules
MUST: Preserve ALL existing facts exactly as provided.
MUST: Add only NEW facts from the new knowledge that answer gap questions.
MUST: New facts should be concise (1 sentence each).
NEVER: Modify or merge existing facts.
NEVER: Add facts that duplicate existing information.

# Output Format
Return the existing knowledge base prose PLUS any new facts.
New facts should be appended, each ending with [1].

# Examples

Existing: "User prefers dark mode. User uses Firefox."
New: "User likes coffee."
Gap: "What beverages does the user like?"
→ "User prefers dark mode. User uses Firefox. User likes coffee [1]."

Existing: "User prefers Python."
New: "User prefers Python for data science."
Gap: "What does the user use Python for?"
→ "User prefers Python. User uses Python for data science [1]."`,
      message: `Add new facts to answer gap questions.

<new_knowledge>
{{{new_knowledge_chunk}}}
</new_knowledge>

<existing_knowledge_base>
{{{existing_knowledge_base}}}
</existing_knowledge_base>

<questions_needing_answers>
{{#questions_not_answered}}
- {{{.}}}
{{/questions_not_answered}}
</questions_needing_answers>

Output existing facts plus new facts with [1] suffix.`,
      intelligence: 'MEDIUM',
      output_schema: ADAPTAR_OUTPUT_SCHEMA
    },

    // Step 11: Convert final result to JSON format
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const updatedFactsInternal = (ctx.updated_facts_internal || []) as Fact[];
        const updatedKBProse = ctx.updated_knowledge_base as string | undefined;
        const now = Date.now();

        let finalFacts: Fact[];

        if (ctx.needs_update && updatedKBProse) {
          // Parse the ADAPTAR output (prose with [N] counts) and merge with internal facts
          const newFactsFromAdaptar = parseProseWithCounts(updatedKBProse);

          // Find truly new facts (not in internal)
          const existingTexts = new Set(updatedFactsInternal.map(f => f.text.toLowerCase().trim()));
          const newFacts = newFactsFromAdaptar.filter(f =>
            !existingTexts.has(f.text.toLowerCase().trim())
          ).map(f => ({
            text: f.text,
            score: 1,  // New facts always start with score 1
            lastModified: now
          }));

          finalFacts = [...updatedFactsInternal, ...newFacts];
        } else {
          finalFacts = updatedFactsInternal;
        }

        // Prune if over limit
        const prunedFacts = pruneOldestFacts(finalFacts);

        // Convert to JSON string for storage
        const finalKB = formatKnowledgeBase(prunedFacts);

        return {
          result: {
            average_score: ctx.average_score,
            updated_knowledge_base: finalKB,
            questions_tested: (ctx.riddler_answers as Array<unknown> || []).length,
            questions_not_answered: ctx.questions_not_answered,
            knowledge_updated: ctx.needs_update || false,
            facts_incremented: ctx.facts_incremented || false
          }
        };
      }
    }
  ]
};

// Export all actions as array for registry
export const knowledgeBaseActions: Action[] = [
  RIDDLER_ACTION,
  ANSWERER_ACTION,
  CHECKER_ACTION,
  ADAPTAR_ACTION,
  FACT_COUNT_UPDATER_ACTION,
  KNOWLEDGE_BASE_ADAPTOR_ACTION
];
