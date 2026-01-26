/**
 * Browser automation actions
 * Uses chrome-api for browser operations, returns uniform { result } shape
 */
import type { Action, Message, StepContext, StepResult, JSONSchema } from './types/index.js';
import { getChromeAPI } from '../chrome-api.js';
import { FINAL_RESPONSE_ACTION } from './final-response-action.js';
import { CONTEXT_SELECTOR_ACTION } from './context-selector-action.js';
import { USER_CLARIFICATION_ACTION } from './clarification-actions.js';
import { getActionStatsCounter } from '../debug/time-bucket-counter.js';

// Schema for LLM content cleaning output
const CLEAN_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    html: { type: 'string', description: 'Cleaned HTML preserving structure. Remove redundancy, keep meaning.' },
    summary: { type: 'string', description: '3-line summary: purpose, main content, key actions' }
  },
  required: ['html', 'summary'],
  additionalProperties: false
};

const CLEAN_SYSTEM_PROMPT = `You are an HTML cleaner for a browser automation agent. You remove noise while preserving structure and meaning.

# Rules

MUST preserve:
- Semantic HTML (headings, lists, tables, articles, sections)
- All text that conveys information
- Interactive elements with data-vish-id (agent uses these IDs to click/fill)
- State attributes (aria-*, data-state, checked, selected)

MUST remove:
- Exact duplicate text (same phrase appearing multiple times)
- Boilerplate (cookie banners, "Accept all", copyright notices)
- Empty elements with no content
- Filler text ("Loading...", "Please wait", placeholders)

NEVER:
- Summarize content - output is cleaned HTML, not a summary
- Remove elements with data-vish-id (agent needs these for interaction)
- Change the document structure or hierarchy

# Output

| Field | Description |
|-------|-------------|
| html | Cleaned HTML. Full content, less noise. Links/buttons/inputs are inline with data-vish-id. |
| summary | 3 lines: purpose, main content, key actions |

# Examples

Input: <div><p>Welcome</p><p>Welcome</p><p>Click here to continue</p></div>
Output html: <div><p>Welcome</p><p>Click here to continue</p></div>
Why: Removed exact duplicate "Welcome"

Input: <div class="cookie">Accept cookies</div><article>Real content</article>
Output html: <article>Real content</article>
Why: Removed cookie banner boilerplate`;

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
    if (!content.summary || content._compressed) return msg;

    // Replace with compressed version
    return {
      ...msg,
      content: JSON.stringify({
        tabId: content.tabId,
        url: content.url,
        _compressed: true,
        summary: content.summary
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
            ? raw.debugLog.map((p: { phase: string; sizeAfter: number }) => `${p.phase}:${p.sizeAfter}`).join(', ')
            : 'no-debug';
          console.warn(`[READ_PAGE] text fallback | raw=${raw.rawHtmlSize} final=${raw.byteSize} | ${raw.url}\n  phases: ${debugInfo}`);
        } else {
          console.log(`[READ_PAGE] html mode | raw=${raw.rawHtmlSize} cleaned=${raw.byteSize} | ${raw.url}`);
        }

        // Track content mode usage
        const stats = getActionStatsCounter();
        stats.increment('READ_PAGE', raw.contentMode === 'html' ? 'html_mode' : 'text_fallback').catch(() => {});

        return {
          result: {
            url: raw.url,
            title: raw.title,
            contentMode: raw.contentMode,
            content: raw.content
          }
        };
      }
    },
    // Step 2: LLM cleans HTML (removes redundancy, preserves structure)
    {
      type: 'llm',
      system_prompt: CLEAN_SYSTEM_PROMPT,
      message: `Clean this HTML. Remove redundancy, preserve structure and meaning.

Title: {{{title}}}
HTML: {{{content}}}

Output cleaned HTML. Interactive elements have data-vish-id inline.`,
      intelligence: 'MEDIUM',
      output_schema: CLEAN_OUTPUT_SCHEMA
    },
    // Step 3: Format final result
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const chrome = getChromeAPI();

        chrome.updateTabContent(ctx.tabId, {
          raw: { title: ctx.title, html: ctx.html },
          summary: ctx.summary
        });

        const result: Record<string, unknown> = {
          tabId: ctx.tabId,
          url: ctx.url,
          title: ctx.title,
          summary: ctx.summary,
          html: ctx.html
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
 * SWITCH_TAB action
 */
export const SWITCH_TAB: Action = {
  name: 'SWITCH_TAB',
  description: 'Switch focus to an existing browser tab without changing its URL.',
  examples: [
    'Switch to tab 123',
    'Focus the other tab'
  ],
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Tab ID to switch to' },
      justification: { type: 'string', description: 'Why switching tabs' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const result = await chrome.switchTab(ctx.tabId);
        return { result };
      }
    }
  ]
};

/**
 * CHANGE_TAB_URL action
 */
export const CHANGE_TAB_URL: Action = {
  name: 'CHANGE_TAB_URL',
  description: 'Change the URL of an existing tab. Use when you want to navigate within the same tab.',
  examples: [
    'Go to https://google.com in this tab',
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
 * OPEN_URL_IN_NEW_TAB action
 */
export const OPEN_URL_IN_NEW_TAB: Action = {
  name: 'OPEN_URL_IN_NEW_TAB',
  description: 'Open a URL in a new browser tab.',
  examples: [
    'Open https://google.com in a new tab',
    'Open this link in new tab'
  ],
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open' },
      active: { type: 'boolean', description: 'Whether to focus the new tab (default: true)' },
      justification: { type: 'string', description: 'Why opening in new tab' }
    },
    required: ['url'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const result = await chrome.openInNewTab(ctx.url, ctx.active ?? true);
        return { result };
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
  description: 'Navigate back one page in browser history. Response includes canGoBack and canGoForward to indicate if further navigation is possible.',
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
  description: 'Navigate forward one page in browser history. Response includes canGoBack and canGoForward to indicate if further navigation is possible.',
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
  SWITCH_TAB,
  CHANGE_TAB_URL,
  OPEN_URL_IN_NEW_TAB,
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
 * BROWSER_ACTION_ROUTER - Tier-2 Router
 */
export const BROWSER_ACTION_ROUTER: Action = {
  name: 'BROWSER_ACTION',
  description: 'Interact with web pages: read content, click elements, fill forms, navigate, scroll',
  examples: [
    'What is this page?',
    'Click the login button',
    'Fill in my email'
  ],
  input_schema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The goal to accomplish'
      }
    },
    required: ['goal'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'llm',
      system_prompt: `You are an autonomous browser interaction agent.
You must accomplish the user's GOAL by navigating web pages and interacting with elements using tools.

────────────────────────────────────────
CORE PRINCIPLES
────────────────────────────────────────
• You operate ONLY through the provided tools
• You NEVER invent state, IDs, tabs, URLs, or outcomes
• You NEVER output internal reasoning, justification, or metadata
• You ONLY output tool calls or FINAL_RESPONSE is last tool call to return output to user.
• If the goal is ambiguous, request clarification via USER_CLARIFICATION_ACTION.

────────────────────────────────────────
AUTONOMOUS NAVIGATION RULE (CRITICAL)
────────────────────────────────────────
If the user's goal requires web content AND no page is currently loaded:
→ YOU MUST CHANGE_TAB_URL or OPEN_URL_IN_NEW_TAB to an appropriate public website before any READ_PAGE.

Examples:
• Goal: "play music" → navigate to a music streaming site
• Goal: "search for shoes" → navigate to a shopping site
• Goal: "check email" → navigate to a webmail provider

────────────────────────────────────────
CRITICAL RULE
────────────────────────────────────────
MUST call READ_PAGE to obtain element IDs before ANY interaction
(click, fill, select, check, submit).

NEVER guess or invent element IDs.
Element IDs ONLY come from the most recent READ_PAGE.

────────────────────────────────────────
TOOLS
────────────────────────────────────────

{{{decisionGuide}}}

────────────────────────────────────────
WORKFLOW RULES
────────────────────────────────────────
MUST:
• CHANGE_TAB_URL or OPEN_URL_IN_NEW_TAB if no page context exists and goal requires content
• READ_PAGE before ANY interaction
• Use elementId from MOST RECENT READ_PAGE
• Use FINAL_RESPONSE when task is complete or blocked or you have gathered data for request and need to format or present it to the user

SHOULD:
• READ_PAGE again after navigation or major UI change
• Verify success with READ_PAGE if uncertain

NEVER:
• Click or fill without READ_PAGE
• Invent element IDs, URLs, or tabs
• Loop more than 2 times on the same failed action

────────────────────────────────────────
ERROR HANDLING
────────────────────────────────────────
• If element not found → READ_PAGE again
• If same error occurs twice → FINAL_RESPONSE with error
• If interaction fails → try an alternative valid approach

────────────────────────────────────────
INTENT MAPPING
────────────────────────────────────────
"What is on this page?" → READ_PAGE
"Show page content" → READ_PAGE
"Go to https://example.com" → CHANGE_TAB_URL
"Open https://example.com in new tab" → OPEN_URL_IN_NEW_TAB
"Switch to tab 123" → SWITCH_TAB
"Click the login button" → READ_PAGE → CLICK_ELEMENT
"Search for 'laptop'" → READ_PAGE → FILL_FORM → SUBMIT_FORM
"Finish" / "Done" / "Return result" → FINAL_RESPONSE

────────────────────────────────────────
REMINDER
────────────────────────────────────────
If no element IDs are available, READ_PAGE.
If no page exists, use CHANGE_TAB_URL or OPEN_URL_IN_NEW_TAB first.
Use FINAL_RESPONSE to terminate.`,
      message: `Execute browser interaction.

Context:
{{{context}}}

<current_browser_tabs>
{{{browser_state}}}
</current_browser_tabs>

Goal: {{{goal}}}

If no element IDs available, READ_PAGE first. Use {{{stop_action}}} when done or after 2 failed attempts.`,
      continuation_message: `Previous action completed. Review the result above.

<current_browser_tabs>
{{{browser_state}}}
</current_browser_tabs>

Original goal was: {{{goal}}}

Decision:
- If the goal is FULLY satisfied by the previous result or all information is collected to slove user query → use {{{stop_action}}}
- Else select the MOST APPROPRIATE tool to continue progress towards the goal.
- If you encountered an error in the previous action, try ONE alternative approach.
- If you encounter the SAME error AGAIN, use {{{stop_action}}} to report the issue.`,
      intelligence: 'HIGH',
      tool_choice: {
        available_actions: [
          USER_CLARIFICATION_ACTION.name,
          READ_PAGE.name,
          CLICK_ELEMENT.name,
          FILL_FORM.name,
          SELECT_OPTION.name,
          CHECK_CHECKBOX.name,
          SUBMIT_FORM.name,
          SWITCH_TAB.name,
          CHANGE_TAB_URL.name,
          OPEN_URL_IN_NEW_TAB.name,
          SCROLL_TO.name,
          WAIT_FOR_LOAD.name,
          WAIT_FOR_ELEMENT.name,
          GO_BACK.name,
          GO_FORWARD.name,
          FINAL_RESPONSE_ACTION.name
        ],
        stop_action: FINAL_RESPONSE_ACTION.name,
        max_iterations: 7
      }
    }
  ]
};
