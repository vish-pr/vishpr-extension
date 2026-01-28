// Content Script - runs on all web pages
import { ContentAction } from './modules/content-actions.js';
import { cleanDOM } from './modules/utils/clean-dom.js';

const isMac = navigator.platform.toLowerCase().includes('mac');

const handlers = {
  [ContentAction.EXTRACT_CONTENT]: () => extractPageContent(),
  [ContentAction.CLICK_ELEMENT]: (msg) => clickElement(msg.elementId, msg.modifiers),
  [ContentAction.FILL_FORM]: (msg) => fillFormFields(msg.fields, msg.submit, msg.submitElementId),
  [ContentAction.SCROLL_AND_WAIT]: (msg) => scrollAndWait(msg.direction, msg.pixels, msg.waitMs),
  [ContentAction.HOVER_ELEMENT]: (msg) => hoverElement(msg.elementId),
  [ContentAction.PRESS_KEY]: (msg) => pressKey(msg.key, msg.modifiers),
  [ContentAction.HANDLE_DIALOG]: (msg) => handleDialog(msg.accept, msg.promptText),
  [ContentAction.GET_DIALOGS]: () => getDialogs(),
  [ContentAction.EXTRACT_ACCESSIBILITY_TREE]: () => extractAccessibilityTree()
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message.action];
  if (handler) {
    const result = handler(message);
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true; // async
    }
    sendResponse(result);
  }
  return true;
});

// Helper to truncate and clean fields
function cleanField(value, maxLen = 30) {
  if (!value) return null;
  const cleaned = String(value).trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.substring(0, maxLen) : cleaned;
}


// Extract and deduplicate links
function extractLinks(elementIdCounter) {
  const linkMap = new Map();

  Array.from(document.querySelectorAll('a')).forEach(a => {
    const href = a.href;
    const text = cleanField(a.innerText);

    if (linkMap.has(href)) {
      const existing = linkMap.get(href);
      if (text && existing.text && !existing.text.includes(text)) {
        const combined = existing.text + ' | ' + text;
        existing.text = combined.length > 30 ? combined.substring(0, 30) : combined;
      } else if (text && !existing.text) {
        existing.text = text;
      }
    } else {
      const id = elementIdCounter.value++;
      a.setAttribute('data-vish-id', id);
      const linkObj = { id };
      if (text) linkObj.text = text;
      if (href) linkObj.href = cleanField(href, 100);
      linkMap.set(href, linkObj);
    }
  });

  return Array.from(linkMap.values());
}

// Extract buttons with metadata (deduplicated)
function extractButtons(elementIdCounter) {
  const buttonMap = new Map();

  Array.from(document.querySelectorAll('button')).forEach(b => {
    const text = cleanField(b.innerText);
    const elemId = cleanField(b.id);
    const className = cleanField(b.className);

    // Create unique key from button properties
    const key = elemId || `${text || ''}|${className || ''}`;

    if (!buttonMap.has(key)) {
      const id = elementIdCounter.value++;
      b.setAttribute('data-vish-id', id);
      const btnObj = { id };

      if (text) btnObj.text = text;
      if (elemId) btnObj.elementId = elemId;
      if (className) btnObj.class = className;

      buttonMap.set(key, btnObj);
    }
  });

  return Array.from(buttonMap.values());
}

// Extract inputs with metadata
function extractInputs(elementIdCounter) {
  return Array.from(document.querySelectorAll('input')).map(i => {
    const id = elementIdCounter.value++;
    i.setAttribute('data-vish-id', id);
    const inputObj = { id };
    const type = cleanField(i.type);
    const name = cleanField(i.name);
    const elemId = cleanField(i.id);
    const placeholder = cleanField(i.placeholder);

    if (type) inputObj.type = type;
    if (name) inputObj.name = name;
    if (elemId) inputObj.elementId = elemId;
    if (placeholder) inputObj.placeholder = placeholder;

    return inputObj;
  });
}

// Extract select elements (dropdowns) with metadata
function extractSelects(elementIdCounter) {
  return Array.from(document.querySelectorAll('select')).map(s => {
    const id = elementIdCounter.value++;
    s.setAttribute('data-vish-id', id);
    const selectObj = { id };
    const name = cleanField(s.name);
    const elemId = cleanField(s.id);

    if (name) selectObj.name = name;
    if (elemId) selectObj.elementId = elemId;

    // Include selected option
    if (s.selectedIndex >= 0 && s.options[s.selectedIndex]) {
      selectObj.selected = cleanField(s.options[s.selectedIndex].text);
    }

    return selectObj;
  });
}

// Extract textareas with metadata
function extractTextareas(elementIdCounter) {
  return Array.from(document.querySelectorAll('textarea')).map(t => {
    const id = elementIdCounter.value++;
    t.setAttribute('data-vish-id', id);
    const textareaObj = { id };
    const name = cleanField(t.name);
    const elemId = cleanField(t.id);
    const placeholder = cleanField(t.placeholder);

    if (name) textareaObj.name = name;
    if (elemId) textareaObj.elementId = elemId;
    if (placeholder) textareaObj.placeholder = placeholder;

    return textareaObj;
  });
}

// Helper: wait for DOM to stabilize (no mutations for quietPeriod ms)
async function waitForDomStable(timeout = 3000, quietPeriod = 300) {
  const startTime = Date.now();
  let lastMutationTime = Date.now();

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      lastMutationTime = Date.now();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    const checkStability = () => {
      const elapsed = Date.now() - startTime;
      const quietTime = Date.now() - lastMutationTime;

      if (quietTime >= quietPeriod) {
        observer.disconnect();
        resolve({ stable: true, waitedMs: elapsed });
      } else if (elapsed >= timeout) {
        observer.disconnect();
        resolve({ stable: false, waitedMs: elapsed });
      } else {
        setTimeout(checkStability, 50);
      }
    };

    setTimeout(checkStability, 50);
  });
}

// Main extraction function - now async with internal DOM stability wait
async function extractPageContent() {
  // Wait for DOM to stabilize before extraction
  const stabilityResult = await waitForDomStable(3000, 300);

  // Shared counter for all interactive elements
  const elementIdCounter = { value: 0 };

  // Extract interactive elements first (assigns data-vish-id)
  const links = extractLinks(elementIdCounter);
  const buttons = extractButtons(elementIdCounter);
  const inputs = extractInputs(elementIdCounter);
  const selects = extractSelects(elementIdCounter);
  const textareas = extractTextareas(elementIdCounter);

  // Get raw HTML (with data-vish-id attrs now assigned)
  const rawHtml = document.body?.innerHTML || '';

  // Clean HTML in content script where DOMParser is available
  const cleaned = cleanDOM(rawHtml, { maxHtmlBytes: 50000, debug: true });

  return {
    title: document.title,
    url: window.location.href,
    // Cleaned content from cleanDOM
    content: cleaned.content,
    contentMode: cleaned.mode,
    byteSize: cleaned.byteSize,
    rawHtmlSize: rawHtml.length,
    debugLog: cleaned.debugLog,
    // DOM stability info
    domStable: stabilityResult.stable,
    domWaitMs: stabilityResult.waitedMs,
    // Interactive elements
    links,
    buttons,
    inputs,
    selects,
    textareas
  };
}

/**
 * Click an element with optional modifiers
 * @param {number} elementId - Element ID from READ_PAGE
 * @param {Object} modifiers - Click modifiers object
 * @param {boolean} modifiers.newTab - Open in new background tab (Ctrl/Cmd+Click)
 * @param {boolean} modifiers.newTabActive - Open in new foreground tab (Ctrl/Cmd+Shift+Click)
 * @param {boolean} modifiers.download - Download the link (Alt+Click)
 * @param {boolean} modifiers.ctrlKey - Custom: Ctrl key pressed
 * @param {boolean} modifiers.metaKey - Custom: Meta/Cmd key pressed
 * @param {boolean} modifiers.shiftKey - Custom: Shift key pressed
 * @param {boolean} modifiers.altKey - Custom: Alt key pressed
 * @returns {Object} Result object with success status
 */
function clickElement(elementId, modifiers = {}) {
  try {
    const element = document.querySelector(`[data-vish-id="${elementId}"]`);

    if (!element) {
      return { success: false, message: `Element not found with ID: ${elementId}` };
    }

    // Build click modifiers based on options
    const clickModifiers = buildClickModifiers(modifiers);

    // If no modifiers, use simple click for better compatibility
    if (!hasModifiers(clickModifiers)) {
      element.click();
      return {
        success: true,
        message: `Clicked element ID: ${elementId}`,
        modifiers: 'none'
      };
    }

    // Dispatch MouseEvent with modifiers for advanced functionality
    const mouseEventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      ...clickModifiers
    };

    // Dispatch both mousedown, mouseup, and click for maximum compatibility
    element.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
    element.dispatchEvent(new MouseEvent('mouseup', mouseEventOptions));
    element.dispatchEvent(new MouseEvent('click', mouseEventOptions));

    return {
      success: true,
      message: `Clicked element ID ${elementId} with modifiers`,
      modifiers: clickModifiers
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// Modifier configurations for high-level options
const MODIFIER_CONFIGS = {
  newTab: { mac: ['metaKey'], other: ['ctrlKey'] },
  newTabActive: { mac: ['metaKey', 'shiftKey'], other: ['ctrlKey', 'shiftKey'] },
  download: { mac: ['altKey'], other: ['altKey'] }
};

/**
 * Build click modifier object from high-level options
 * @param {Object} options - High-level click options
 * @returns {Object} MouseEvent modifier keys
 */
function buildClickModifiers(options) {
  const modifiers = {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false
  };

  // Apply direct modifiers
  ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'].forEach(key => {
    if (options[key]) modifiers[key] = true;
  });

  // Apply high-level options
  Object.entries(MODIFIER_CONFIGS).forEach(([option, config]) => {
    if (options[option]) {
      const keys = config[isMac ? 'mac' : 'other'];
      keys.forEach(key => modifiers[key] = true);
    }
  });

  return modifiers;
}

/**
 * Check if any modifiers are active
 * @param {Object} modifiers - Modifier keys object
 * @returns {boolean} True if any modifier is active
 */
function hasModifiers(modifiers) {
  return modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey || modifiers.altKey;
}

// Form filling with validation
function fillFormFields(fields, shouldSubmit, submitElementId) {
  // Fill all fields
  const results = fields.map(field => {
    const element = document.querySelector(`[data-vish-id="${field.elementId}"]`);
    if (element) {
      element.value = field.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { elementId: field.elementId, success: true };
    }
    return { elementId: field.elementId, success: false, error: 'Not found' };
  });

  // Submit if requested
  if (shouldSubmit && submitElementId !== undefined) {
    const submitBtn = document.querySelector(`[data-vish-id="${submitElementId}"]`);
    results.push({
      submit: true,
      success: !!submitBtn,
      error: submitBtn ? undefined : 'Submit button not found'
    });
    if (submitBtn) submitBtn.click();
  }

  return {
    filled_fields: results.filter(r => r.success && !r.submit).length,
    results
  };
}

// Scroll directions mapping
const SCROLL_ACTIONS = {
  down: (pixels) => window.scrollBy(0, pixels),
  up: (pixels) => window.scrollBy(0, -pixels),
  bottom: () => window.scrollTo(0, document.body.scrollHeight),
  top: () => window.scrollTo(0, 0)
};

// Scroll with wait
async function scrollAndWait(direction, pixels, waitMs = 500) {
  const startY = window.scrollY;

  const scrollAction = SCROLL_ACTIONS[direction];
  if (scrollAction) scrollAction(pixels);

  await new Promise(resolve => setTimeout(resolve, waitMs));

  return {
    scrolled: true,
    previous_y: startY,
    current_y: window.scrollY,
    scrolled_pixels: window.scrollY - startY
  };
}

// ============================================================================
// HOVER ELEMENT
// ============================================================================

function hoverElement(elementId) {
  try {
    const element = document.querySelector(`[data-vish-id="${elementId}"]`);
    if (!element) {
      return { success: false, error: `Element not found with ID: ${elementId}` };
    }

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: centerX,
      clientY: centerY
    };

    element.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
    element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
    element.dispatchEvent(new MouseEvent('mousemove', eventOptions));

    return { success: true, elementId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================================
// PRESS KEY
// ============================================================================

function pressKey(key, modifiers = {}) {
  try {
    const target = document.activeElement || document.body;

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      key: key,
      code: getKeyCode(key),
      keyCode: getKeyCodeNumber(key),
      which: getKeyCodeNumber(key),
      ctrlKey: modifiers.ctrlKey || false,
      metaKey: modifiers.metaKey || false,
      shiftKey: modifiers.shiftKey || false,
      altKey: modifiers.altKey || false
    };

    target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
    target.dispatchEvent(new KeyboardEvent('keypress', eventOptions));
    target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));

    return { success: true, key, modifiers, target: target.tagName };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getKeyCode(key) {
  const keyMap = {
    'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape',
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'Backspace': 'Backspace', 'Delete': 'Delete',
    ' ': 'Space'
  };
  return keyMap[key] || `Key${key.toUpperCase()}`;
}

function getKeyCodeNumber(key) {
  const keyCodeMap = {
    'Enter': 13, 'Tab': 9, 'Escape': 27,
    'ArrowUp': 38, 'ArrowDown': 40,
    'ArrowLeft': 37, 'ArrowRight': 39,
    'Backspace': 8, 'Delete': 46, ' ': 32
  };
  return keyCodeMap[key] || key.toUpperCase().charCodeAt(0);
}

// ============================================================================
// DIALOG HANDLING
// ============================================================================

// Store dialog history and configuration
if (!window.__vishDialogs) {
  window.__vishDialogs = {
    history: [],
    pendingResponse: null
  };

  // Override native dialogs
  const originalAlert = window.alert;
  const originalConfirm = window.confirm;
  const originalPrompt = window.prompt;

  window.alert = function(message) {
    const dialog = { type: 'alert', message, timestamp: Date.now() };
    window.__vishDialogs.history.push(dialog);

    const response = window.__vishDialogs.pendingResponse;
    if (response) {
      window.__vishDialogs.pendingResponse = null;
      return;
    }
    return originalAlert.call(window, message);
  };

  window.confirm = function(message) {
    const dialog = { type: 'confirm', message, timestamp: Date.now() };
    window.__vishDialogs.history.push(dialog);

    const response = window.__vishDialogs.pendingResponse;
    if (response !== null) {
      window.__vishDialogs.pendingResponse = null;
      dialog.result = response.accept;
      return response.accept;
    }
    const result = originalConfirm.call(window, message);
    dialog.result = result;
    return result;
  };

  window.prompt = function(message, defaultValue) {
    const dialog = { type: 'prompt', message, defaultValue, timestamp: Date.now() };
    window.__vishDialogs.history.push(dialog);

    const response = window.__vishDialogs.pendingResponse;
    if (response !== null) {
      window.__vishDialogs.pendingResponse = null;
      dialog.result = response.accept ? (response.promptText || '') : null;
      return dialog.result;
    }
    const result = originalPrompt.call(window, message, defaultValue);
    dialog.result = result;
    return result;
  };
}

function handleDialog(accept, promptText) {
  window.__vishDialogs.pendingResponse = { accept, promptText };
  return { success: true, configured: true, accept, promptText };
}

function getDialogs() {
  const dialogs = window.__vishDialogs?.history || [];
  return {
    success: true,
    dialogs: dialogs.slice(-10), // Last 10 dialogs
    count: dialogs.length
  };
}

// ============================================================================
// ACCESSIBILITY TREE EXTRACTION
// ============================================================================

// Role mapping based on HTML tag
const IMPLICIT_ROLES = {
  a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading',
  h4: 'heading', h5: 'heading', h6: 'heading', img: 'img', input: 'textbox',
  select: 'combobox', textarea: 'textbox', nav: 'navigation', main: 'main',
  header: 'banner', footer: 'contentinfo', article: 'article', section: 'region',
  aside: 'complementary', form: 'form', table: 'table', ul: 'list', ol: 'list',
  li: 'listitem', dialog: 'dialog', progress: 'progressbar', meter: 'meter'
};

const INPUT_TYPE_ROLES = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button',
  submit: 'button', reset: 'button', search: 'searchbox', email: 'textbox',
  tel: 'textbox', url: 'textbox', number: 'spinbutton'
};

function computeRole(element) {
  // Explicit role takes precedence
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;

  const tag = element.tagName.toLowerCase();

  // Special handling for inputs
  if (tag === 'input') {
    const type = element.getAttribute('type') || 'text';
    return INPUT_TYPE_ROLES[type] || 'textbox';
  }

  return IMPLICIT_ROLES[tag] || null;
}

function computeAccessibleName(element) {
  // aria-label takes precedence
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // aria-labelledby
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const names = labelledBy.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (names.length) return names.join(' ');
  }

  // For inputs, check associated label
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) return label.textContent?.trim() || '';
  }

  // alt for images
  if (element.tagName.toLowerCase() === 'img') {
    return element.getAttribute('alt') || '';
  }

  // title attribute
  const title = element.getAttribute('title');
  if (title) return title.trim();

  // placeholder for inputs
  if (element.placeholder) return element.placeholder;

  // Text content for simple elements
  const text = element.textContent?.trim();
  if (text && text.length <= 100) return text;

  return '';
}

function isInteractive(element) {
  const tag = element.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
  if (element.getAttribute('tabindex') !== null) return true;
  if (element.getAttribute('onclick')) return true;
  if (element.getAttribute('role')?.match(/button|link|checkbox|radio|textbox|combobox|slider|switch|tab|menuitem/)) return true;
  return false;
}

function isHidden(element) {
  if (element.hidden) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  return false;
}

function buildAccessibilityTree() {
  const refMap = {};
  let refCounter = 0;

  function processNode(element, depth = 0) {
    if (isHidden(element)) return null;

    const role = computeRole(element);
    const name = computeAccessibleName(element);
    const interactive = isInteractive(element);

    // Skip non-semantic elements without meaningful content
    if (!role && !name && !interactive && element.children.length === 0) {
      return null;
    }

    const node = {};

    // Assign ref for interactive elements
    if (interactive || role) {
      const ref = `e${++refCounter}`;
      node.ref = ref;
      refMap[ref] = element;
      element.setAttribute('data-vish-ref', ref);
    }

    if (role) node.role = role;
    if (name) node.name = name.substring(0, 100);

    // Add state info
    if (element.checked !== undefined) node.checked = element.checked;
    if (element.selected) node.selected = true;
    if (element.disabled) node.disabled = true;
    if (element.getAttribute('aria-expanded')) node.expanded = element.getAttribute('aria-expanded') === 'true';
    if (element.value && element.tagName.match(/INPUT|TEXTAREA|SELECT/i)) {
      node.value = String(element.value).substring(0, 50);
    }

    // Process children
    const children = [];
    for (const child of element.children) {
      const childNode = processNode(child, depth + 1);
      if (childNode) children.push(childNode);
    }

    if (children.length > 0) {
      node.children = children;
    }

    return node;
  }

  const tree = processNode(document.body);

  // Store refMap globally for lookups
  window.__vishRefMap = refMap;

  return tree;
}

function serializeForLLM(tree, indent = 0) {
  if (!tree) return '';

  const pad = '  '.repeat(indent);
  let lines = [];

  let desc = '';
  if (tree.ref) desc += `[${tree.ref}] `;
  if (tree.role) desc += tree.role;
  if (tree.name) desc += ` "${tree.name}"`;
  if (tree.checked !== undefined) desc += tree.checked ? ' (checked)' : ' (unchecked)';
  if (tree.disabled) desc += ' (disabled)';
  if (tree.expanded !== undefined) desc += tree.expanded ? ' (expanded)' : ' (collapsed)';
  if (tree.value) desc += ` value="${tree.value}"`;

  if (desc.trim()) {
    lines.push(pad + desc.trim());
  }

  if (tree.children) {
    for (const child of tree.children) {
      lines.push(serializeForLLM(child, indent + 1));
    }
  }

  return lines.filter(Boolean).join('\n');
}

function extractAccessibilityTree() {
  try {
    const tree = buildAccessibilityTree();
    const serialized = serializeForLLM(tree);

    return {
      success: true,
      mode: 'a11y',
      content: serialized,
      refCount: Object.keys(window.__vishRefMap || {}).length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

