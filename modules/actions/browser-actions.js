/**
 * Browser automation actions
 * Core actions for reading, clicking, navigating, form interactions, scrolling, and waiting
 * Includes Tier-2 browser action router for detailed browser action routing
 */

import { getBrowserState } from '../browser-state.js';
import { CHAT_RESPONSE } from './chat-action.js';

/**
 * Execute a script function in a tab
 */
async function executeScript(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return result[0].result;
}

/**
 * READ_PAGE action
 * Extracts page content including text, links, buttons, and form inputs
 */
export const READ_PAGE = {
  name: 'READ_PAGE',
  description: 'Extract page content including title, text, links, buttons, and form inputs. Use when you need to see what is on the page or find elements to interact with. Returns element IDs that are required for CLICK_ELEMENT, FILL_FORM, and other interaction actions.',
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
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const browserState = getBrowserState();
      return await browserState.extractAndStoreContent(params.tabId);
    }
  ]
};

/**
 * CLICK_ELEMENT action
 * Clicks an element on the page by element ID from READ_PAGE with optional modifiers
 */
export const CLICK_ELEMENT = {
  name: 'CLICK_ELEMENT',
  description: 'Click a button, link, or interactive element using its element ID from READ_PAGE. Supports modifiers: newTab (open in background tab), newTabActive (open in foreground tab), download (download instead of navigate). Requires elementId from READ_PAGE results.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      elementId: {
        type: 'number',
        description: 'Element ID from READ_PAGE (e.g., 5 for the element with id: 5 in the links, buttons, or inputs array)'
      },
      newTab: {
        type: 'boolean',
        description: 'Open link in new background tab (Ctrl/Cmd+Click). Default: false'
      },
      newTabActive: {
        type: 'boolean',
        description: 'Open link in new foreground tab (Ctrl/Cmd+Shift+Click). Default: false'
      },
      download: {
        type: 'boolean',
        description: 'Download the link instead of navigating (Alt+Click). Default: false'
      },
      justification: {
        type: 'string',
        description: 'Why clicking this element'
      }
    },
    required: ['tabId', 'elementId'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const browserState = getBrowserState();
      const modifiers = {
        newTab: params.newTab || false,
        newTabActive: params.newTabActive || false,
        download: params.download || false
      };
      return await browserState.clickElement(params.tabId, params.elementId, modifiers);
    }
  ]
};

/**
 * NAVIGATE_TO action
 * Navigates the current tab to a new URL
 */
export const NAVIGATE_TO = {
  name: 'NAVIGATE_TO',
  description: 'Navigate the browser to a specific URL. Use when user provides a URL or you need to go to a known address. Requires full URL with protocol (e.g., https://example.com).',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      url: {
        type: 'string',
        description: 'URL to navigate to (must include protocol like https://)'
      },
      justification: {
        type: 'string',
        description: 'Why navigating to this URL'
      }
    },
    required: ['tabId', 'url'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const browserState = getBrowserState();
      return await browserState.navigateTo(params.tabId, params.url);
    }
  ]
};

/**
 * GET_PAGE_STATE action
 * Gets current page state including scroll position and viewport info
 */
export const GET_PAGE_STATE = {
  name: 'GET_PAGE_STATE',
  description: 'Get current page state including scroll position (scroll_x, scroll_y), viewport dimensions, total page size, and load status. Use to check if page is fully loaded or to determine scroll position before scrolling.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      justification: {
        type: 'string',
        description: 'Why getting page state'
      }
    },
    required: ['tabId'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      return await executeScript(
        params.tabId,
        () => {
          return {
            scroll_y: window.scrollY,
            scroll_x: window.scrollX,
            viewport_height: window.innerHeight,
            viewport_width: window.innerWidth,
            page_height: document.documentElement.scrollHeight,
            page_width: document.documentElement.scrollWidth,
            loaded: document.readyState === 'complete'
          };
        }
      );
    }
  ]
};

/**
 * FILL_FORM action
 * Fills multiple form fields and optionally submits the form
 */
export const FILL_FORM = {
  name: 'FILL_FORM',
  description: 'Fill one or more form input fields with values. Requires form_fields array with [{elementId, value}] where elementId comes from READ_PAGE. Can optionally submit the form by setting submit=true and providing submit_element_id.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      form_fields: {
        type: 'array',
        description: 'Array of form fields to fill',
        items: {
          type: 'object',
          properties: {
            elementId: { type: 'number', description: 'Element ID from READ_PAGE for the input field' },
            value: { type: 'string', description: 'Value to set' }
          },
          additionalProperties: false
        }
      },
      submit: {
        type: 'boolean',
        description: 'Whether to submit the form after filling'
      },
      submit_element_id: {
        type: 'number',
        description: 'Element ID from READ_PAGE for submit button (required if submit=true)'
      },
      justification: {
        type: 'string',
        description: 'Why filling this form'
      }
    },
    required: ['tabId', 'form_fields'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const browserState = getBrowserState();
      return await browserState.fillForm(
        params.tabId,
        params.form_fields,
        params.submit || false,
        params.submit_element_id
      );
    }
  ]
};

/**
 * SELECT_OPTION action
 * Selects an option in a dropdown/select element
 */
export const SELECT_OPTION = {
  name: 'SELECT_OPTION',
  description: 'Select an option from a dropdown/select element. Requires elementId of the select element from READ_PAGE and the value or visible text of the option to select.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      elementId: {
        type: 'number',
        description: 'Element ID from READ_PAGE for the select element'
      },
      value: {
        type: 'string',
        description: 'Value or text of the option to select'
      },
      justification: {
        type: 'string',
        description: 'Why selecting this option'
      }
    },
    required: ['tabId', 'elementId', 'value'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      return await executeScript(
        params.tabId,
        (elementId, value) => {
          const select = document.querySelector(`[data-vish-id="${elementId}"]`);
          if (!select || select.tagName !== 'SELECT') {
            return { selected: false, error: 'Select element not found' };
          }

          // Try to find option by value or text
          let option = Array.from(select.options).find(opt =>
            opt.value === value || opt.text === value
          );

          if (option) {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return {
              selected: true,
              elementId,
              value: option.value,
              text: option.text
            };
          }

          return { selected: false, error: 'Option not found' };
        },
        [params.elementId, params.value]
      );
    }
  ]
};

/**
 * CHECK_CHECKBOX action
 * Checks or unchecks a checkbox
 */
export const CHECK_CHECKBOX = {
  name: 'CHECK_CHECKBOX',
  description: 'Check or uncheck a checkbox input. Requires elementId from READ_PAGE and checked (true to check, false to uncheck).',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      elementId: {
        type: 'number',
        description: 'Element ID from READ_PAGE for the checkbox'
      },
      checked: {
        type: 'boolean',
        description: 'Whether to check (true) or uncheck (false)'
      },
      justification: {
        type: 'string',
        description: 'Why modifying this checkbox'
      }
    },
    required: ['tabId', 'elementId', 'checked'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      return await executeScript(
        params.tabId,
        (elementId, shouldCheck) => {
          const checkbox = document.querySelector(`[data-vish-id="${elementId}"]`);
          if (!checkbox || checkbox.type !== 'checkbox') {
            return { modified: false, error: 'Checkbox not found' };
          }

          if (checkbox.checked !== shouldCheck) {
            checkbox.checked = shouldCheck;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            return { modified: true, checked: shouldCheck };
          }

          return { modified: false, checked: shouldCheck, note: 'Already in desired state' };
        },
        [params.elementId, params.checked]
      );
    }
  ]
};

/**
 * SUBMIT_FORM action
 * Submits a form by clicking a submit button or calling form.submit()
 */
export const SUBMIT_FORM = {
  name: 'SUBMIT_FORM',
  description: 'Submit a form by clicking a submit button or triggering form submission. Requires elementId of a submit button or form element from READ_PAGE.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      elementId: {
        type: 'number',
        description: 'Element ID from READ_PAGE for submit button or form element'
      },
      justification: {
        type: 'string',
        description: 'Why submitting this form'
      }
    },
    required: ['tabId', 'elementId'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      return await executeScript(
        params.tabId,
        (elementId) => {
          const element = document.querySelector(`[data-vish-id="${elementId}"]`);
          if (!element) {
            return { submitted: false, error: 'Element not found' };
          }

          // If it's a button, click it
          if (element.tagName === 'BUTTON' || element.tagName === 'INPUT') {
            element.click();
            return { submitted: true, method: 'click' };
          }

          // If it's a form, submit it
          if (element.tagName === 'FORM') {
            element.submit();
            return { submitted: true, method: 'submit' };
          }

          return { submitted: false, error: 'Element is not a form or submit button' };
        },
        [params.elementId]
      );
    }
  ]
};

/**
 * SCROLL_TO action
 * Scrolls the page in a specified direction or to a specific position
 */
export const SCROLL_TO = {
  name: 'SCROLL_TO',
  description: 'Scroll the page in a direction. Requires direction: "up", "down", "top", or "bottom". Optional pixels parameter (default 500) for up/down. Optional wait_ms (default 500) to wait for content to load after scrolling.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      direction: {
        type: 'string',
        description: 'Scroll direction: "up", "down", "top", "bottom"',
        enum: ['up', 'down', 'top', 'bottom']
      },
      pixels: {
        type: 'number',
        description: 'Number of pixels to scroll (for up/down). Default: 500'
      },
      wait_ms: {
        type: 'number',
        description: 'Milliseconds to wait after scrolling for content to load. Default: 500'
      },
      justification: {
        type: 'string',
        description: 'Why scrolling'
      }
    },
    required: ['tabId', 'direction'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const browserState = getBrowserState();
      return await browserState.scrollAndWait(
        params.tabId,
        params.direction,
        params.pixels || 500,
        params.wait_ms || 500
      );
    }
  ]
};

/**
 * WAIT_FOR_LOAD action
 * Waits for page to fully load
 */
export const WAIT_FOR_LOAD = {
  name: 'WAIT_FOR_LOAD',
  description: 'Wait for the page to finish loading (document.readyState === "complete"). Use after navigation or clicking links that cause page loads. Optional timeout_ms (default 10000).',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds. Default: 10000'
      },
      justification: {
        type: 'string',
        description: 'Why waiting for page load'
      }
    },
    required: ['tabId'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const timeout = params.timeout_ms || 10000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        try {
          const result = await executeScript(
            params.tabId,
            () => ({
              loaded: document.readyState === 'complete',
              ready_state: document.readyState
            })
          );

          if (result.loaded) {
            return result;
          }
        } catch (error) {
          // Tab might be navigating, wait and retry
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return {
        loaded: false,
        ready_state: 'timeout',
        error: 'Timeout waiting for page load'
      };
    }
  ]
};

/**
 * WAIT_FOR_ELEMENT action
 * Waits for a specific element to appear on the page
 */
export const WAIT_FOR_ELEMENT = {
  name: 'WAIT_FOR_ELEMENT',
  description: 'Wait for a specific element to appear on the page. Use when expecting dynamic content to load. Requires elementId from a previous READ_PAGE. Optional timeout_ms (default 5000).',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      elementId: {
        type: 'number',
        description: 'Element ID from READ_PAGE for the element to wait for'
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds. Default: 5000'
      },
      justification: {
        type: 'string',
        description: 'Why waiting for this element'
      }
    },
    required: ['tabId', 'elementId'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const timeout = params.timeout_ms || 5000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const result = await executeScript(
          params.tabId,
          (elementId) => {
            const element = document.querySelector(`[data-vish-id="${elementId}"]`);
            return {
              found: !!element,
              elementId,
              visible: element ? (element.offsetParent !== null) : false
            };
          },
          [params.elementId]
        );

        if (result.found) {
          return result;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return {
        found: false,
        elementId: params.elementId,
        error: 'Timeout waiting for element'
      };
    }
  ]
};

/**
 * GO_BACK action
 * Go back one page in browser history
 */
export const GO_BACK = {
  name: 'GO_BACK',
  description: 'Navigate back one page in browser history. Use when user wants to go back or undo a navigation.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      justification: {
        type: 'string',
        description: 'Why going back'
      }
    },
    required: ['tabId'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const browserState = getBrowserState();
      return await browserState.goBack(params.tabId);
    }
  ]
};

/**
 * GO_FORWARD action
 * Go forward one page in browser history
 */
export const GO_FORWARD = {
  name: 'GO_FORWARD',
  description: 'Navigate forward one page in browser history. Use after GO_BACK to return to a page.',
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Tab ID'
      },
      justification: {
        type: 'string',
        description: 'Why going forward'
      }
    },
    required: ['tabId'],
    additionalProperties: false
  },
  steps: [
    async (params) => {
      const browserState = getBrowserState();
      return await browserState.goForward(params.tabId);
    }
  ]
};

/**
 * Export all browser actions (including form and navigation actions)
 */
export const browserActions = [
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
 * Detailed browser action routing with full action schema
 * Called when BROWSER_ACTION is chosen from tier-1 router
 */
export const BROWSER_ACTION = 'BROWSER_ACTION';

const BROWSER_ACTION_SYSTEM_PROMPT = `You are a browser automation assistant. Execute actions on web pages by calling tools.

**Workflow:**
1. Start with READ_PAGE to see page content
2. Use element IDs from READ_PAGE for clicks/forms
3. Chain actions: READ_PAGE -> FILL_FORM -> CLICK_ELEMENT -> WAIT_FOR_LOAD
4. Call CHAT_RESPONSE when task is complete

**Element IDs:** READ_PAGE assigns numeric IDs to elements. Use these IDs (not CSS selectors) for CLICK_ELEMENT, FILL_FORM, etc.

Always call a tool.`;

/**
 * Browser action router (Tier-2)
 * Handles detailed browser automation with full action choices
 */
export const browserActionRouter = {
  name: BROWSER_ACTION,
  description: 'Interact with web pages - read content, click elements, fill forms, navigate URLs, scroll, and wait for page loads. Use when the user wants to read page content, click buttons/links, fill inputs, navigate to URLs, or perform any browser interaction.',
  examples: [
    'What is this page?',
    'Click the login button',
    'Fill in my email'
  ],
  input_schema: {
    type: 'object',
    properties: {
      user_message: {
        type: 'string',
        description: 'The user\'s natural language request'
      },
      instructions: {
        type: 'string',
        description: 'Detailed instructions from router about what to accomplish'
      }
    },
    required: ['user_message'],
    additionalProperties: false
  },
  output_schema: {
    type: 'object',
    properties: {
      response: { type: 'string' },
      success: { type: 'boolean' }
    },
    additionalProperties: false
  },
  steps: [
    {
      llm: {
        system_prompt: BROWSER_ACTION_SYSTEM_PROMPT,
        message: `User request: {{user_message}}
{{#instructions}}
Instructions: {{instructions}}
{{/instructions}}
Execute the appropriate browser actions. The browser state shows current page content if available.`,
        intelligence: 'MEDIUM'
      },
      choice: {
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
          CHAT_RESPONSE
        ],
        stop_action: CHAT_RESPONSE,
        max_iterations: 7
      },
      use_full_browser_state: true
    }
  ]
};
