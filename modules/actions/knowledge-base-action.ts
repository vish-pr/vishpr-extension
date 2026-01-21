/**
 * Knowledge Base Actions - Generate, validate, and incorporate knowledge
 *
 * Workflow: RIDDLER → ANSWERER → CHECKER → ADAPTAR
 * - RIDDLER: Generate Q&A pairs from new knowledge
 * - ANSWERER: Answer questions using existing knowledge base
 * - CHECKER: Rate answer correctness (0-10)
 * - ADAPTAR: Incorporate new knowledge if answers were poor
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

// Action name constants
export const RIDDLER = 'RIDDLER';
export const ANSWERER = 'ANSWERER';
export const CHECKER = 'CHECKER';
export const ADAPTAR = 'ADAPTAR';
export const KNOWLEDGE_BASE_ADAPTOR = 'KNOWLEDGE_BASE_ADAPTOR';

// Shared schemas
const RIDDLER_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    qa_pairs: {
      type: 'array',
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
      description: 'List of answers to the questions based on existing knowledge'
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
      description: 'List of ratings for each answer'
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
export const riddlerAction: Action = {
  name: RIDDLER,
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

# Rules
MUST:
- Generate 2-5 questions based on complexity
- Keep answers short (1-2 sentences)
- Use ONLY information from provided knowledge

SHOULD:
- Focus on key concepts and facts
- Vary question types (what, how, why)

NEVER:
- Invent information not in the source
- Create ambiguous questions`,
      message: `Generate Q&A pairs from this knowledge.

<knowledge_chunk>
{{{knowledge_chunk}}}
</knowledge_chunk>

Create questions testing key concepts. Keep answers concise.`,
      intelligence: 'MEDIUM',
      output_schema: RIDDLER_OUTPUT_SCHEMA
    }
  ]
};

/**
 * ANSWERER - Answer questions using existing knowledge base
 */
export const answererAction: Action = {
  name: ANSWERER,
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
        description: 'The existing knowledge base to search for answers'
      },
      questions: {
        type: 'array',
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

# Rules
MUST:
- Answer using ONLY the knowledge base content
- Return "Not found in knowledge base" if answer not present
- Keep answers short (1-2 sentences)

NEVER:
- Use external knowledge
- Guess or infer beyond stated facts`,
      message: `Answer questions using only this knowledge base.

<knowledge_base>
{{{existing_knowledge_base}}}
</knowledge_base>

<questions>
{{#questions}}
- {{{.}}}
{{/questions}}
</questions>

Answer from knowledge base only. Say "Not found" if absent.`,
      intelligence: 'MEDIUM',
      output_schema: ANSWERER_OUTPUT_SCHEMA
    }
  ]
};

/**
 * CHECKER - Validate answer correctness
 */
export const checkerAction: Action = {
  name: CHECKER,
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
- 10: Perfect or equivalent
- 7-9: Mostly correct, minor issues
- 4-6: Partially correct
- 1-3: Mostly incorrect
- 0: Wrong or unrelated

# Rules
MUST:
- Compare student answer against correct answer
- Use knowledge chunk as context
- Rate strictly based on factual accuracy`,
      message: `Rate each student answer against the correct answer.

<knowledge_chunk>
{{{knowledge_chunk}}}
</knowledge_chunk>

<comparisons>
{{{formatted_comparisons}}}
</comparisons>

Rate each answer 0-10 based on correctness.`,
      intelligence: 'MEDIUM',
      output_schema: CHECKER_OUTPUT_SCHEMA
    }
  ]
};

/**
 * ADAPTAR - Incorporate new knowledge into existing knowledge base
 */
export const adaptarAction: Action = {
  name: ADAPTAR,
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

# Rules
MUST:
- Preserve ALL existing content
- Add only information that addresses gaps
- Keep result concise and organized

SHOULD:
- Group related information
- Remove redundancy between old and new

NEVER:
- Delete existing facts
- Add information not in sources`,
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

Add information that addresses unanswered questions. Preserve existing content.`,
      intelligence: 'MEDIUM',
      output_schema: ADAPTAR_OUTPUT_SCHEMA
    }
  ]
};

/**
 * KNOWLEDGE_BASE_ADAPTOR - Full orchestrated workflow
 *
 * Flow:
 * 1. RIDDLER: Generate Q&A from new knowledge
 * 2. Build questions list (function)
 * 3. ANSWERER: Try to answer using existing knowledge
 * 4. Build comparisons (function)
 * 5. CHECKER: Rate the answers
 * 6. Filter low scores (function)
 * 7. ADAPTAR: Update knowledge base if needed
 * 8. Build final result (function)
 */
export const knowledgeBaseAdaptorAction: Action = {
  name: KNOWLEDGE_BASE_ADAPTOR,
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
        description: 'Current knowledge base to test and update'
      }
    },
    required: ['new_knowledge_chunk', 'existing_knowledge_base'],
    additionalProperties: false
  },
  steps: [
    // Step 1: Generate Q&A from new knowledge
    { type: 'action', action: RIDDLER },

    // Step 2: Extract questions for answerer
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

    // Step 3: Answer questions using existing knowledge
    { type: 'action', action: ANSWERER },

    // Step 4: Build comparisons for checker
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const riddlerAnswers = (ctx.riddler_answers || []) as Array<{ question: string; answer: string }>;
        const studentAnswers = (ctx.answers || []) as Array<{ question: string; answer: string }>;

        return {
          result: {
            comparisons: riddlerAnswers.map((item, i) => ({
              question: item.question,
              correct_answer: item.answer,
              student_answer: studentAnswers[i]?.answer || 'Not found in knowledge base'
            }))
          }
        };
      }
    },

    // Step 5: Check answer correctness
    { type: 'action', action: CHECKER },

    // Step 6: Filter questions with low scores
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const ratings = (ctx.ratings || []) as Array<{ question: string; rating: number }>;
        const comparisons = (ctx.comparisons || []) as Array<{ question: string }>;

        const questionsNotAnswered = ratings
          .map((r, i) => ({ ...r, question: comparisons[i]?.question || r.question }))
          .filter(item => item.rating <= 5)
          .map(item => item.question);

        const avgScore = ratings.length > 0
          ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length
          : 0;

        return {
          result: {
            questions_not_answered: questionsNotAnswered,
            average_score: avgScore,
            needs_update: questionsNotAnswered.length > 0
          }
        };
      }
    },

    // Step 7: Update knowledge base if needed (skip if no gaps)
    {
      type: 'llm',
      skip_if: (ctx: StepContext) => !ctx.needs_update,
      system_prompt: `You merge new knowledge into existing knowledge bases.

# Rules
MUST:
- Preserve ALL existing content
- Add only information that addresses gaps
- Keep result concise

NEVER:
- Delete existing facts`,
      message: `Merge new knowledge into the existing base.

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

Add information addressing gaps. Preserve existing content.`,
      intelligence: 'MEDIUM',
      output_schema: ADAPTAR_OUTPUT_SCHEMA
    },

    // Step 8: Build final result
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        return {
          result: {
            average_score: ctx.average_score,
            updated_knowledge_base: ctx.updated_knowledge_base || ctx.existing_knowledge_base,
            questions_tested: (ctx.riddler_answers as Array<unknown> || []).length,
            questions_not_answered: ctx.questions_not_answered,
            knowledge_updated: ctx.needs_update || false
          }
        };
      }
    }
  ]
};

// Export all actions as array for registry
export const knowledgeBaseActions: Action[] = [
  riddlerAction,
  answererAction,
  checkerAction,
  adaptarAction,
  knowledgeBaseAdaptorAction
];
