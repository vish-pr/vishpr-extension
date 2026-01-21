/**
 * Clean and summarize webpage content
 * Single LLM call that cleans content and produces a 5-line summary
 */
import type { Action, JSONSchema, StepContext, StepResult } from './types/index.js';

export const CLEAN_CONTENT = 'CLEAN_CONTENT';

const ELEMENT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, text: { type: 'string' } },
  required: ['id', 'text'],
  additionalProperties: false
};

const OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Cleaned main content, noise removed' },
    links: { type: 'array', items: ELEMENT_SCHEMA, description: 'Important links only (max 10)' },
    buttons: { type: 'array', items: ELEMENT_SCHEMA, description: 'Key action buttons only (max 5)' },
    inputs: { type: 'array', items: ELEMENT_SCHEMA, description: 'Important form fields only (max 5)' },
    summary: { type: 'string', description: '5-line summary of page content and purpose' }
  },
  required: ['text', 'links', 'buttons', 'inputs', 'summary'],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You distill webpage content to essentials.

# Task
Extract only essential content from noisy webpage data.

# Removal Rules
MUST remove:
- Headers, footers, navigation menus
- Legal, policy, advertising links
- Hidden, duplicate, tracking inputs

# Selection Rules
MUST include:
- Main content that explains page purpose
- Actions user can take now

MUST exclude:
- UI chrome and decorative elements
- Navigation that doesn't advance primary task

# Output Fields
- text: Main content only (empty string if none)
- links: Primary workflow links (max 10)
- buttons: Primary action buttons (max 5)
- inputs: Required form fields (max 5)

# Summary Format (MANDATORY)
Exactly 5 lines:
1. Purpose: <page purpose>
2. Main content: <description or "None">
3. Primary actions: <comma-separated or "None">
4. Important links: <comma-separated or "None">
5. Forms/inputs: <comma-separated or "None">

No explanations. No removed content.`;

interface CleanContentContext extends StepContext {
  title?: string;
  text?: string;
  links?: Array<{ id: string; text: string }>;
  buttons?: Array<{ id: string; text: string }>;
  inputs?: Array<{ id: string; text: string }>;
}

export const cleanContentAction: Action = {
  name: CLEAN_CONTENT,
  description: 'Clean webpage content and produce a 5-line summary',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      text: { type: 'string' },
      links: { type: 'array', items: ELEMENT_SCHEMA },
      buttons: { type: 'array', items: ELEMENT_SCHEMA },
      inputs: { type: 'array', items: ELEMENT_SCHEMA }
    },
    required: ['text'],
    additionalProperties: true
  },

  steps: [
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => ({
        result: {
          linksJson: JSON.stringify((ctx as CleanContentContext).links || [], null, 2),
          buttonsJson: JSON.stringify((ctx as CleanContentContext).buttons || [], null, 2),
          inputsJson: JSON.stringify((ctx as CleanContentContext).inputs || [], null, 2)
        }
      })
    },
    {
      type: 'llm',
      system_prompt: SYSTEM_PROMPT,
      message: `Distill this webpage to essentials.

Title: {{{title}}}
Text: {{{text}}}
Links: {{{linksJson}}}
Buttons: {{{buttonsJson}}}
Inputs: {{{inputsJson}}}

Extract main content and primary actions only.`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};
