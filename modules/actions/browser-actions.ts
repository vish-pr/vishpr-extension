/**
 * Browser automation actions
 * Uses chrome-api for browser operations, returns uniform { result } shape
 */
import type { Action, Message, StepContext, StepResult, JSONSchema } from './types/index.js';
import { getChromeAPI } from '../chrome-api.js';
import { FINAL_RESPONSE } from './final-response-action.js';
import { getActionStatsCounter } from '../debug/time-bucket-counter.js';

// Schema for LLM content cleaning output
const ELEMENT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, text: { type: 'string' } },
  required: ['id', 'text'],
  additionalProperties: false
};

const CLEAN_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'Cleaned main content, noise removed' },
    links: { type: 'array', items: ELEMENT_SCHEMA, description: 'Relevant links (max 30)' },
    buttons: { type: 'array', items: ELEMENT_SCHEMA, description: 'Action buttons (max 15)' },
    inputs: { type: 'array', items: ELEMENT_SCHEMA, description: 'Form fields (max 15)' },
    summary: { type: 'string', description: '5-line summary of page content and purpose' }
  },
  required: ['content', 'links', 'buttons', 'inputs', 'summary'],
  additionalProperties: false
};

const CLEAN_SYSTEM_PROMPT = `You distill webpage content for an AI agent that needs to understand and interact with the page.

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
- content: Main content (preserve structure with newlines)
- links: Up to 30 relevant links
- buttons: Up to 15 buttons
- inputs: Up to 15 form fields

# Summary Format (exactly 5 lines)
1. Purpose: <what this page is for>
2. Main content: <brief description or "None">
3. Primary actions: <key buttons or "None">
4. Navigation: <main navigation options or "None">
5. Forms: <form fields available or "None">`;

/**
 * Compress previous READ_PAGE results in messages
 * Replaces full content with summary for all previous READ_PAGE tool responses
 */
function compressPreviousReads(parent_messages: Message[] | undefined): Message[] | undefined {
  if (!parent_messages || !Array.isArray(parent_messages)) return parent_messages;

  return parent_messages.map(msg => {
    if (msg.role !== 'tool') return msg;

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content as string);
    } catch {
      return msg;
    }

    // Skip if not a READ_PAGE result or already compressed
    if (!content._summary || content._compressed) return msg;

    // Replace with compressed version
    return {
      ...msg,
      content: JSON.stringify({
        tabId: content.tabId,
        url: content.url,
        _compressed: true,
        summary: content._summary
      })
    };
  });
}

/**
 * READ_PAGE action
 * Extracts page content via cleanDOM in content script, then LLM cleans/summarizes
 */
export const READ_PAGE: Action = {
  name: 'READ_PAGE',
  description: 'Extract page content including title, text, links, buttons, and form inputs. Use when you need to see what is on the page or find elements to interact with. Returns element IDs that are required for CLICK_ELEMENT, FILL_FORM, and other interaction actions.',
  examples: [
    'What is on this page?',
    'Show me the page content'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID to extract content from'
      },
      justification: {
        type: 'string',
        description: 'Why extracting page content'
      }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    // Step 1: Extract content (cleanDOM runs in content script)
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const raw = await chrome.extractContent(ctx.tabId);

        // Log mode and stats
        if (raw.contentMode === 'text') {
          const debugInfo = raw.debugLog?.length
            ? raw.debugLog.slice(-3).map((p: { phase: string; sizeAfter: number }) => `${p.phase}:${p.sizeAfter}`).join(',')
            : 'no-debug';
          console.warn(`[READ_PAGE] text fallback | raw=${raw.rawHtmlSize} final=${raw.byteSize} phases=${raw.debugLog?.length ?? 0} | last3=[${debugInfo}] | ${raw.url}`);
        } else {
          console.log(`[READ_PAGE] html mode | raw=${raw.rawHtmlSize} cleaned=${raw.byteSize} | ${raw.url}`);
        }

        // Track content mode usage
        const stats = getActionStatsCounter();
        stats.increment('READ_PAGE', raw.contentMode === 'html' ? 'html_mode' : 'text_fallback').catch(() => {});

        // Merge all form inputs for LLM
        const allInputs = [...raw.inputs, ...raw.selects, ...raw.textareas];

        return {
          result: {
            url: raw.url,
            title: raw.title,
            contentMode: raw.contentMode,
            content: raw.content,
            linksJson: JSON.stringify(raw.links, null, 2),
            buttonsJson: JSON.stringify(raw.buttons, null, 2),
            inputsJson: JSON.stringify(allInputs, null, 2)
          }
        };
      }
    },
    // Step 2: LLM cleans and summarizes content
    {
      type: 'llm',
      system_prompt: CLEAN_SYSTEM_PROMPT,
      message: `Distill this webpage for an AI agent.

Title: {{{title}}}
Content: {{{content}}}
Links: {{{linksJson}}}
Buttons: {{{buttonsJson}}}
Inputs: {{{inputsJson}}}

Keep content the agent needs to understand and interact with the page.
Extract: main content, up to 30 links, up to 15 buttons, up to 15 inputs.
Remove only exact duplicates and tracking elements. Err on side of keeping.
Produce exactly 5-line summary.`,
      intelligence: 'LOW',
      output_schema: CLEAN_OUTPUT_SCHEMA
    },
    // Step 3: Format final result
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const chrome = getChromeAPI();

        chrome.updateTabContent(ctx.tabId, {
          raw: { title: ctx.title, content: ctx.content, links: ctx.links, buttons: ctx.buttons, inputs: ctx.inputs },
          summary: ctx.summary
        });

        const result: Record<string, unknown> = {
          tabId: ctx.tabId,
          url: ctx.url,
          title: ctx.title,
          summary: ctx.summary,
          content: ctx.content,
          links: ctx.links,
          buttons: ctx.buttons,
          inputs: ctx.inputs
        };

        const updatedParentMessages = compressPreviousReads(ctx.parent_messages);
        return { result, parent_messages: updatedParentMessages };
      }
    }
  ]
};

/**
 * CLICK_ELEMENT action
 */
export const CLICK_ELEMENT: Action = {
  name: 'CLICK_ELEMENT',
  description: 'Click a button, link, or interactive element using its element ID from READ_PAGE. Supports modifiers: newTab (open in background tab), newTabActive (open in foreground tab), download (download instead of navigate). Requires elementId from READ_PAGE results.',
  examples: [
    'Click the login button',
    'Open that link in a new tab'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      elementId: { type: 'number', description: 'Element ID from READ_PAGE' },
      newTab: { type: 'boolean', description: 'Open link in new background tab' },
      newTabActive: { type: 'boolean', description: 'Open link in new foreground tab' },
      download: { type: 'boolean', description: 'Download the link instead of navigating' },
      justification: { type: 'string', description: 'Why clicking this element' }
    },
    required: ['tabId', 'elementId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const clickResult = await chrome.clickElement(ctx.tabId, ctx.elementId, {
          newTab: ctx.newTab || false,
          newTabActive: ctx.newTabActive || false,
          download: ctx.download || false
        });
        return { result: clickResult };
      }
    }
  ]
};

/**
 * NAVIGATE_TO action
 */
export const NAVIGATE_TO: Action = {
  name: 'NAVIGATE_TO',
  description: 'Navigate the browser to a specific URL. Use when user provides a URL or you need to go to a known address.',
  examples: [
    'Go to https://google.com',
    'Navigate to https://github.com'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      url: { type: 'string', description: 'URL to navigate to' },
      justification: { type: 'string', description: 'Why navigating to this URL' }
    },
    required: ['tabId', 'url'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const navResult = await chrome.navigateTo(ctx.tabId, ctx.url);
        return { result: navResult };
      }
    }
  ]
};

/**
 * GET_PAGE_STATE action
 */
export const GET_PAGE_STATE: Action = {
  name: 'GET_PAGE_STATE',
  description: 'Get current page state including scroll position, viewport dimensions, total page size, and load status.',
  examples: [
    'Is the page fully loaded?',
    'Where am I on the page?'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      justification: { type: 'string', description: 'Why getting page state' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const stateResult = await chrome.getPageState(ctx.tabId);
        return { result: stateResult };
      }
    }
  ]
};

/**
 * FILL_FORM action
 */
export const FILL_FORM: Action = {
  name: 'FILL_FORM',
  description: 'Fill one or more form input fields with values. Requires form_fields array with [{elementId, value}] where elementId comes from READ_PAGE.',
  examples: [
    'Enter my email address',
    'Fill in the search box with "test"'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      form_fields: {
        type: 'array',
        description: 'Array of form fields to fill',
        items: {
          type: 'object',
          properties: {
            elementId: { type: 'number', description: 'Element ID from READ_PAGE' },
            value: { type: 'string', description: 'Value to set' }
          },
          additionalProperties: false
        }
      },
      submit: { type: 'boolean', description: 'Whether to submit the form after filling' },
      submit_element_id: { type: 'number', description: 'Element ID for submit button' },
      justification: { type: 'string', description: 'Why filling this form' }
    },
    required: ['tabId', 'form_fields'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const fillResult = await chrome.fillForm(
          ctx.tabId,
          ctx.form_fields,
          ctx.submit || false,
          ctx.submit_element_id
        );
        return { result: fillResult };
      }
    }
  ]
};

/**
 * SELECT_OPTION action
 */
export const SELECT_OPTION: Action = {
  name: 'SELECT_OPTION',
  description: 'Select an option from a dropdown/select element. Requires elementId of the select element and the value or text to select.',
  examples: [
    'Select "United States" from the country dropdown',
    'Choose the medium size option'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      elementId: { type: 'number', description: 'Element ID from READ_PAGE for the select element' },
      value: { type: 'string', description: 'Value or text of the option to select' },
      justification: { type: 'string', description: 'Why selecting this option' }
    },
    required: ['tabId', 'elementId', 'value'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const selectResult = await chrome.selectOption(ctx.tabId, ctx.elementId, ctx.value);
        return { result: selectResult };
      }
    }
  ]
};

/**
 * CHECK_CHECKBOX action
 */
export const CHECK_CHECKBOX: Action = {
  name: 'CHECK_CHECKBOX',
  description: 'Check or uncheck a checkbox input. Requires elementId from READ_PAGE and checked (true to check, false to uncheck).',
  examples: [
    'Check the terms and conditions box',
    'Uncheck the newsletter subscription'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      elementId: { type: 'number', description: 'Element ID from READ_PAGE for the checkbox' },
      checked: { type: 'boolean', description: 'Whether to check (true) or uncheck (false)' },
      justification: { type: 'string', description: 'Why modifying this checkbox' }
    },
    required: ['tabId', 'elementId', 'checked'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const checkResult = await chrome.checkCheckbox(ctx.tabId, ctx.elementId, ctx.checked);
        return { result: checkResult };
      }
    }
  ]
};

/**
 * SUBMIT_FORM action
 */
export const SUBMIT_FORM: Action = {
  name: 'SUBMIT_FORM',
  description: 'Submit a form by clicking a submit button or triggering form submission.',
  examples: [
    'Submit the form',
    'Press the submit button'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      elementId: { type: 'number', description: 'Element ID for submit button or form element' },
      justification: { type: 'string', description: 'Why submitting this form' }
    },
    required: ['tabId', 'elementId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const submitResult = await chrome.submitForm(ctx.tabId, ctx.elementId);
        return { result: submitResult };
      }
    }
  ]
};

/**
 * SCROLL_TO action
 */
export const SCROLL_TO: Action = {
  name: 'SCROLL_TO',
  description: 'Scroll the page in a direction. Requires direction: "up", "down", "top", or "bottom".',
  examples: [
    'Scroll down',
    'Go to the top of the page'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      direction: { type: 'string', description: 'Scroll direction', enum: ['up', 'down', 'top', 'bottom'] },
      pixels: { type: 'number', description: 'Number of pixels to scroll. Default: 500' },
      wait_ms: { type: 'number', description: 'Milliseconds to wait after scrolling. Default: 500' },
      justification: { type: 'string', description: 'Why scrolling' }
    },
    required: ['tabId', 'direction'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const scrollResult = await chrome.scrollAndWait(
          ctx.tabId,
          ctx.direction,
          ctx.pixels || 500,
          ctx.wait_ms || 500
        );
        return { result: scrollResult };
      }
    }
  ]
};

/**
 * WAIT_FOR_LOAD action
 */
export const WAIT_FOR_LOAD: Action = {
  name: 'WAIT_FOR_LOAD',
  description: 'Wait for the page to finish loading. Use after navigation or clicking links.',
  examples: [
    'Wait for the page to load',
    'Let the page finish loading'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      timeout_ms: { type: 'number', description: 'Maximum time to wait in milliseconds. Default: 10000' },
      justification: { type: 'string', description: 'Why waiting for page load' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const loadResult = await chrome.waitForLoad(ctx.tabId, ctx.timeout_ms || 10000);
        return { result: loadResult };
      }
    }
  ]
};

/**
 * WAIT_FOR_ELEMENT action
 */
export const WAIT_FOR_ELEMENT: Action = {
  name: 'WAIT_FOR_ELEMENT',
  description: 'Wait for a specific element to appear on the page. Requires elementId from a previous READ_PAGE.',
  examples: [
    'Wait for the search results to appear',
    'Wait until the modal shows up'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      elementId: { type: 'number', description: 'Element ID from READ_PAGE' },
      timeout_ms: { type: 'number', description: 'Maximum time to wait in milliseconds. Default: 5000' },
      justification: { type: 'string', description: 'Why waiting for this element' }
    },
    required: ['tabId', 'elementId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const waitResult = await chrome.waitForElement(ctx.tabId, ctx.elementId, ctx.timeout_ms || 5000);
        return { result: waitResult };
      }
    }
  ]
};

/**
 * GO_BACK action
 */
export const GO_BACK: Action = {
  name: 'GO_BACK',
  description: 'Navigate back one page in browser history.',
  examples: [
    'Go back',
    'Return to the previous page'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      justification: { type: 'string', description: 'Why going back' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const backResult = await chrome.goBack(ctx.tabId);
        return { result: backResult };
      }
    }
  ]
};

/**
 * GO_FORWARD action
 */
export const GO_FORWARD: Action = {
  name: 'GO_FORWARD',
  description: 'Navigate forward one page in browser history.',
  examples: [
    'Go forward',
    'Return to the page I was just on'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID' },
      justification: { type: 'string', description: 'Why going forward' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const forwardResult = await chrome.goForward(ctx.tabId);
        return { result: forwardResult };
      }
    }
  ]
};

/**
 * Export all browser actions
 */
export const browserActions: Action[] = [
  READ_PAGE,
  CLICK_ELEMENT,
  NAVIGATE_TO,
  GET_PAGE_STATE,
  FILL_FORM,
  SELECT_OPTION,
  CHECK_CHECKBOX,
  SUBMIT_FORM,
  SCROLL_TO,
  WAIT_FOR_LOAD,
  WAIT_FOR_ELEMENT,
  GO_BACK,
  GO_FORWARD
];

/**
 * BROWSER_ACTION - Tier-2 Router
 */
export const BROWSER_ACTION = 'BROWSER_ACTION';

export const browserActionRouter: Action = {
  name: BROWSER_ACTION,
  description: 'Interact with web pages: read content, click elements, fill forms, navigate, scroll',
  examples: [
    'What is this page?',
    'Click the login button',
    'Fill in my email'
  ],
  input_schema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description: 'Detailed instructions from router about what to accomplish'
      }
    },
    required: ['instructions'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'llm',
      system_prompt: `You automate browser interactions.

# Critical Rule
MUST call READ_PAGE first to get element IDs before ANY interaction (click, fill, select).
NEVER guess element IDs - they come only from READ_PAGE results.

# Tools

## Content & State
- READ_PAGE: Extract content, links, buttons, inputs with element IDs
- GET_PAGE_STATE: Check scroll position, viewport, load status

## Interaction (require elementId from READ_PAGE)
- CLICK_ELEMENT: Click button/link. Options: newTab, newTabActive, download
- FILL_FORM: Fill inputs. Format: form_fields=[{elementId, value}]
- SELECT_OPTION: Choose dropdown value
- CHECK_CHECKBOX: Set checked state (true/false)
- SUBMIT_FORM: Submit form by button/form element

## Navigation
- NAVIGATE_TO: Go to specific URL
- SCROLL_TO: Scroll direction (up/down/top/bottom)
- GO_BACK, GO_FORWARD: Browser history
- WAIT_FOR_LOAD: Wait for page load (after navigation)
- WAIT_FOR_ELEMENT: Wait for specific element

## Completion
- FINAL_RESPONSE: Task complete or error - terminate

# Workflow Rules

MUST:
- READ_PAGE before any click/fill/select action
- Use exact elementId from most recent READ_PAGE
- WAIT_FOR_LOAD after NAVIGATE_TO or CLICK_ELEMENT on links

SHOULD:
- READ_PAGE again after navigation to see new content
- Verify action success with READ_PAGE if uncertain

NEVER:
- Click/fill without prior READ_PAGE
- Invent or guess element IDs
- Loop more than 3 times on same action

# Error Handling
- If element not found, READ_PAGE again (page may have changed)
- If same error twice, use FINAL_RESPONSE to report issue
- If action fails after retry, try alternative approach or report

# Examples

Task: "Click the login button"
1. READ_PAGE → get buttons with IDs
2. CLICK_ELEMENT with login button's elementId

Task: "Search for 'laptop'"
1. READ_PAGE → find search input ID
2. FILL_FORM with [{elementId: X, value: "laptop"}]
3. READ_PAGE → find submit button
4. CLICK_ELEMENT or SUBMIT_FORM

Task: "Go to amazon.com and search"
1. NAVIGATE_TO url="https://amazon.com"
2. WAIT_FOR_LOAD
3. READ_PAGE → find search elements
4. FILL_FORM + SUBMIT_FORM

{{{decisionGuide}}}

# Reminder
READ_PAGE first for element IDs. Use FINAL_RESPONSE when done or stuck.`,
      message: `Execute browser interaction.

Browser: {{{browser_state}}}
Goal: {{{instructions}}}

If no element IDs available, READ_PAGE first. Use {{{stop_action}}} when done or after 2 failed attempts.`,
      continuation_message: `Previous action completed. Review the result above.

Browser: {{{browser_state}}}
Goal: {{{instructions}}}

Decision:
- If the goal is FULLY achieved → use {{{stop_action}}} immediately
- If more steps needed → select the next action

Do NOT repeat successful actions. Trust previous results.`,
      intelligence: 'MEDIUM',
      tool_choice: {
        available_actions: [
          READ_PAGE.name,
          CLICK_ELEMENT.name,
          FILL_FORM.name,
          SELECT_OPTION.name,
          CHECK_CHECKBOX.name,
          SUBMIT_FORM.name,
          NAVIGATE_TO.name,
          SCROLL_TO.name,
          WAIT_FOR_LOAD.name,
          WAIT_FOR_ELEMENT.name,
          GO_BACK.name,
          GO_FORWARD.name,
          FINAL_RESPONSE
        ],
        stop_action: FINAL_RESPONSE,
        max_iterations: 7
      }
    }
  ]
};
