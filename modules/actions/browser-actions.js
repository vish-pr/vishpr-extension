/**
 * Browser automation actions
 * Core actions for reading, clicking, navigating, form interactions, scrolling, and waiting
 */

import { getBrowserState } from '../browser-state.js';

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
 * Action name constants
 */
export const ACTION_READ_PAGE = 'READ_PAGE';
export const ACTION_CLICK_ELEMENT = 'CLICK_ELEMENT';
export const ACTION_NAVIGATE_TO = 'NAVIGATE_TO';
export const ACTION_GET_PAGE_STATE = 'GET_PAGE_STATE';
export const ACTION_FILL_FORM = 'FILL_FORM';
export const ACTION_SELECT_OPTION = 'SELECT_OPTION';
export const ACTION_CHECK_CHECKBOX = 'CHECK_CHECKBOX';
export const ACTION_SUBMIT_FORM = 'SUBMIT_FORM';
export const ACTION_SCROLL_TO = 'SCROLL_TO';
export const ACTION_WAIT_FOR_LOAD = 'WAIT_FOR_LOAD';
export const ACTION_WAIT_FOR_ELEMENT = 'WAIT_FOR_ELEMENT';
export const ACTION_GO_BACK = 'GO_BACK';
export const ACTION_GO_FORWARD = 'GO_FORWARD';

/**
 * READ_PAGE action
 * Extracts page content including text, links, buttons, and form inputs
 */
export const READ_PAGE = {
  name: ACTION_READ_PAGE,
  description: 'Extract page content including title, text, links, buttons, and form inputs',
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
    async (context) => {
      const browserState = getBrowserState();
      return await browserState.extractAndStoreContent(context.tabId);
    }
  ]
};

/**
 * CLICK_ELEMENT action
 * Clicks an element on the page by element ID from READ_PAGE with optional modifiers
 */
export const CLICK_ELEMENT = {
  name: ACTION_CLICK_ELEMENT,
  description: 'Click an element on the page using an element ID from READ_PAGE, with optional modifiers for opening in new tabs or downloading',
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
    async (context) => {
      const browserState = getBrowserState();
      const modifiers = {
        newTab: context.newTab || false,
        newTabActive: context.newTabActive || false,
        download: context.download || false
      };
      return await browserState.clickElement(context.tabId, context.elementId, modifiers);
    }
  ]
};

/**
 * NAVIGATE_TO action
 * Navigates the current tab to a new URL
 */
export const NAVIGATE_TO = {
  name: ACTION_NAVIGATE_TO,
  description: 'Navigate to a different URL',
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
    async (context) => {
      const browserState = getBrowserState();
      return await browserState.navigateTo(context.tabId, context.url);
    }
  ]
};

/**
 * GET_PAGE_STATE action
 * Gets current page state including scroll position and viewport info
 */
export const GET_PAGE_STATE = {
  name: ACTION_GET_PAGE_STATE,
  description: 'Get current page state including scroll position, viewport size, and load status',
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
    async (context) => {
      return await executeScript(
        context.tabId,
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
  name: ACTION_FILL_FORM,
  description: 'Fill multiple form fields with values and optionally submit',
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
    async (context) => {
      const browserState = getBrowserState();
      return await browserState.fillForm(
        context.tabId,
        context.form_fields,
        context.submit || false,
        context.submit_element_id
      );
    }
  ]
};

/**
 * SELECT_OPTION action
 * Selects an option in a dropdown/select element
 */
export const SELECT_OPTION = {
  name: ACTION_SELECT_OPTION,
  description: 'Select an option from a dropdown menu',
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
    async (context) => {
      return await executeScript(
        context.tabId,
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
        [context.elementId, context.value]
      );
    }
  ]
};

/**
 * CHECK_CHECKBOX action
 * Checks or unchecks a checkbox
 */
export const CHECK_CHECKBOX = {
  name: ACTION_CHECK_CHECKBOX,
  description: 'Check or uncheck a checkbox',
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
    async (context) => {
      return await executeScript(
        context.tabId,
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
        [context.elementId, context.checked]
      );
    }
  ]
};

/**
 * SUBMIT_FORM action
 * Submits a form by clicking a submit button or calling form.submit()
 */
export const SUBMIT_FORM = {
  name: ACTION_SUBMIT_FORM,
  description: 'Submit a form',
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
    async (context) => {
      return await executeScript(
        context.tabId,
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
        [context.elementId]
      );
    }
  ]
};

/**
 * SCROLL_TO action
 * Scrolls the page in a specified direction or to a specific position
 */
export const SCROLL_TO = {
  name: ACTION_SCROLL_TO,
  description: 'Scroll the page up, down, to top, to bottom, or by specific pixels',
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
    async (context) => {
      const browserState = getBrowserState();
      return await browserState.scrollAndWait(
        context.tabId,
        context.direction,
        context.pixels || 500,
        context.wait_ms || 500
      );
    }
  ]
};

/**
 * WAIT_FOR_LOAD action
 * Waits for page to fully load
 */
export const WAIT_FOR_LOAD = {
  name: ACTION_WAIT_FOR_LOAD,
  description: 'Wait for the page to finish loading',
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
    async (context) => {
      const timeout = context.timeout_ms || 10000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        try {
          const result = await executeScript(
            context.tabId,
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
  name: ACTION_WAIT_FOR_ELEMENT,
  description: 'Wait for a specific element to appear on the page',
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
    async (context) => {
      const timeout = context.timeout_ms || 5000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const result = await executeScript(
          context.tabId,
          (elementId) => {
            const element = document.querySelector(`[data-vish-id="${elementId}"]`);
            return {
              found: !!element,
              elementId,
              visible: element ? (element.offsetParent !== null) : false
            };
          },
          [context.elementId]
        );

        if (result.found) {
          return result;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return {
        found: false,
        elementId: context.elementId,
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
  name: ACTION_GO_BACK,
  description: 'Navigate back one page in browser history',
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
    async (context) => {
      const browserState = getBrowserState();
      return await browserState.goBack(context.tabId);
    }
  ]
};

/**
 * GO_FORWARD action
 * Go forward one page in browser history
 */
export const GO_FORWARD = {
  name: ACTION_GO_FORWARD,
  description: 'Navigate forward one page in browser history',
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
    async (context) => {
      const browserState = getBrowserState();
      return await browserState.goForward(context.tabId);
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
