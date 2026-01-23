// Content Script - runs on all web pages
import { ContentAction } from './modules/content-actions.js';

const isMac = navigator.platform.toLowerCase().includes('mac');

const handlers = {
  [ContentAction.EXTRACT_CONTENT]: () => extractPageContent(),
  [ContentAction.CLICK_ELEMENT]: (msg) => clickElement(msg.elementId, msg.modifiers),
  [ContentAction.FILL_FORM]: (msg) => fillFormFields(msg.fields, msg.submit, msg.submitElementId),
  [ContentAction.SCROLL_AND_WAIT]: (msg) => scrollAndWait(msg.direction, msg.pixels, msg.waitMs)
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

// Clean document by removing non-content elements
function cleanDocument() {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = document.body.innerHTML;

  // Remove non-content elements
  ['script', 'style', 'svg', 'noscript'].forEach(tagName => {
    const elements = tempDiv.getElementsByTagName(tagName);
    while (elements.length > 0) {
      elements[0].parentNode?.removeChild(elements[0]);
    }
  });

  // Strip HTML tags and collapse whitespace
  return tempDiv.innerHTML
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// Main extraction function
function extractPageContent() {
  // Shared counter for all interactive elements
  const elementIdCounter = { value: 0 };

  // Extract interactive elements first (assigns data-vish-id)
  const links = extractLinks(elementIdCounter);
  const buttons = extractButtons(elementIdCounter);
  const inputs = extractInputs(elementIdCounter);
  const selects = extractSelects(elementIdCounter);
  const textareas = extractTextareas(elementIdCounter);

  return {
    title: document.title,
    url: window.location.href,
    // Raw HTML for structural mode (includes data-vish-id attrs)
    html: document.body?.innerHTML || '',
    // Text fallback for large pages
    text: cleanDocument(),
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

