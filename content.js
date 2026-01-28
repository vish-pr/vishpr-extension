// Content Script - runs on all web pages
import { ContentAction } from './modules/content-actions.js';
import { cleanDOM } from './modules/utils/clean-dom.js';
import { buildAccessibilityTree, serializeForLLM } from './modules/a11y-tree.js';

const isMac = navigator.platform.toLowerCase().includes('mac');

const handlers = {
  [ContentAction.EXTRACT_CONTENT]: () => extractPageContent(),
  [ContentAction.CLICK_ELEMENT]: (msg) => clickElement(msg.ref, msg.modifiers),
  [ContentAction.FILL_FORM]: (msg) => fillFormFields(msg.fields, msg.submit, msg.submitRef),
  [ContentAction.SCROLL_AND_WAIT]: (msg) => scrollAndWait(msg.direction, msg.pixels, msg.waitMs),
  [ContentAction.HOVER_ELEMENT]: (msg) => hoverElement(msg.ref),
  [ContentAction.PRESS_KEY]: (msg) => pressKey(msg.key, msg.modifiers),
  [ContentAction.HANDLE_DIALOG]: (msg) => handleDialog(msg.accept, msg.promptText),
  [ContentAction.GET_DIALOGS]: () => getDialogs(),
  [ContentAction.EXTRACT_ACCESSIBILITY_TREE]: () => extractAccessibilityTree(),
  [ContentAction.SELECT_OPTION]: (msg) => selectOption(msg.ref, msg.value),
  [ContentAction.CHECK_CHECKBOX]: (msg) => checkCheckbox(msg.ref, msg.checked),
  [ContentAction.SUBMIT_FORM]: (msg) => submitForm(msg.ref)
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

/**
 * Look up a DOM element by ref (e.g., "e1", "e34")
 * Uses the refMap stored by extractAccessibilityTree()
 * @param {string} ref - Element ref like "e1", "e34"
 * @returns {Element|null} The DOM element or null if not found
 */
function getElementByRef(ref) {
  const refMap = window.__vishRefMap;
  if (!refMap) return null;
  return refMap[ref] || null;
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
 * @param {string} ref - Element ref from READ_PAGE (e.g., "e1", "e34")
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
function clickElement(ref, modifiers = {}) {
  try {
    const element = getElementByRef(ref);

    if (!element) {
      return { success: false, message: `Element not found with ref: ${ref}` };
    }

    // Build click modifiers based on options
    const clickModifiers = buildClickModifiers(modifiers);

    // If no modifiers, use simple click for better compatibility
    if (!hasModifiers(clickModifiers)) {
      element.click();
      return {
        success: true,
        message: `Clicked element ref: ${ref}`,
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
      message: `Clicked element ref ${ref} with modifiers`,
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
function fillFormFields(fields, shouldSubmit, submitRef) {
  // Fill all fields
  const results = fields.map(field => {
    const element = getElementByRef(field.ref);
    if (element) {
      element.value = field.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ref: field.ref, success: true };
    }
    return { ref: field.ref, success: false, error: 'Not found' };
  });

  // Submit if requested
  if (shouldSubmit && submitRef !== undefined) {
    const submitBtn = getElementByRef(submitRef);
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

function hoverElement(ref) {
  try {
    const element = getElementByRef(ref);
    if (!element) {
      return { success: false, error: `Element not found with ref: ${ref}` };
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

    return { success: true, ref };
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

function extractAccessibilityTree() {
  try {
    const { tree, refCount, refMap } = buildAccessibilityTree(document);
    const serialized = serializeForLLM(tree);

    // Store refMap globally for lookups
    window.__vishRefMap = refMap;

    return {
      success: true,
      title: document.title,
      url: window.location.href,
      content: serialized,
      refCount
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================================
// SELECT OPTION
// ============================================================================

function selectOption(ref, value) {
  try {
    const select = getElementByRef(ref);
    if (!select || select.tagName !== 'SELECT') {
      return { selected: false, error: `Select element not found with ref: ${ref}` };
    }

    const option = Array.from(select.options).find(opt => opt.value === value || opt.text === value);
    if (option) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: true, ref, value: option.value, text: option.text };
    }
    return { selected: false, error: 'Option not found' };
  } catch (error) {
    return { selected: false, error: error.message };
  }
}

// ============================================================================
// CHECK CHECKBOX
// ============================================================================

function checkCheckbox(ref, shouldCheck) {
  try {
    const checkbox = getElementByRef(ref);
    if (!checkbox || checkbox.type !== 'checkbox') {
      return { modified: false, error: `Checkbox not found with ref: ${ref}` };
    }

    if (checkbox.checked !== shouldCheck) {
      checkbox.checked = shouldCheck;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      return { modified: true, checked: shouldCheck, ref };
    }
    return { modified: false, checked: shouldCheck, ref, note: 'Already in desired state' };
  } catch (error) {
    return { modified: false, error: error.message };
  }
}

// ============================================================================
// SUBMIT FORM
// ============================================================================

function submitForm(ref) {
  try {
    const element = getElementByRef(ref);
    if (!element) {
      return { submitted: false, error: `Element not found with ref: ${ref}` };
    }

    if (element.tagName === 'BUTTON' || element.tagName === 'INPUT') {
      element.click();
      return { submitted: true, method: 'click', ref };
    }
    if (element.tagName === 'FORM') {
      element.submit();
      return { submitted: true, method: 'submit', ref };
    }
    return { submitted: false, error: 'Element is not a form or submit button' };
  } catch (error) {
    return { submitted: false, error: error.message };
  }
}

