/**
 * Browser automation actions
 * Uses chrome-api for browser operations, returns uniform { result } shape
 */
import type { Action, Message, StepContext, StepResult } from './types/index.js';
import { getChromeAPI } from '../chrome-api.js';
import { FINAL_RESPONSE } from './final-response-action.js';
import { CLEAN_CONTENT } from './clean-content-action.js';

interface BrowserContext extends StepContext {
  tabId: number;
  url?: string;
  title?: string;
  text?: string;
  links?: Array<{ id: string; text: string }>;
  buttons?: Array<{ id: string; text: string }>;
  inputs?: Array<{ id: string; text: string }>;
  summary?: string;
  elementId?: number;
  direction?: 'up' | 'down' | 'top' | 'bottom';
  pixels?: number;
  wait_ms?: number;
  timeout_ms?: number;
  form_fields?: Array<{ elementId: number; value: string }>;
  submit?: boolean;
  submit_element_id?: number;
  value?: string;
  checked?: boolean;
  newTab?: boolean;
  newTabActive?: boolean;
  download?: boolean;
}

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
 * Extracts page content, cleans it via CLEAN_CONTENT, compresses previous reads
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
    additionalProperties: true // There are things available in context
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const chrome = getChromeAPI();
        const raw = await chrome.extractContent((ctx as BrowserContext).tabId);
        const url = chrome.getTab((ctx as BrowserContext).tabId)?.url;
        return { result: { url, ...raw } };
      }
    },
    { type: 'action', action: CLEAN_CONTENT },
    {
      type: 'function',
      handler: (ctx: StepContext): StepResult => {
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        chrome.updateTabContent(c.tabId, {
          raw: { title: c.title, text: c.text, links: c.links, buttons: c.buttons, inputs: c.inputs },
          summary: c.summary
        });
        const result = {
          tabId: c.tabId,
          url: c.url,
          title: c.title,
          text: c.text,
          links: c.links,
          buttons: c.buttons,
          inputs: c.inputs,
          _summary: c.summary
        };
        const updatedParentMessages = compressPreviousReads(c.parent_messages);
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const clickResult = await chrome.clickElement(c.tabId, c.elementId!, {
          newTab: c.newTab || false,
          newTabActive: c.newTabActive || false,
          download: c.download || false
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
        const c = ctx as BrowserContext & { url: string };
        const chrome = getChromeAPI();
        const navResult = await chrome.navigateTo(c.tabId, c.url);
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
        const stateResult = await chrome.getPageState((ctx as BrowserContext).tabId);
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const fillResult = await chrome.fillForm(
          c.tabId,
          c.form_fields!,
          c.submit || false,
          c.submit_element_id
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const selectResult = await chrome.selectOption(c.tabId, c.elementId!, c.value!);
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const checkResult = await chrome.checkCheckbox(c.tabId, c.elementId!, c.checked!);
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const submitResult = await chrome.submitForm(c.tabId, c.elementId!);
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const scrollResult = await chrome.scrollAndWait(
          c.tabId,
          c.direction!,
          c.pixels || 500,
          c.wait_ms || 500
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const loadResult = await chrome.waitForLoad(c.tabId, c.timeout_ms || 10000);
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
        const c = ctx as BrowserContext;
        const chrome = getChromeAPI();
        const waitResult = await chrome.waitForElement(c.tabId, c.elementId!, c.timeout_ms || 5000);
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
        const backResult = await chrome.goBack((ctx as BrowserContext).tabId);
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
        const forwardResult = await chrome.goForward((ctx as BrowserContext).tabId);
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

# Tools
- READ_PAGE: Get content and element IDs
- CLICK_ELEMENT: Click elements (requires elementId)
- FILL_FORM: Fill inputs (requires elementId)
- NAVIGATE_TO: Go to URL
- SCROLL_TO: Scroll page
- SELECT_OPTION, CHECK_CHECKBOX, SUBMIT_FORM: Form actions
- WAIT_FOR_LOAD, WAIT_FOR_ELEMENT: Wait for state
- GO_BACK, GO_FORWARD: History navigation
- FINAL_RESPONSE: Task complete

# Rules
MUST:
- READ_PAGE first to get element IDs before any interaction
- Use elementIds from READ_PAGE for clicks/fills

SHOULD:
- Wait after navigation for page load
- Verify actions completed via READ_PAGE

{{{decisionGuide}}}`,
      message: `Execute browser interaction.

Browser: {{{browser_state}}}
Goal: {{{instructions}}}

Select appropriate tool. Use {{{stop_action}}} when task complete.`,
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
