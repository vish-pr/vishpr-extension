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

const SYSTEM_PROMPT = `You are a webpage content distiller.

Your task is to extract ONLY essential content from raw webpage data.
Assume the input contains heavy noise and UI clutter.

STRICT REMOVAL RULES (always remove):
- Headers, footers, global navigation menus
- Legal, policy, advertising, and marketing links
- Hidden, duplicated, auto-generated, or tracking inputs

CONTENT SELECTION PRINCIPLES:
- Prefer function over navigation
- Exclude anything that does not help understand:
  (1) what the page is for
  (2) what the user can do right now

If the page has no meaningful main content, return:
- text as an empty string ""
- only items strictly necessary to interact with the page

OUTPUT JSON FIELDS:
- text: Cleaned main content only, no UI chrome
- links: Links that initiate or change a primary workflow
- buttons: Buttons that perform a primary action on this page
- inputs: Form fields required for a primary user action

SUMMARY (MANDATORY FORMAT):
Return exactly 5 lines, in this exact structure:

1. Purpose: <what the page is for>
2. Main content: <short description or "None">
3. Primary actions: <comma-separated or "None">
4. Important links: <comma-separated or "None">
5. Forms/inputs: <comma-separated or "None">

Do not add explanations. Do not include removed content. `;

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
      message: `Title: {{{title}}}

Text:
{{{text}}}

Links:
{{{linksJson}}}

Buttons:
{{{buttonsJson}}}

Inputs:
{{{inputsJson}}}`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};
