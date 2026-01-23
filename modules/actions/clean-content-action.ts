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
    links: { type: 'array', items: ELEMENT_SCHEMA, description: 'Relevant links (max 30)' },
    buttons: { type: 'array', items: ELEMENT_SCHEMA, description: 'Action buttons (max 15)' },
    inputs: { type: 'array', items: ELEMENT_SCHEMA, description: 'Form fields (max 15)' },
    summary: { type: 'string', description: '5-line summary of page content and purpose' }
  },
  required: ['text', 'links', 'buttons', 'inputs', 'summary'],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You distill webpage content for an AI agent that needs to understand and interact with the page.

# Critical Rules
MUST: Preserve content the agent might need to complete tasks.
MUST: Keep all interactive elements that could be relevant.
MUST: Follow limits (links≤30, buttons≤15, inputs≤15).
MUST: Produce exactly 5-line summary.

# What to REMOVE (only clear noise)

| Category | Examples |
|----------|----------|
| Exact duplicates | Same link/button with identical text appearing multiple times |
| Tracking/hidden | Tracking inputs, honeypots, display:none elements |
| Boilerplate | Cookie banners, "Accept all" popups |

# What to KEEP (err on side of keeping)

| Category | Examples |
|----------|----------|
| Main content | Article text, product info, search results, tables, lists |
| ALL buttons | Any button the user might want to click |
| ALL form fields | Any input, select, textarea the user might fill |
| Navigation | Site navigation, category links, pagination |
| Sidebar content | Related items, filters, categories |
| Footer links | Contact, help, sitemap (often useful) |

# Output Field Limits
- text: Main content (preserve structure with newlines)
- links: Up to 30 relevant links
- buttons: Up to 15 buttons
- inputs: Up to 15 form fields

# Summary Format (exactly 5 lines)
1. Purpose: <what this page is for>
2. Main content: <brief description or "None">
3. Primary actions: <key buttons or "None">
4. Navigation: <main navigation options or "None">
5. Forms: <form fields available or "None">`;

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
      message: `Distill this webpage for an AI agent.

Title: {{{title}}}
Text: {{{text}}}
Links: {{{linksJson}}}
Buttons: {{{buttonsJson}}}
Inputs: {{{inputsJson}}}

Keep content the agent needs to understand and interact with the page.
Extract: main content, up to 30 links, up to 15 buttons, up to 15 inputs.
Remove only exact duplicates and tracking elements. Err on side of keeping.
Produce exactly 5-line summary.`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};
