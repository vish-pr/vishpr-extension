/**
 * Chrome API layer - Pure browser operations + tab telemetry
 * No AI/LLM knowledge in this module
 */
import { ContentAction } from './content-actions.js';

// Normalize elements to schema format: { id: string, text: string }
function normalizeElements(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(el => {
    const { id, ...rest } = el;
    const parts = Object.entries(rest)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${v}`);
    return { id: String(id ?? ''), text: parts.join(', ') };
  });
}

async function getTabUrl(tabId, fallback = 'unknown') {
  if (!tabId) return fallback;
  try {
    return (await chrome.tabs.get(tabId)).url || fallback;
  } catch (e) {
    console.warn('Failed to get tab URL:', e.message);
    return fallback;
  }
}

class ChromeAPI {
  constructor() {
    this.tabs = new Map();
    this.tabErrors = new Map(); // Store network errors per tab
    this.currentTabId = null;
    this.currentTabUrl = null;
    this.windowId = null;
    this._readyPromise = null;
    this._initTabListeners();
    this._initErrorListener();
  }

  setWindowId(windowId) {
    this.windowId = windowId;
    this._initCurrentTab();
  }

  async _persistState() {
    try {
      const stateJSON = this.toJSON();
      await chrome.storage.session.set({ browserState: stateJSON });
    } catch (error) {
      console.warn('Failed to persist browser state:', error.message);
    }
  }

  ready() { return this._readyPromise || Promise.resolve(); }

  _initTabListeners() {
    chrome.tabs.onCreated.addListener(async (tab) => {
      if (this.windowId && tab.windowId !== this.windowId) return;
      if (tab.id && tab.url) {
        this._ensureTab(tab.id, tab.url);
        this._persistState();
      }
    });

    chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
      if (this.windowId && windowId !== this.windowId) return;
      this.currentTabId = tabId;
      try {
        const tab = await chrome.tabs.get(tabId);
        this.currentTabUrl = tab.url;
        this._ensureTab(tabId, tab.url);
        const tabState = this.tabs.get(tabId);
        if (tabState) tabState.lastVisitedAt = new Date().toISOString();
        this._persistState();
      } catch (e) {
        console.warn('Failed to get tab info on activation:', e.message);
      }
    });

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      if (this.windowId) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.windowId !== this.windowId) return;
        } catch { return; }
      }
      if (changeInfo.url) {
        if (tabId === this.currentTabId) {
          this.currentTabUrl = changeInfo.url;
        }
        this._ensureTab(tabId, changeInfo.url);
        this._persistState();
      }
    });

    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      if (this.windowId && removeInfo.windowId !== this.windowId) return;
      this.tabs.delete(tabId);
      this._persistState();
    });

    chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
      if (this.windowId) {
        try {
          const tab = await chrome.tabs.get(addedTabId);
          if (tab.windowId !== this.windowId) return;
        } catch { return; }
      }
      const oldTab = this.tabs.get(removedTabId);
      if (oldTab) {
        oldTab.tabId = addedTabId;
        this.tabs.set(addedTabId, oldTab);
        this.tabs.delete(removedTabId);
      }
      if (this.currentTabId === removedTabId) {
        this.currentTabId = addedTabId;
      }
      this._persistState();
    });

    // Handle tab moving to a different window
    chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
      // If a tracked tab moves to a new window, update windowId and reinitialize
      if (this.tabs.has(tabId) || tabId === this.currentTabId) {
        this.windowId = newWindowId;
        this._initCurrentTab();
      }
    });

    chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
      // Remove tab from tracking when it leaves the window
      // It will be re-added by onAttached when it joins the new window
      if (this.windowId && oldWindowId === this.windowId) {
        this.tabs.delete(tabId);
        this._persistState();
      }
    });

    this._initCurrentTab();
  }

  _initErrorListener() {
    // Capture network errors (certificate errors, DNS failures, etc.) per tab
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        // Only track main frame errors (not subresources)
        if (details.type === 'main_frame' && details.tabId > 0) {
          this.tabErrors.set(details.tabId, {
            error: details.error,
            url: details.url,
            timestamp: Date.now()
          });
        }
      },
      { urls: ['<all_urls>'] }
    );

    // Clear error when tab navigates successfully
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (details.type === 'main_frame' && details.tabId > 0) {
          this.tabErrors.delete(details.tabId);
        }
      },
      { urls: ['<all_urls>'] }
    );

    // Clean up errors when tab is closed
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.tabErrors.delete(tabId);
    });
  }

  getTabError(tabId) {
    const error = this.tabErrors.get(tabId);
    // Only return if error is recent (within 30 seconds)
    if (error && Date.now() - error.timestamp < 30000) {
      return error.error;
    }
    return null;
  }

  _initCurrentTab() {
    this._readyPromise = (async () => {
      try {
        // Clear existing tabs when reinitializing
        this.tabs.clear();

        // Load tabs from current window only
        const query = this.windowId ? { windowId: this.windowId } : {};
        const allTabs = await chrome.tabs.query(query);
        for (const tab of allTabs) {
          if (tab.id && tab.url) {
            this._ensureTab(tab.id, tab.url);
          }
        }

        // Set current active tab
        const activeQuery = this.windowId
          ? { active: true, windowId: this.windowId }
          : { active: true, currentWindow: true };
        const [activeTab] = await chrome.tabs.query(activeQuery);
        if (activeTab) {
          this.currentTabId = activeTab.id;
          this.currentTabUrl = activeTab.url;
        }

        this._persistState();
      } catch (e) {
        console.warn('Failed to initialize tabs:', e.message);
      }
    })();
  }

  _ensureTab(tabId, url) {
    const now = new Date().toISOString();
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        tabId,
        url,
        openedAt: now,
        lastVisitedAt: now,
        urlHistory: [{ url, timestamp: now }],
        content: { raw: null, cleaned: null, summary: null }
      });
    } else {
      const tab = this.tabs.get(tabId);
      if (tab.url !== url) {
        tab.url = url;
        tab.urlHistory.push({ url, timestamp: now });
        if (tab.urlHistory.length > 5) {
          tab.urlHistory = tab.urlHistory.slice(-5);
        }
      }
    }
    return this.tabs.get(tabId);
  }

  // --- Tab Telemetry ---

  getTab(tabId) { return this.tabs.get(tabId) || null; }

  // --- Content Storage ---

  updateTabContent(tabId, { raw, cleaned, summary }) {
    const tab = this._ensureTab(tabId, this.tabs.get(tabId)?.url || 'unknown');
    if (raw !== undefined) tab.content.raw = raw;
    if (cleaned !== undefined) tab.content.cleaned = cleaned;
    if (summary !== undefined) tab.content.summary = summary;
  }

  // --- Serialization (for persistence) ---

  toJSON() {
    const json = { windowId: this.windowId, tabs: {} };
    for (const [tabId, tab] of Array.from(this.tabs)) json.tabs[tabId] = tab;
    return json;
  }

  // --- Browser State Formatting (for LLM context) ---

  formatForChat() {
    const lines = ['=== BROWSER STATE ==='];
    const currentTab = this.tabs.get(this.currentTabId);

    lines.push(`Current Tab: ${this.currentTabId} - ${this.currentTabUrl || 'unknown'}`);
    if (currentTab && currentTab.urlHistory.length > 1) {
      lines.push('History:');
      const history = currentTab.urlHistory.slice(-3, -1).reverse();
      history.forEach((e, i) => lines.push(`  ${i + 1}. ${e.url} (${e.timestamp})`));
    }

    const otherTabs = Array.from(this.tabs.entries())
      .filter(([tabId]) => tabId !== this.currentTabId)
      .sort((a, b) => (b[1].lastVisitedAt || '').localeCompare(a[1].lastVisitedAt || ''))
      .slice(0, 10);

    if (otherTabs.length > 0) {
      lines.push('');
      lines.push('Other Tabs (by recent activity):');
      otherTabs.forEach(([tabId, tab], i) => lines.push(`  ${i + 1}. ${tabId} - ${tab.url}`));
    }

    return lines.join('\n');
  }

  // --- Browser Operations ---

  // Check if URL is a restricted internal page where content scripts cannot run
  // Returns error message string if restricted, null otherwise
  _isRestrictedUrl(url) {
    if (!url) return 'Cannot access page - URL is not available';

    const restrictedPatterns = [
      { pattern: /^chrome:\/\//i, message: 'Cannot access chrome:// internal pages' },
      { pattern: /^chrome-extension:\/\//i, message: 'Cannot access extension pages' },
      { pattern: /^edge:\/\//i, message: 'Cannot access edge:// internal pages' },
      { pattern: /^about:/i, message: 'Cannot access about: pages' },
      { pattern: /^view-source:/i, message: 'Cannot access view-source: pages' },
      { pattern: /^devtools:\/\//i, message: 'Cannot access DevTools pages' },
      { pattern: /^https?:\/\/chrome\.google\.com\/webstore/i, message: 'Cannot access Chrome Web Store pages' },
      { pattern: /^https?:\/\/chromewebstore\.google\.com/i, message: 'Cannot access Chrome Web Store pages' },
      { pattern: /^https?:\/\/microsoftedge\.microsoft\.com\/addons/i, message: 'Cannot access Edge Add-ons Store pages' },
    ];

    for (const { pattern, message } of restrictedPatterns) {
      if (pattern.test(url)) return message;
    }
    return null;
  }

  // Check if error indicates a browser error page (certificate errors, DNS failures, etc.)
  _isErrorPageError(errorMessage) {
    const errorPagePatterns = [
      /error page/i,
      /showing error/i,
      /ERR_CERT/i,
      /ERR_SSL/i,
      /ERR_CONNECTION/i,
      /ERR_NAME_NOT_RESOLVED/i,
      /ERR_INTERNET_DISCONNECTED/i,
      /ERR_NETWORK/i,
    ];
    return errorPagePatterns.some(pattern => pattern.test(errorMessage));
  }

  async _executeContentScript(tabId, action, params = {}) {
    try {
      await chrome.tabs.get(tabId);
    } catch { throw new Error('Tab no longer exists'); }

    const urlBefore = await getTabUrl(tabId);

    // Check for restricted URLs first
    const restrictionMessage = this._isRestrictedUrl(urlBefore);
    if (restrictionMessage) {
      throw new Error(restrictionMessage);
    }

    let result;
    try {
      result = await chrome.tabs.sendMessage(tabId, { action, ...params });
    } catch (error) {
      // Check for browser error page (certificate errors, connection failures, etc.)
      if (this._isErrorPageError(error.message)) {
        const networkError = this.getTabError(tabId);
        const errorDetail = networkError || error.message;
        const err = Object.assign(new Error(`Cannot read page: ${errorDetail}`), {
          code: 'BROWSER_ERROR_PAGE',
          url: urlBefore
        });
        throw err;
      }

      if (error.message.includes('Could not establish connection') || error.message.includes('Receiving end does not exist')) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          result = await chrome.tabs.sendMessage(tabId, { action, ...params });
        } catch (retryError) {
          // Check again for error page after retry
          if (this._isErrorPageError(retryError.message)) {
            const networkError = this.getTabError(tabId);
            const errorDetail = networkError || retryError.message;
            const err = Object.assign(new Error(`Cannot read page: ${errorDetail}`), {
              code: 'BROWSER_ERROR_PAGE',
              url: urlBefore
            });
            throw err;
          }
          throw retryError;
        }
      } else {
        throw error;
      }
    }

    // Check if action triggered navigation
    await new Promise(r => setTimeout(r, 100));
    let urlAfter = await getTabUrl(tabId);

    if (urlAfter === urlBefore) {
      await new Promise(r => setTimeout(r, 400));
      urlAfter = await getTabUrl(tabId);
    }

    if (urlAfter === urlBefore) {
      return result;
    }

    // Navigation detected - wait for page load
    this._ensureTab(tabId, urlAfter);
    const timeout = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      await new Promise(r => setTimeout(r, 200));
      const currentUrl = await getTabUrl(tabId);

      if (currentUrl !== urlAfter) {
        urlAfter = currentUrl;
        this._ensureTab(tabId, urlAfter);
      }

      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          return { ...result, navigated: true, new_url: urlAfter };
        }
      } catch {
        return { ...result, navigated: true, new_url: urlAfter };
      }
    }

    return { ...result, navigated: true, new_url: urlAfter };
  }

  async _executeScript(tabId, func, args = []) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
    return result[0].result;
  }

  async extractContent(tabId) {
    const url = await getTabUrl(tabId);
    this._ensureTab(tabId, url);
    const content = await this._executeContentScript(tabId, ContentAction.EXTRACT_CONTENT);
    if (!content || typeof content !== 'object') throw new Error('Failed to extract valid content from page');
    return {
      url,
      title: content.title || 'N/A',
      links: normalizeElements(content.links),
      buttons: normalizeElements(content.buttons),
      inputs: normalizeElements(content.inputs),
      selects: normalizeElements(content.selects),
      textareas: normalizeElements(content.textareas),
      content: content.content || '',
      contentMode: content.contentMode || 'text',
      byteSize: content.byteSize || 0,
      rawHtmlSize: content.rawHtmlSize || 0,
      debugLog: content.debugLog || null
    };
  }

  async clickElement(tabId, elementId, modifiers = {}) {
    return this._executeContentScript(tabId, ContentAction.CLICK_ELEMENT, { elementId, modifiers });
  }

  async fillForm(tabId, fields, submit = false, submitElementId) {
    return this._executeContentScript(tabId, ContentAction.FILL_FORM, { fields, submit, submitElementId });
  }

  async selectOption(tabId, elementId, value) {
    return this._executeScript(tabId, (elementId, value) => {
      const select = /** @type {HTMLSelectElement | null} */ (document.querySelector(`[data-vish-id="${elementId}"]`));
      if (!select || select.tagName !== 'SELECT') {
        return { selected: false, error: 'Select element not found' };
      }
      const option = Array.from(select.options).find(opt => opt.value === value || opt.text === value);
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: true, elementId, value: option.value, text: option.text };
      }
      return { selected: false, error: 'Option not found' };
    }, [elementId, value]);
  }

  async checkCheckbox(tabId, elementId, checked) {
    return this._executeScript(tabId, (elementId, shouldCheck) => {
      const checkbox = /** @type {HTMLInputElement | null} */ (document.querySelector(`[data-vish-id="${elementId}"]`));
      if (!checkbox || checkbox.type !== 'checkbox') {
        return { modified: false, error: 'Checkbox not found' };
      }
      if (checkbox.checked !== shouldCheck) {
        checkbox.checked = shouldCheck;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        return { modified: true, checked: shouldCheck };
      }
      return { modified: false, checked: shouldCheck, note: 'Already in desired state' };
    }, [elementId, checked]);
  }

  async submitForm(tabId, elementId) {
    return this._executeScript(tabId, (elementId) => {
      const element = /** @type {HTMLElement | null} */ (document.querySelector(`[data-vish-id="${elementId}"]`));
      if (!element) {
        return { submitted: false, error: 'Element not found' };
      }
      if (element.tagName === 'BUTTON' || element.tagName === 'INPUT') {
        /** @type {HTMLButtonElement | HTMLInputElement} */ (element).click();
        return { submitted: true, method: 'click' };
      }
      if (element.tagName === 'FORM') {
        /** @type {HTMLFormElement} */ (element).submit();
        return { submitted: true, method: 'submit' };
      }
      return { submitted: false, error: 'Element is not a form or submit button' };
    }, [elementId]);
  }

  async scrollAndWait(tabId, direction, pixels = 500, waitMs = 500) {
    return this._executeContentScript(tabId, ContentAction.SCROLL_AND_WAIT, { direction, pixels, waitMs });
  }

  async navigateTo(tabId, url) {
    const validatedUrl = url.match(/^https?:\/\//) ? url : 'https://' + url;
    await chrome.tabs.update(tabId, { url: validatedUrl });
    await new Promise(r => setTimeout(r, 500));
    this._ensureTab(tabId, validatedUrl);
    return { navigated: true, new_url: validatedUrl };
  }

  async goBack(tabId) {
    await chrome.tabs.goBack(tabId);
    await new Promise(r => setTimeout(r, 500));
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) this._ensureTab(tabId, tab.url);
    return { navigated: true, direction: 'back' };
  }

  async goForward(tabId) {
    await chrome.tabs.goForward(tabId);
    await new Promise(r => setTimeout(r, 500));
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) this._ensureTab(tabId, tab.url);
    return { navigated: true, direction: 'forward' };
  }

  async getPageState(tabId) {
    return this._executeScript(tabId, () => ({
      scroll_y: window.scrollY,
      scroll_x: window.scrollX,
      viewport_height: window.innerHeight,
      viewport_width: window.innerWidth,
      page_height: document.documentElement.scrollHeight,
      page_width: document.documentElement.scrollWidth,
      loaded: document.readyState === 'complete'
    }));
  }

  async waitForLoad(tabId, timeoutMs = 10000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await this._executeScript(tabId, () => ({
          loaded: document.readyState === 'complete',
          ready_state: document.readyState
        }));
        if (result.loaded) return result;
      } catch {
        // Tab might be navigating, wait and retry
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { loaded: false, ready_state: 'timeout', error: 'Timeout waiting for page load' };
  }

  async waitForElement(tabId, elementId, timeoutMs = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const result = await this._executeScript(tabId, (elementId) => {
        const element = /** @type {HTMLElement | null} */ (document.querySelector(`[data-vish-id="${elementId}"]`));
        return {
          found: !!element,
          elementId,
          visible: element ? (element.offsetParent !== null) : false
        };
      }, [elementId]);
      if (result.found) return result;
      await new Promise(r => setTimeout(r, 200));
    }
    return { found: false, elementId, error: 'Timeout waiting for element' };
  }
}

// Singleton instance
let chromeAPIInstance = null;

export function getChromeAPI() {
  if (!chromeAPIInstance) chromeAPIInstance = new ChromeAPI();
  return chromeAPIInstance;
}

export async function getBrowserStateBundle() {
  const api = getChromeAPI();
  await api.ready();
  return api.formatForChat();
}
