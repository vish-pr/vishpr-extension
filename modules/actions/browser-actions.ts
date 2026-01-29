/**
 * Browser automation actions
 * Uses content-bridge for DOM operations, direct Chrome APIs for navigation
 */
import type { Action, Message, StepContext, StepResult } from './types/index.js';
import {
  tabManager,
  extractA11yTree,
  clickElement,
  fillForm,
  selectOption,
  checkCheckbox,
  submitForm,
  scrollAndWait,
  hoverElement,
  pressKey,
  handleDialog,
  getDialogs,
  getPageState,
  setLastActivatedTab
} from '../content-bridge.js';
import { FINAL_RESPONSE_ACTION } from './final-response-action.js';
import { REQUEST_INPUT_ACTION } from './clarification-actions.js';
import { getActionStatsCounter } from '../debug/time-bucket-counter.js';

// --- Navigation Helpers ---

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function validateUrl(url: string, baseUrl?: string): string {
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith('/') && baseUrl) {
    const base = new URL(baseUrl);
    return base.origin + url;
  }
  return 'https://' + url;
}

async function navigateTo(tabIdOrAlias: string, url: string) {
  const tabId = tabManager.resolveAlias(tabIdOrAlias);
  if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

  const currentTab = await chrome.tabs.get(tabId);
  const validatedUrl = validateUrl(url, currentTab.url);
  await chrome.tabs.update(tabId, { url: validatedUrl });
  await sleep(500);
  tabManager.ensureTab(tabId, validatedUrl);
  return { navigated: true, new_url: validatedUrl };
}

async function switchTab(tabIdOrAlias: string) {
  const tabId = tabManager.resolveAlias(tabIdOrAlias);
  if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

  await chrome.tabs.update(tabId, { active: true });
  setLastActivatedTab(tabId);
  return { switched: true, tabId: tabManager.getAlias(tabId) };
}

async function openInNewTab(url: string, active = true) {
  let baseUrl: string | undefined;
  if (url.startsWith('/')) {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    baseUrl = currentTab?.url;
  }
  const validatedUrl = validateUrl(url, baseUrl);
  const tab = await chrome.tabs.create({ url: validatedUrl, active });
  tabManager.ensureTab(tab.id!, validatedUrl, tab.windowId);
  if (active) setLastActivatedTab(tab.id!);
  return { created: true, tabId: tabManager.getAlias(tab.id!), url: validatedUrl };
}

async function navigateHistory(tabIdOrAlias: string, direction: 'back' | 'forward') {
  const tabId = tabManager.resolveAlias(tabIdOrAlias);
  if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

  const tabState = tabManager.getTab(tabId);
  if (tabState) {
    if (direction === 'back' && tabState.historyIndex <= 0) {
      return { navigated: false, direction, error: 'Cannot go back - at beginning of history', ...tabManager.getNavigationStatus(tabId) };
    }
    if (direction === 'forward' && tabState.historyIndex >= tabState.history.length - 1) {
      return { navigated: false, direction, error: 'Cannot go forward - at end of history', ...tabManager.getNavigationStatus(tabId) };
    }
  }

  tabManager.setPendingNavigation(tabId, direction);
  await (direction === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
  await sleep(500);
  const tab = await chrome.tabs.get(tabId);
  if (tab?.url) tabManager.ensureTab(tabId, tab.url);

  return { navigated: true, direction, url: tab?.url, ...tabManager.getNavigationStatus(tabId) };
}


/**
 * Compress previous READ_PAGE results in messages
 * Replaces full content with compact version for all previous READ_PAGE tool responses
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

    // Skip if not a READ_PAGE result (has content & refCount) or already compressed
    if (!content.content || !content.refCount || content._compressed) return msg;

    // Replace with compressed version - keep title and url, drop full content
    return {
      ...msg,
      content: JSON.stringify({
        tabId: content.tabId,
        url: content.url,
        title: content.title,
        _compressed: true,
        note: 'Previous page content omitted. Use READ_PAGE to get current content.'
      })
    };
  });
}

/**
 * READ_PAGE action
 * Extracts page content as accessibility tree - no LLM processing needed
 */
export const READ_PAGE: Action = {
  name: 'READ_PAGE',
  description: 'Extract page content as accessibility tree with interactive element refs. Use when you need to see what is on the page or find elements to interact with. Returns refs like [e1], [e2] that are required for CLICK_ELEMENT, FILL_FORM, and other interaction actions.',
  tool_doc: {
    use_when: [
      'Need to see page content',
      'Need element refs for interaction',
      'UI changed and need fresh refs'
    ],
    must: ['Use before element interaction if no refs available'],
    never: ['Use after navigation actions (they auto-return content)'],
    examples: [
      'What is on this page?',
      'Show me the page content'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to extract content from (e.g., "t1", "t2")'
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
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const a11y = await extractA11yTree(ctx.tabId);

        if (!a11y.success) {
          throw new Error(a11y.error || 'Failed to extract accessibility tree');
        }

        console.log(`[READ_PAGE] a11y mode | refCount=${a11y.refCount} | ${a11y.url}`);

        // Track usage
        const stats = getActionStatsCounter();
        stats.increment('READ_PAGE', 'a11y_mode').catch(() => {});

        const result: Record<string, unknown> = {
          tabId: ctx.tabId,
          url: a11y.url,
          title: a11y.title,
          content: a11y.content,
          refCount: a11y.refCount
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
  description: 'Click a button, link, or interactive element using its ref from READ_PAGE. Supports modifiers: newTab (open in background tab), newTabActive (open in foreground tab), download (download instead of navigate). Requires ref from READ_PAGE results (e.g., "e1", "e34"). When a click causes navigation, automatically extracts page content as accessibility tree (disable with autoReadOnNavigate=false).',
  tool_doc: {
    use_when: ['Clicking buttons, links, or interactive elements'],
    must: ['Have element ref from READ_PAGE first'],
    never: ['Invent or guess ref values'],
    examples: [
      'Click the login button',
      'Open that link in a new tab'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      ref: { type: 'string', description: 'Element ref from READ_PAGE (e.g., "e1", "e34")' },
      newTab: { type: 'boolean', description: 'Open link in new background tab' },
      newTabActive: { type: 'boolean', description: 'Open link in new foreground tab' },
      download: { type: 'boolean', description: 'Download the link instead of navigating' },
      autoReadOnNavigate: { type: 'boolean', description: 'Auto-extract page content if click causes navigation (default: true)' },
      justification: { type: 'string', description: 'Why clicking this element' }
    },
    required: ['tabId', 'ref'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const clickResult = await clickElement(ctx.tabId, ctx.ref, {
          newTab: ctx.newTab || false,
          newTabActive: ctx.newTabActive || false,
          download: ctx.download || false
        });

        // Auto-read if navigation detected and not disabled
        if (clickResult.navigated && ctx.autoReadOnNavigate !== false) {
          try {
            const a11y = await extractA11yTree(ctx.tabId);
            return {
              result: {
                ...clickResult,
                page: {
                  url: a11y.url,
                  title: a11y.title,
                  content: a11y.content,
                  refCount: a11y.refCount
                }
              }
            };
          } catch (e) {
            // Content extraction failed, return click result anyway
            return { result: { ...clickResult, autoReadError: (e as Error).message } };
          }
        }

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
  tool_doc: {
    use_when: ['Switching focus to another browser tab'],
    examples: [
      'Switch to tab 123',
      'Focus the other tab'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID to switch to (e.g., "t1", "t2")' },
      justification: { type: 'string', description: 'Why switching tabs' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const result = await switchTab(ctx.tabId);
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
  description: 'Change the URL of an existing tab and automatically extract page content as accessibility tree. Use when you want to navigate within the same tab. Returns page content directly (disable with autoRead=false).',
  tool_doc: {
    use_when: ['Navigating to a URL in the current tab'],
    must: ['Provide valid URL'],
    examples: [
      'Go to https://google.com in this tab',
      'Navigate to https://github.com'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      url: { type: 'string', description: 'URL to navigate to' },
      autoRead: { type: 'boolean', description: 'Auto-extract page content after navigation (default: true)' },
      justification: { type: 'string', description: 'Why navigating to this URL' }
    },
    required: ['tabId', 'url'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const navResult = await navigateTo(ctx.tabId, ctx.url);

        // Skip auto-read if explicitly disabled
        if (ctx.autoRead === false) {
          return { result: navResult };
        }

        // Extract accessibility tree for better structure
        try {
          const a11y = await extractA11yTree(ctx.tabId);
          return {
            result: {
              ...navResult,
              title: a11y.title,
              content: a11y.content,
              refCount: a11y.refCount
            }
          };
        } catch (e) {
          // Content extraction failed, return nav result anyway
          return { result: { ...navResult, autoReadError: (e as Error).message } };
        }
      }
    }
  ]
};

/**
 * OPEN_URL_IN_NEW_TAB action
 */
export const OPEN_URL_IN_NEW_TAB: Action = {
  name: 'OPEN_URL_IN_NEW_TAB',
  description: 'Open a URL in a new browser tab and automatically extract page content as accessibility tree. Returns page content directly (disable with autoRead=false).',
  tool_doc: {
    use_when: ['Opening a URL in a new browser tab'],
    examples: [
      'Open https://google.com in a new tab',
      'Open this link in new tab'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open' },
      active: { type: 'boolean', description: 'Whether to focus the new tab (default: true)' },
      autoRead: { type: 'boolean', description: 'Auto-extract page content after opening (default: true)' },
      justification: { type: 'string', description: 'Why opening in new tab' }
    },
    required: ['url'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const result = await openInNewTab(ctx.url, ctx.active ?? true);

        // Skip auto-read if explicitly disabled
        if (ctx.autoRead === false) {
          return { result };
        }

        // Extract accessibility tree for better structure
        try {
          const a11y = await extractA11yTree(result.tabId);
          return {
            result: {
              ...result,
              title: a11y.title,
              content: a11y.content,
              refCount: a11y.refCount
            }
          };
        } catch (e) {
          // Content extraction failed, return result anyway
          return { result: { ...result, autoReadError: (e as Error).message } };
        }
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
  tool_doc: {
    use_when: ['Getting page scroll position, dimensions, or load status'],
    examples: [
      'Is the page fully loaded?',
      'Where am I on the page?'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      justification: { type: 'string', description: 'Why getting page state' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const stateResult = await getPageState(ctx.tabId);
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
  description: 'Fill one or more form input fields with values. Requires form_fields array with [{ref, value}] where ref comes from READ_PAGE (e.g., "e1", "e34").',
  tool_doc: {
    use_when: ['Filling text inputs, search boxes, form fields'],
    must: ['Have element refs from READ_PAGE'],
    never: ['Guess ref values'],
    examples: [
      'Enter my email address',
      'Fill in the search box with "test"'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      form_fields: {
        type: 'array',
        description: 'Array of form fields to fill',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Element ref from READ_PAGE (e.g., "e1", "e34")' },
            value: { type: 'string', description: 'Value to set' }
          },
          additionalProperties: false
        }
      },
      submit: { type: 'boolean', description: 'Whether to submit the form after filling' },
      submit_ref: { type: 'string', description: 'Element ref for submit button (e.g., "e5")' },
      justification: { type: 'string', description: 'Why filling this form' }
    },
    required: ['tabId', 'form_fields'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const fillResult = await fillForm(
          ctx.tabId,
          ctx.form_fields,
          ctx.submit || false,
          ctx.submit_ref
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
  description: 'Select an option from a dropdown/select element. Requires ref of the select element and the value or text to select.',
  tool_doc: {
    use_when: ['Selecting an option from a dropdown'],
    must: ['Have ref from READ_PAGE'],
    examples: [
      'Select "United States" from the country dropdown',
      'Choose the medium size option'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      ref: { type: 'string', description: 'Element ref from READ_PAGE for the select element (e.g., "e1")' },
      value: { type: 'string', description: 'Value or text of the option to select' },
      justification: { type: 'string', description: 'Why selecting this option' }
    },
    required: ['tabId', 'ref', 'value'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const selectResult = await selectOption(ctx.tabId, ctx.ref, ctx.value);
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
  description: 'Check or uncheck a checkbox input. Requires ref from READ_PAGE and checked (true to check, false to uncheck).',
  tool_doc: {
    use_when: ['Checking or unchecking a checkbox'],
    must: ['Have ref from READ_PAGE'],
    examples: [
      'Check the terms and conditions box',
      'Uncheck the newsletter subscription'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      ref: { type: 'string', description: 'Element ref from READ_PAGE for the checkbox (e.g., "e1")' },
      checked: { type: 'boolean', description: 'Whether to check (true) or uncheck (false)' },
      justification: { type: 'string', description: 'Why modifying this checkbox' }
    },
    required: ['tabId', 'ref', 'checked'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const checkResult = await checkCheckbox(ctx.tabId, ctx.ref, ctx.checked);
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
  description: 'Submit a form by clicking a submit button or triggering form submission. When submission causes navigation, automatically extracts page content as accessibility tree (disable with autoReadOnNavigate=false).',
  tool_doc: {
    use_when: ['Submitting a form'],
    must: ['Have ref from READ_PAGE'],
    examples: [
      'Submit the form',
      'Press the submit button'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      ref: { type: 'string', description: 'Element ref for submit button or form element (e.g., "e1")' },
      autoReadOnNavigate: { type: 'boolean', description: 'Auto-extract page content if submission causes navigation (default: true)' },
      justification: { type: 'string', description: 'Why submitting this form' }
    },
    required: ['tabId', 'ref'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        // Get URL before submission to detect navigation
        const urlBefore = (await extractA11yTree(ctx.tabId)).url;
        const submitResult = await submitForm(ctx.tabId, ctx.ref);

        // Check if navigation occurred by comparing URLs
        await new Promise(r => setTimeout(r, 500)); // Wait for potential navigation

        let navigated = false;
        try {
          const urlAfter = (await extractA11yTree(ctx.tabId)).url;
          navigated = urlAfter !== urlBefore;
        } catch {
          // Tab may be navigating
          navigated = true;
        }

        // Auto-read if navigation detected and not disabled
        if (navigated && ctx.autoReadOnNavigate !== false) {
          try {
            const a11y = await extractA11yTree(ctx.tabId);
            return {
              result: {
                ...submitResult,
                navigated: true,
                page: {
                  url: a11y.url,
                  title: a11y.title,
                  content: a11y.content,
                  refCount: a11y.refCount
                }
              }
            };
          } catch (e) {
            // Content extraction failed, return submit result anyway
            return { result: { ...submitResult, navigated: true, autoReadError: (e as Error).message } };
          }
        }

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
  tool_doc: {
    use_when: ['Scrolling the page up, down, or to edges'],
    examples: [
      'Scroll down',
      'Go to the top of the page'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
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
        const scrollResult = await scrollAndWait(
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
 * NAVIGATE_HISTORY action
 */
export const NAVIGATE_HISTORY: Action = {
  name: 'NAVIGATE_HISTORY',
  description: 'Navigate back or forward in browser history. Response includes canGoBack and canGoForward. Automatically extracts page content as accessibility tree (disable with autoRead=false).',
  tool_doc: {
    use_when: ['Going back or forward in browser history'],
    examples: [
      'Go back',
      'Go forward',
      'Return to the previous page'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      direction: { type: 'string', enum: ['back', 'forward'], description: 'Navigation direction' },
      autoRead: { type: 'boolean', description: 'Auto-extract page content after navigation (default: true)' },
      justification: { type: 'string', description: 'Why navigating' }
    },
    required: ['tabId', 'direction'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const navResult = await navigateHistory(ctx.tabId, ctx.direction);

        // Skip auto-read if explicitly disabled or navigation failed
        if (ctx.autoRead === false || !navResult.navigated) {
          return { result: navResult };
        }

        // Extract accessibility tree for better structure
        try {
          const a11y = await extractA11yTree(ctx.tabId);
          return {
            result: {
              ...navResult,
              title: a11y.title,
              content: a11y.content,
              refCount: a11y.refCount
            }
          };
        } catch (e) {
          // Content extraction failed, return nav result anyway
          return { result: { ...navResult, autoReadError: (e as Error).message } };
        }
      }
    }
  ]
};

/**
 * HOVER_ELEMENT action
 */
export const HOVER_ELEMENT: Action = {
  name: 'HOVER_ELEMENT',
  description: 'Hover over an element to trigger hover effects like dropdowns, tooltips, or menus. Requires ref from READ_PAGE.',
  tool_doc: {
    use_when: ['Triggering hover effects like dropdowns or tooltips'],
    must: ['Have ref from READ_PAGE'],
    examples: [
      'Hover over the dropdown menu',
      'Show the tooltip by hovering'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      ref: { type: 'string', description: 'Element ref from READ_PAGE (e.g., "e1")' },
      justification: { type: 'string', description: 'Why hovering over this element' }
    },
    required: ['tabId', 'ref'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const result = await hoverElement(ctx.tabId, ctx.ref);
        return { result };
      }
    }
  ]
};

/**
 * PRESS_KEY action
 */
export const PRESS_KEY: Action = {
  name: 'PRESS_KEY',
  description: 'Press a keyboard key with optional modifiers. Useful for Enter to submit, Escape to close, arrow keys for navigation.',
  tool_doc: {
    use_when: ['Pressing keyboard keys (Enter, Escape, Tab, arrows)'],
    examples: [
      'Press Enter to submit',
      'Press Escape to close the dialog',
      'Press Tab to move to next field'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      key: { type: 'string', description: 'Key to press (Enter, Tab, Escape, ArrowUp, ArrowDown, a-z, etc.)' },
      ctrlKey: { type: 'boolean', description: 'Hold Ctrl key' },
      metaKey: { type: 'boolean', description: 'Hold Meta/Cmd key' },
      shiftKey: { type: 'boolean', description: 'Hold Shift key' },
      altKey: { type: 'boolean', description: 'Hold Alt key' },
      justification: { type: 'string', description: 'Why pressing this key' }
    },
    required: ['tabId', 'key'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const result = await pressKey(ctx.tabId, ctx.key, {
          ctrlKey: ctx.ctrlKey || false,
          metaKey: ctx.metaKey || false,
          shiftKey: ctx.shiftKey || false,
          altKey: ctx.altKey || false
        });
        return { result };
      }
    }
  ]
};

/**
 * HANDLE_DIALOG action
 */
export const HANDLE_DIALOG: Action = {
  name: 'HANDLE_DIALOG',
  description: 'Configure how to handle the next browser dialog (alert, confirm, prompt). Must be called BEFORE the dialog appears.',
  tool_doc: {
    use_when: ['Accepting or dismissing browser dialogs (alert, confirm, prompt)'],
    must: ['Call BEFORE the dialog appears'],
    examples: [
      'Accept the next confirmation dialog',
      'Dismiss the next alert',
      'Enter text in the next prompt'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      accept: { type: 'boolean', description: 'Whether to accept (true) or dismiss (false) the dialog' },
      promptText: { type: 'string', description: 'Text to enter if the dialog is a prompt' },
      justification: { type: 'string', description: 'Why handling dialog this way' }
    },
    required: ['tabId', 'accept'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const result = await handleDialog(ctx.tabId, ctx.accept, ctx.promptText);
        return { result };
      }
    }
  ]
};

/**
 * GET_DIALOGS action
 */
export const GET_DIALOGS: Action = {
  name: 'GET_DIALOGS',
  description: 'Get the history of dialogs that have appeared on the page (alerts, confirms, prompts).',
  tool_doc: {
    use_when: ['Getting history of dialogs that appeared'],
    examples: [
      'Show me the dialog history',
      'What dialogs have appeared?'
    ]
  },
  input_schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID (e.g., "t1", "t2")' },
      justification: { type: 'string', description: 'Why getting dialog history' }
    },
    required: ['tabId'],
    additionalProperties: true
  },
  steps: [
    {
      type: 'function',
      handler: async (ctx: StepContext): Promise<StepResult> => {
        const result = await getDialogs(ctx.tabId);
        return { result };
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
  NAVIGATE_HISTORY,
  HOVER_ELEMENT,
  PRESS_KEY,
  HANDLE_DIALOG,
  GET_DIALOGS
];

/**
 * BROWSER_ACTION_ROUTER - Tier-2 Router
 */
export const BROWSER_ACTION_ROUTER: Action = {
  name: 'BROWSER_ACTION',
  description: 'Interact with web pages: read content, click elements, fill forms, navigate, scroll',
  tool_doc: {
    use_when: [
      'Navigating to URLs',
      'Reading page content',
      'Clicking, typing, scrolling, or interacting with web pages',
      'Any task requiring live web data'
    ],
    must: ['Use for any web interaction'],
    never: ['Use for general knowledge questions'],
    examples: [
      'What is this page?',
      'Click the login button',
      'Fill in my email'
    ]
  },
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
• If the goal is ambiguous, request clarification via REQUEST_INPUT_ACTION.

────────────────────────────────────────
AUTO-READ BEHAVIOR (IMPORTANT)
────────────────────────────────────────
Navigation actions automatically extract and return page content as accessibility tree:
• CHANGE_TAB_URL → returns accessibility tree after navigation
• OPEN_URL_IN_NEW_TAB → returns accessibility tree after opening
• CLICK_ELEMENT → returns accessibility tree if click causes navigation
• SUBMIT_FORM → returns accessibility tree if submission causes navigation
• GO_BACK / GO_FORWARD → returns accessibility tree after navigation

The accessibility tree format shows:
• Interactive elements with refs like [e1], [e2] for clicking
• Semantic roles: button, link, textbox, checkbox, list, listitem, etc.
• Element names/labels in quotes
• States: (checked), (disabled), (expanded), (collapsed)

Example: [e34] button "Compose"
         [e36] link "Inbox 2452 unread"
         [e106] row "GitHub, [GitHub] Please verify your device, 1:07 PM"

You do NOT need READ_PAGE after these actions - content is already in the result.
Only use READ_PAGE when you need fresh element IDs after UI changes without navigation.

────────────────────────────────────────
AUTONOMOUS NAVIGATION RULE
────────────────────────────────────────
If the user's goal requires web content AND no page is currently loaded:
→ Use CHANGE_TAB_URL or OPEN_URL_IN_NEW_TAB to navigate first.

Examples:
• Goal: "play music" → navigate to a music streaming site
• Goal: "search for shoes" → navigate to a shopping site
• Goal: "check email" → navigate to a webmail provider

────────────────────────────────────────
ELEMENT INTERACTION RULE
────────────────────────────────────────
MUST have element refs before interaction (click, fill, select, check, submit, hover).
Element refs come from: READ_PAGE result OR auto-read content from navigation actions.
Refs are strings like "e1", "e34" - NEVER guess or invent refs.

────────────────────────────────────────
TOOLS
────────────────────────────────────────
{{{tools_section}}}

────────────────────────────────────────
EXAMPLES
────────────────────────────────────────
{{{examples_section}}}

────────────────────────────────────────
WORKFLOW RULES
────────────────────────────────────────
MUST:
• Navigate first if no page context exists
• Have element refs before any element interaction
• Use FINAL_RESPONSE when task is complete or blocked

SHOULD:
• Use READ_PAGE after SCROLL_TO or HOVER_ELEMENT to see updated content
• Use PRESS_KEY for keyboard shortcuts (Enter to submit, Escape to close)

NEVER:
• Click or fill without element refs
• Invent refs, URLs, or tabs
• Loop more than 2 times on the same failed action

────────────────────────────────────────
ERROR HANDLING
────────────────────────────────────────
• If element not found → READ_PAGE to get fresh refs
• If same error occurs twice → FINAL_RESPONSE with error
• If interaction fails → try an alternative valid approach

────────────────────────────────────────
REMINDER
────────────────────────────────────────
Navigation actions auto-return page content - no separate READ_PAGE needed.
Use READ_PAGE only when you need fresh element IDs after non-navigation UI changes.
Use FINAL_RESPONSE to terminate.`,
      message: `Execute browser interaction.

<current_browser_tabs>
{{{browser_state}}}
</current_browser_tabs>

Goal: {{{goal}}}

If no element refs available, READ_PAGE first. Use {{{stop_action}}} when done or after 2 failed attempts.`,
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
          REQUEST_INPUT_ACTION.name,
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
          NAVIGATE_HISTORY.name,
          HOVER_ELEMENT.name,
          PRESS_KEY.name,
          HANDLE_DIALOG.name,
          GET_DIALOGS.name,
          FINAL_RESPONSE_ACTION.name
        ],
        stop_action: FINAL_RESPONSE_ACTION.name,
        max_iterations: 7
      }
    }
  ]
};
