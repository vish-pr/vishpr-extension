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

# Critical Rules
MUST: Extract only content relevant to page purpose.
MUST: Follow exact limits (links≤10, buttons≤5, inputs≤5).
MUST: Produce exactly 5-line summary in specified format.

# What to REMOVE

| Category | Examples |
|----------|----------|
| Navigation | Headers, footers, sidebars, breadcrumbs |
| Legal/Policy | Terms, privacy, cookie notices |
| Marketing | Ads, promotions, newsletter signups |
| Duplicates | Same link/button appearing multiple times |
| Hidden | Tracking inputs, honeypots, display:none |

# What to KEEP

| Category | Examples |
|----------|----------|
| Main content | Article text, product descriptions, search results |
| Primary actions | Submit, Buy, Login, Search buttons |
| Core forms | Login fields, search box, checkout form |
| Navigation links | Links that advance the user's likely task |

# Output Field Limits
- text: Main content only (empty string if none)
- links: Max 10 most relevant to page purpose
- buttons: Max 5 primary action buttons
- inputs: Max 5 key form fields

# Summary Format (MANDATORY - exactly 5 lines)
1. Purpose: <what this page is for>
2. Main content: <brief description or "None">
3. Primary actions: <comma-separated buttons or "None">
4. Important links: <comma-separated or "None">
5. Forms/inputs: <comma-separated or "None">

# Examples

Product page summary:
1. Purpose: Product listing for wireless headphones
2. Main content: 5 headphone products with prices and ratings
3. Primary actions: Add to Cart, Buy Now
4. Important links: Product details, Reviews, Compare
5. Forms/inputs: Quantity selector

Login page summary:
1. Purpose: User authentication
2. Main content: None
3. Primary actions: Sign In, Create Account
4. Important links: Forgot Password
5. Forms/inputs: Email, Password`;

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

Extract: main content, top 10 links, top 5 buttons, top 5 inputs.
Produce exactly 5-line summary. Remove navigation, ads, legal content.`,
      intelligence: 'LOW',
      output_schema: OUTPUT_SCHEMA
    }
  ]
};
