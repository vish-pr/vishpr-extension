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
    this.networkRequests = new Map(); // Store network requests per tab
    this.dialogs = new Map(); // Store dialog history per tab
    this._lastActivatedTabId = null; // Track last tab activated by extension (for script execution)
    this._pendingNavigation = new Map(); // Map<tabId, 'back' | 'forward'> - tracks navigation intent
    this._readyPromise = null;

    // Tab alias system: t1, t2, etc. - never reuse aliases within a session
    this._tabAliasCounter = 0;
    this._tabIdToAlias = new Map(); // Map<realTabId, alias>
    this._aliasToTabId = new Map(); // Map<alias, realTabId>

    this._initTabListeners();
    this._initErrorListener();
    this._initNavListeners();
    this._initNetworkTracking();
  }

  /**
   * Get or create a stable alias for a tab ID
   * @param {number} tabId - Real Chrome tab ID
   * @returns {string} Alias like "t1", "t2"
   */
  _getTabAlias(tabId) {
    if (this._tabIdToAlias.has(tabId)) {
      return this._tabIdToAlias.get(tabId);
    }
    const alias = `t${++this._tabAliasCounter}`;
    this._tabIdToAlias.set(tabId, alias);
    this._aliasToTabId.set(alias, tabId);
    return alias;
  }

  /**
   * Resolve a tab alias or real ID to real tab ID
   * @param {string|number} tabIdOrAlias - Alias like "t1" or real tab ID
   * @returns {number|null} Real tab ID or null if not found
   */
  resolveTabId(tabIdOrAlias) {
    // If it's already a number, return it
    if (typeof tabIdOrAlias === 'number') return tabIdOrAlias;

    // If it's a string alias like "t1"
    if (typeof tabIdOrAlias === 'string') {
      // Check if it's an alias
      if (this._aliasToTabId.has(tabIdOrAlias)) {
        return this._aliasToTabId.get(tabIdOrAlias);
      }
      // Try parsing as number (for backwards compatibility)
      const parsed = parseInt(tabIdOrAlias, 10);
      if (!isNaN(parsed)) return parsed;
    }

    return null;
  }

  /**
   * Get alias for display, creating if needed
   * @param {number} tabId - Real Chrome tab ID
   * @returns {string} Alias like "t1"
   */
  getTabAlias(tabId) {
    return this._getTabAlias(tabId);
  }

  async _persistState() {
    try {
      await chrome.storage.session.set({ browserState: { tabs: Object.fromEntries(this.tabs) } });
    } catch (e) {
      console.warn('Failed to persist browser state:', e.message);
    }
  }

  ready() { return this._readyPromise || Promise.resolve(); }

  _initTabListeners() {
    chrome.tabs.onCreated.addListener(async (tab) => {
      if (tab.id && tab.url) {
        this._ensureTab(tab.id, tab.url, tab.windowId);
        this._persistState();
      }
    });

    chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        this._ensureTab(tabId, tab.url, windowId);
        const tabState = this.tabs.get(tabId);
        if (tabState) tabState.lastVisitedAt = new Date().toISOString();
        this._persistState();
      } catch (e) {
        console.warn('Failed to get tab info on activation:', e.message);
      }
    });

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.url) {
        this._ensureTab(tabId, changeInfo.url, tab.windowId);
        this._persistState();
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.tabs.delete(tabId);
      this._persistState();
    });

    chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
      const oldTab = this.tabs.get(removedTabId);
      if (oldTab) {
        oldTab.tabId = addedTabId;
        this.tabs.set(addedTabId, oldTab);
        this.tabs.delete(removedTabId);
      }
      this._persistState();
    });

    // Handle tab moving to a different window - update the tab's windowId
    chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
      const tabState = this.tabs.get(tabId);
      if (tabState) {
        tabState.windowId = newWindowId;
        this._persistState();
      }
    });

    // onDetached: tab is temporarily detached, will be re-attached via onAttached
    // No need to delete - just wait for onAttached to update windowId

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
    return (error && Date.now() - error.timestamp < 30000) ? error.error : null;
  }

  _initNavListeners() {
    // Detect user-initiated back/forward navigation via browser UI
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0) return; // Only main frame

      const { tabId, url, transitionQualifiers } = details;

      // Detect browser UI back/forward navigation
      if (transitionQualifiers && transitionQualifiers.includes('forward_back')) {
        const tab = this.tabs.get(tabId);
        if (tab && !this._pendingNavigation.has(tabId)) {
          // Infer direction by matching URL to neighbors in history
          if (tab.historyIndex > 0 && tab.history[tab.historyIndex - 1]?.url === url) {
            this._pendingNavigation.set(tabId, 'back');
          } else if (tab.historyIndex < tab.history.length - 1 &&
                     tab.history[tab.historyIndex + 1]?.url === url) {
            this._pendingNavigation.set(tabId, 'forward');
          }
        }
      }
    });
  }

  async _initCurrentTab() {
    this._readyPromise = this._loadAllTabs();
  }

  async _loadAllTabs() {
    try {
      this.tabs.clear();
      (await chrome.tabs.query({})).forEach(t => t.id && t.url && this._ensureTab(t.id, t.url, t.windowId));
      this._persistState();
    } catch (e) { console.warn('Failed to initialize tabs:', e.message); }
  }

  _ensureTab(tabId, url, windowId) {
    const now = new Date().toISOString();
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        tabId,
        url,
        windowId,
        openedAt: now,
        lastVisitedAt: now,
        history: [{ url, timestamp: now }],
        historyIndex: 0,
        content: { raw: null, cleaned: null, summary: null }
      });
    } else {
      const tab = this.tabs.get(tabId);
      if (windowId !== undefined) tab.windowId = windowId;
      if (tab.url !== url) {
        tab.url = url;
        this._updateHistory(tab, url, now);
      }
    }
    return this.tabs.get(tabId);
  }

  /**
   * Update history stack based on navigation intent
   * @param {object} tab - Tab state object
   * @param {string} url - New URL
   * @param {string} timestamp - ISO timestamp
   */
  _updateHistory(tab, url, timestamp) {
    const direction = this._pendingNavigation.get(tab.tabId);
    this._pendingNavigation.delete(tab.tabId);

    if (direction === 'back' && tab.historyIndex > 0) {
      tab.historyIndex--;
    } else if (direction === 'forward' && tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
    } else {
      // New navigation - clear forward entries, append new
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push({ url, timestamp });
      tab.historyIndex = tab.history.length - 1;
      // Limit to 50 entries
      if (tab.history.length > 50) {
        const excess = tab.history.length - 50;
        tab.history = tab.history.slice(excess);
        tab.historyIndex -= excess;
      }
    }
  }

  /**
   * Get navigation status for a tab
   * @param {number} tabId
   * @returns {{ canGoBack: boolean, canGoForward: boolean, historyLength: number, historyIndex: number }}
   */
  getNavigationStatus(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return { canGoBack: false, canGoForward: false, historyLength: 0, historyIndex: -1 };
    return {
      canGoBack: tab.historyIndex > 0,
      canGoForward: tab.historyIndex < tab.history.length - 1,
      historyLength: tab.history.length,
      historyIndex: tab.historyIndex
    };
  }

  // --- Content Storage ---

  updateTabContent(tabId, updates) {
    const tab = this._ensureTab(tabId, this.tabs.get(tabId)?.url || 'unknown');
    Object.assign(tab.content, Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined)));
  }

  // --- Browser State Formatting (for LLM context) ---

  formatForChat(windowId, currentTabId, currentTabUrl) {
    const lines = ['=== BROWSER STATE ==='];

    // Filter tabs by windowId
    const windowTabs = Array.from(this.tabs.entries())
      .filter(([, tab]) => tab.windowId === windowId);

    const currentTab = this.tabs.get(currentTabId);
    const currentAlias = this._getTabAlias(currentTabId);

    lines.push(`Current Tab: ${currentAlias} - ${currentTabUrl || 'unknown'}`);

    if (currentTab && currentTab.history.length > 1) {
      const nav = this.getNavigationStatus(currentTabId);
      lines.push(`Navigation: canGoBack=${nav.canGoBack}, canGoForward=${nav.canGoForward}`);

      if (nav.canGoBack) {
        lines.push('Back History:');
        // Show up to 3 previous entries
        const backStart = Math.max(0, nav.historyIndex - 3);
        for (let i = nav.historyIndex - 1; i >= backStart; i--) {
          const entry = currentTab.history[i];
          lines.push(`  ${nav.historyIndex - i}. ${entry.url}`);
        }
      }
      if (nav.canGoForward) {
        lines.push('Forward History:');
        // Show up to 3 forward entries
        const forwardEnd = Math.min(currentTab.history.length - 1, nav.historyIndex + 3);
        for (let i = nav.historyIndex + 1; i <= forwardEnd; i++) {
          const entry = currentTab.history[i];
          lines.push(`  ${i - nav.historyIndex}. ${entry.url}`);
        }
      }
    }

    const otherTabs = windowTabs
      .filter(([tabId]) => tabId !== currentTabId)
      .sort((a, b) => (b[1].lastVisitedAt || '').localeCompare(a[1].lastVisitedAt || ''))
      .slice(0, 10);

    if (otherTabs.length > 0) {
      lines.push('');
      lines.push('Other Tabs (by recent activity):');
      otherTabs.forEach(([tabId, tab]) => {
        const alias = this._getTabAlias(tabId);
        lines.push(`  ${alias} - ${tab.url}`);
      });
    }

    return lines.join('\n');
  }

  // --- Browser Operations ---

  // Check if URL is a restricted internal page where content scripts cannot run
  _isRestrictedUrl(url) {
    if (!url) return 'Cannot access page - URL is not available';
    if (/^(chrome|chrome-extension|edge|devtools):\/\//i.test(url)) return 'Cannot access browser internal pages';
    if (/^(about|view-source):/i.test(url)) return 'Cannot access browser internal pages';
    if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url)) return 'Cannot access extension store pages';
    return null;
  }

  // Check if error indicates a browser error page (certificate errors, DNS failures, etc.)
  _isErrorPageError(errorMessage) {
    return /error page|showing error|ERR_CERT|ERR_SSL|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK/i.test(errorMessage);
  }

  _throwBrowserError(errorMsg, tabId, url) {
    const detail = this.getTabError(tabId) || errorMsg;
    throw Object.assign(new Error(`Cannot read page: ${detail}`), { code: 'BROWSER_ERROR_PAGE', url });
  }

  async _executeContentScript(tabIdOrAlias, action, params = {}) {
    // Resolve tab alias to real ID
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    try { await chrome.tabs.get(tabId); } catch { throw new Error('Tab no longer exists'); }

    if (tabId !== this._lastActivatedTabId) {
      await chrome.tabs.update(tabId, { active: true });
      this._lastActivatedTabId = tabId;
      await new Promise(r => setTimeout(r, 50));
    }

    const urlBefore = await getTabUrl(tabId);
    const restricted = this._isRestrictedUrl(urlBefore);
    if (restricted) throw new Error(restricted);

    let result;
    try {
      result = await chrome.tabs.sendMessage(tabId, { action, ...params });
    } catch (error) {
      if (this._isErrorPageError(error.message)) this._throwBrowserError(error.message, tabId, urlBefore);

      if (error.message.includes('Could not establish connection') || error.message.includes('Receiving end does not exist')) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          result = await chrome.tabs.sendMessage(tabId, { action, ...params });
        } catch (retryError) {
          if (this._isErrorPageError(retryError.message)) this._throwBrowserError(retryError.message, tabId, urlBefore);
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

  async _executeScript(tabIdOrAlias, func, args = []) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

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

    // Log content mode and sizes
    console.log(`[extractContent] ${url} | mode=${content.contentMode} | raw=${content.rawHtmlSize} cleaned=${content.byteSize} | domStable=${content.domStable} waitMs=${content.domWaitMs}`);

    return {
      url,
      title: content.title || 'N/A',
      content: content.content || '',
      contentMode: content.contentMode || 'text',
      byteSize: content.byteSize || 0,
      rawHtmlSize: content.rawHtmlSize || 0,
      debugLog: content.debugLog || null,
      domStable: content.domStable,
      domWaitMs: content.domWaitMs,
      links: normalizeElements(content.links),
      buttons: normalizeElements(content.buttons),
      inputs: normalizeElements(content.inputs),
      selects: normalizeElements(content.selects),
      textareas: normalizeElements(content.textareas)
    };
  }

  async clickElement(tabId, ref, modifiers = {}) {
    return this._executeContentScript(tabId, ContentAction.CLICK_ELEMENT, { ref, modifiers });
  }

  async fillForm(tabId, fields, submit = false, submitRef) {
    return this._executeContentScript(tabId, ContentAction.FILL_FORM, { fields, submit, submitRef });
  }

  async selectOption(tabId, ref, value) {
    return this._executeContentScript(tabId, ContentAction.SELECT_OPTION, { ref, value });
  }

  async checkCheckbox(tabId, ref, checked) {
    return this._executeContentScript(tabId, ContentAction.CHECK_CHECKBOX, { ref, checked });
  }

  async submitForm(tabId, ref) {
    return this._executeContentScript(tabId, ContentAction.SUBMIT_FORM, { ref });
  }

  async scrollAndWait(tabId, direction, pixels = 500, waitMs = 500) {
    return this._executeContentScript(tabId, ContentAction.SCROLL_AND_WAIT, { direction, pixels, waitMs });
  }

  async navigateTo(tabIdOrAlias, url) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    let validatedUrl;
    if (url.match(/^https?:\/\//)) {
      validatedUrl = url;
    } else if (url.startsWith('/')) {
      // Relative URL - resolve against current tab's origin
      const tab = await chrome.tabs.get(tabId);
      const base = new URL(tab.url);
      validatedUrl = base.origin + url;
    } else {
      validatedUrl = 'https://' + url;
    }
    await chrome.tabs.update(tabId, { url: validatedUrl });
    await new Promise(r => setTimeout(r, 500));
    this._ensureTab(tabId, validatedUrl);
    return { navigated: true, new_url: validatedUrl };
  }

  async switchTab(tabIdOrAlias) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    await chrome.tabs.update(tabId, { active: true });
    this._lastActivatedTabId = tabId;
    const alias = this._getTabAlias(tabId);
    return { switched: true, tabId: alias };
  }

  async openInNewTab(url, active = true) {
    let validatedUrl;
    if (url.match(/^https?:\/\//)) {
      validatedUrl = url;
    } else if (url.startsWith('/')) {
      // Relative URL - resolve against current active tab's origin
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (currentTab?.url) {
        const base = new URL(currentTab.url);
        validatedUrl = base.origin + url;
      } else {
        validatedUrl = 'https://' + url;
      }
    } else {
      validatedUrl = 'https://' + url;
    }
    const tab = await chrome.tabs.create({ url: validatedUrl, active });
    this._ensureTab(tab.id, validatedUrl, tab.windowId);
    const alias = this._getTabAlias(tab.id);
    return { created: true, tabId: alias, url: validatedUrl };
  }

  async _navigate(tabIdOrAlias, direction) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    const tabState = this.tabs.get(tabId);

    // Pre-check if navigation is possible
    if (tabState) {
      if (direction === 'back' && tabState.historyIndex <= 0) {
        const nav = this.getNavigationStatus(tabId);
        return { navigated: false, direction, error: 'Cannot go back - at beginning of history', ...nav };
      }
      if (direction === 'forward' && tabState.historyIndex >= tabState.history.length - 1) {
        const nav = this.getNavigationStatus(tabId);
        return { navigated: false, direction, error: 'Cannot go forward - at end of history', ...nav };
      }
    }

    // Set pending navigation intent before Chrome API call
    this._pendingNavigation.set(tabId, direction);

    await (direction === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
    await new Promise(r => setTimeout(r, 500));
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) this._ensureTab(tabId, tab.url);

    const nav = this.getNavigationStatus(tabId);
    return { navigated: true, direction, url: tab?.url, ...nav };
  }

  async goBack(tabIdOrAlias) { return this._navigate(tabIdOrAlias, 'back'); }
  async goForward(tabIdOrAlias) { return this._navigate(tabIdOrAlias, 'forward'); }

  async getPageState(tabIdOrAlias) {
    return this._executeScript(tabIdOrAlias, () => ({
      scroll_y: window.scrollY,
      scroll_x: window.scrollX,
      viewport_height: window.innerHeight,
      viewport_width: window.innerWidth,
      page_height: document.documentElement.scrollHeight,
      page_width: document.documentElement.scrollWidth,
      loaded: document.readyState === 'complete'
    }));
  }

  // --- New Actions ---

  async hoverElement(tabId, ref) {
    return this._executeContentScript(tabId, ContentAction.HOVER_ELEMENT, { ref });
  }

  async pressKey(tabId, key, modifiers = {}) {
    return this._executeContentScript(tabId, ContentAction.PRESS_KEY, { key, modifiers });
  }

  async handleDialog(tabId, accept, promptText) {
    return this._executeContentScript(tabId, ContentAction.HANDLE_DIALOG, { accept, promptText });
  }

  async getDialogs(tabId) {
    return this._executeContentScript(tabId, ContentAction.GET_DIALOGS);
  }

  async extractAccessibilityTree(tabId) {
    return this._executeContentScript(tabId, ContentAction.EXTRACT_ACCESSIBILITY_TREE);
  }

  // --- Network Tracking ---

  _initNetworkTracking() {
    // Track network requests per tab
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId < 0) return;

        const requests = this.networkRequests.get(details.tabId) || [];
        requests.push({
          requestId: details.requestId,
          url: details.url,
          method: details.method,
          type: details.type,
          timestamp: details.timeStamp,
          status: 'pending'
        });

        // Keep last 100 requests per tab
        if (requests.length > 100) requests.shift();
        this.networkRequests.set(details.tabId, requests);
      },
      { urls: ['<all_urls>'] }
    );

    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (details.tabId < 0) return;

        const requests = this.networkRequests.get(details.tabId) || [];
        const request = requests.find(r => r.requestId === details.requestId);
        if (request) {
          request.status = 'completed';
          request.statusCode = details.statusCode;
          request.responseHeaders = details.responseHeaders?.slice(0, 10); // First 10 headers
        }
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );

    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        if (details.tabId < 0) return;

        const requests = this.networkRequests.get(details.tabId) || [];
        const request = requests.find(r => r.requestId === details.requestId);
        if (request) {
          request.status = 'error';
          request.error = details.error;
        }
      },
      { urls: ['<all_urls>'] }
    );

    // Clear requests when tab is closed
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.networkRequests.delete(tabId);
    });
  }

  enableNetworkTracking(tabIdOrAlias) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    if (!this.networkRequests.has(tabId)) {
      this.networkRequests.set(tabId, []);
    }
    return { enabled: true, tabId: this._getTabAlias(tabId) };
  }

  disableNetworkTracking(tabIdOrAlias) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    this.networkRequests.delete(tabId);
    return { disabled: true, tabId: this._getTabAlias(tabId) };
  }

  getNetworkRequests(tabIdOrAlias, filter = {}) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    const requests = this.networkRequests.get(tabId) || [];
    let filtered = requests;

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      filtered = filtered.filter(r => types.includes(r.type));
    }

    if (filter.status) {
      filtered = filtered.filter(r => r.status === filter.status);
    }

    if (filter.urlPattern) {
      const regex = new RegExp(filter.urlPattern);
      filtered = filtered.filter(r => regex.test(r.url));
    }

    if (filter.statusCode) {
      if (typeof filter.statusCode === 'number') {
        filtered = filtered.filter(r => r.statusCode === filter.statusCode);
      } else if (filter.statusCode.min || filter.statusCode.max) {
        filtered = filtered.filter(r => {
          if (!r.statusCode) return false;
          if (filter.statusCode.min && r.statusCode < filter.statusCode.min) return false;
          if (filter.statusCode.max && r.statusCode > filter.statusCode.max) return false;
          return true;
        });
      }
    }

    return {
      requests: filtered.slice(-50), // Last 50 matching
      total: requests.length,
      filtered: filtered.length
    };
  }

  clearNetworkRequests(tabIdOrAlias) {
    const tabId = this.resolveTabId(tabIdOrAlias);
    if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);

    this.networkRequests.set(tabId, []);
    return { cleared: true, tabId: this._getTabAlias(tabId) };
  }
}

// Singleton instance
let chromeAPIInstance = null;
export function getChromeAPI() { return chromeAPIInstance || (chromeAPIInstance = new ChromeAPI()); }

export async function getBrowserStateBundle() {
  const api = getChromeAPI();
  await api.ready();
  const win = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return api.formatForChat(win.id, tab?.id, tab?.url);
}
