/**
 * Browser State Manager
 * Manages browser tabs, URL history, and page content with versioning
 * Used to maintain conversation context for the chat application
 * Also handles all communication with content scripts
 */

import logger from './logger.js';
import { ContentAction } from './content-actions.js';

/**
 * Get tab URL safely with fallback
 */
async function getTabUrl(tabId, fallback = 'unknown') {
  if (!tabId) return fallback;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || fallback;
  } catch {
    return fallback;
  }
}

/**
 * BrowserState class manages the state of all tabs
 * Each tab tracks its URL history and page content snapshots
 */
export class BrowserState {
  constructor() {
    // Main state structure
    this.tabs = new Map();
  }

  /**
   * Register a new tab or update existing tab's current URL
   * @param {number} tabId - The tab ID
   * @param {string} url - Current URL of the tab
   */
  registerTab(tabId, url) {
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        tabId,
        currentUrl: url,
        urlHistory: [{
          url,
          timestamp: new Date().toISOString()
        }],
        pageContents: []
      });
      logger.info('Registered new tab', { tabId, url });
    } else {
      const tab = this.tabs.get(tabId);

      // Only add to history if URL changed
      if (tab.currentUrl !== url) {
        tab.currentUrl = url;
        tab.urlHistory.push({
          url,
          timestamp: new Date().toISOString()
        });
        logger.info('Updated tab URL', { tabId, url });
      }
    }

    return this.tabs.get(tabId);
  }

  /**
   * Ensure a tab is registered, fetching URL if not provided
   * @param {number} tabId - The tab ID
   * @param {string} [providedUrl] - Optional URL to use (if not provided, will be fetched)
   * @returns {Promise<Object>} Tab state with page_url
   */
  async ensureTabRegistered(tabId, providedUrl) {
    // Get current tab URL if not provided
    const pageUrl = providedUrl || await getTabUrl(tabId);

    // Register the tab
    this.registerTab(tabId, pageUrl);

    return { page_url: pageUrl };
  }

  /**
   * Add page content from a readpage call
   * If the same URL already has content, mark the old one as updated
   * @param {number} tabId - The tab ID
   * @param {string} url - Page URL
   * @param {Object} content - Extracted content (text, buttons, links)
   */
  addPageContent(tabId, url, content) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      logger.error('Tab not found when adding page content', { tabId });
      throw new Error(`Tab ${tabId} not registered`);
    }

    // Validate content object
    if (!content || typeof content !== 'object') {
      logger.error('Invalid content provided to addPageContent', { tabId, url, content });
      throw new Error('Content must be a valid object');
    }

    // Find existing content for this URL
    const existingContentIndex = tab.pageContents.findIndex(
      pc => pc.url === url && pc.status === 'current'
    );

    if (existingContentIndex !== -1) {
      // Mark old content as updated
      const oldContent = tab.pageContents[existingContentIndex];
      oldContent.status = 'updated';
      oldContent.updatedTo = new Date().toISOString();

      logger.info('Marked old page content as updated', { tabId, url });
    }

    // Add new content at the end
    const newContent = {
      url,
      timestamp: new Date().toISOString(),
      content: {
        title: content.title || '',
        text: content.text || '',
        buttons: content.buttons || [],
        links: content.links || [],
        inputs: content.inputs || []
      },
      status: 'current'
    };

    tab.pageContents.push(newContent);
    logger.info('Added new page content', { tabId, url, contentItems: tab.pageContents.length });

    return newContent;
  }

  /**
   * Get tab state
   * @param {number} tabId - The tab ID
   * @returns {Object|null} Tab state or null if not found
   */
  getTab(tabId) {
    return this.tabs.get(tabId) || null;
  }

  /**
   * Get current page content for a tab
   * @param {number} tabId - The tab ID
   * @returns {Object|null} Current page content or null
   */
  getCurrentPageContent(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;

    // Find the most recent 'current' content
    const currentContents = tab.pageContents.filter(pc => pc.status === 'current');
    return currentContents.length > 0 ? currentContents[currentContents.length - 1] : null;
  }

  /**
   * Get all page contents for a tab (including updated ones)
   * @param {number} tabId - The tab ID
   * @returns {Array} Array of page contents
   */
  getAllPageContents(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.pageContents : [];
  }

  /**
   * Remove a tab from state
   * @param {number} tabId - The tab ID
   */
  removeTab(tabId) {
    const removed = this.tabs.delete(tabId);
    if (removed) {
      logger.info('Removed tab from state', { tabId });
    }
    return removed;
  }

  /**
   * Format browser state for chat context
   * Returns a formatted string representation suitable for LLM context
   * @returns {string} Formatted browser state
   */
  formatForChat() {
    const lines = [];
    lines.push('=== BROWSER STATE ===\n');

    for (const [tabId, tab] of this.tabs) {
      lines.push(`Tab ${tabId}:`);
      lines.push(`  Current URL: ${tab.currentUrl}`);

      if (tab.urlHistory.length > 1) {
        lines.push(`  URL History:`);
        tab.urlHistory.forEach((entry, idx) => {
          lines.push(`    ${idx + 1}. ${entry.url} (${entry.timestamp})`);
        });
      }

      if (tab.pageContents.length > 0) {
        lines.push(`  Page Contents:`);
        tab.pageContents.forEach((pc, idx) => {
          const statusStr = pc.status === 'updated'
            ? `[UPDATED to ${pc.updatedTo}]`
            : '[CURRENT]';

          lines.push(`    ${idx + 1}. ${statusStr} ${pc.url}`);
          lines.push(`       Title: ${pc.content.title || 'N/A'}`);

          if (pc.content.text) {
            const textPreview = pc.content.text.substring(0, 200);
            lines.push(`       Text: ${textPreview}${pc.content.text.length > 200 ? '...' : ''}`);
          }

          if (pc.content.buttons && pc.content.buttons.length > 0) {
            lines.push(`       Buttons: ${pc.content.buttons.length} buttons`);
          }

          if (pc.content.links && pc.content.links.length > 0) {
            lines.push(`       Links: ${pc.content.links.length} links`);
          }

          if (pc.content.inputs && pc.content.inputs.length > 0) {
            lines.push(`       Inputs: ${pc.content.inputs.length} form inputs`);
          }
        });
      }

      lines.push(''); // Empty line between tabs
    }

    return lines.join('\n');
  }

  /**
   * Export browser state as JSON (for passing to chat application)
   * @returns {Object} Browser state as plain object
   */
  toJSON() {
    const json = {
      tabs: {}
    };

    for (const [tabId, tab] of this.tabs) {
      json.tabs[tabId] = {
        tabId: tab.tabId,
        currentUrl: tab.currentUrl,
        urlHistory: tab.urlHistory,
        pageContents: tab.pageContents
      };
    }

    return json;
  }

  /**
   * Import browser state from JSON
   * @param {Object} json - Browser state JSON
   */
  fromJSON(json) {
    this.tabs.clear();

    if (json.tabs) {
      for (const [tabId, tab] of Object.entries(json.tabs)) {
        this.tabs.set(parseInt(tabId), tab);
      }
    }

    logger.info('Imported browser state', { tabCount: this.tabs.size });
  }

  /**
   * Clear all browser state
   */
  clear() {
    this.tabs.clear();
    logger.info('Cleared all browser state');
  }

  /**
   * Get summary statistics
   * @returns {Object} Statistics about browser state
   */
  getStats() {
    let totalUrls = 0;
    let totalContents = 0;
    let currentContents = 0;
    let updatedContents = 0;

    for (const tab of this.tabs.values()) {
      totalUrls += tab.urlHistory.length;
      totalContents += tab.pageContents.length;
      currentContents += tab.pageContents.filter(pc => pc.status === 'current').length;
      updatedContents += tab.pageContents.filter(pc => pc.status === 'updated').length;
    }

    return {
      totalTabs: this.tabs.size,
      totalUrls,
      totalContents,
      currentContents,
      updatedContents
    };
  }

  /**
   * Execute a content script action
   * @param {number} tabId - Tab ID
   * @param {string} action - Action name
   * @param {Object} params - Action parameters
   * @returns {Promise<Object>} Action result
   */
  async executeContentScript(tabId, action, params = {}) {
    logger.info(`Content Script Call: ${action}`, { tabId, params });

    try {
      // Check if tab still exists
      try {
        await chrome.tabs.get(tabId);
      } catch {
        logger.error('Tab no longer exists', { tabId });
        throw new Error('Tab no longer exists');
      }

      // Send message to content script
      const result = await chrome.tabs.sendMessage(tabId, { action, ...params });
      logger.info(`Content Script Result: ${action}`, { result });
      return result;
    } catch (error) {
      // If content script not loaded, try to inject it
      if (error.message.includes('Could not establish connection') ||
          error.message.includes('Receiving end does not exist')) {
        try {
          logger.info('Injecting content script', { tabId });
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          });

          // Retry after injection
          logger.info('Retrying after content script injection', { tabId, action });
          const result = await chrome.tabs.sendMessage(tabId, { action, ...params });
          logger.info(`Content Script Result (after injection): ${action}`, { result });
          return result;
        } catch (injectError) {
          logger.error('Failed to inject content script', {
            tabId,
            error: injectError.message
          });
          throw new Error(`Failed to inject content script: ${injectError.message}`);
        }
      }
      logger.error(`Content Script Error: ${action}`, {
        tabId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Extract page content from a tab and update browser state
   * @param {number} tabId - Tab ID
   * @returns {Promise<Object>} Result with content and page_url
   */
  async extractAndStoreContent(tabId) {
    // Get current tab URL
    const pageUrl = await getTabUrl(tabId);

    // Register tab with current URL
    this.registerTab(tabId, pageUrl);

    // Extract content
    const content = await this.executeContentScript(tabId, ContentAction.EXTRACT_CONTENT);

    logger.info('Content extracted from page', {
      tabId,
      pageUrl,
      hasContent: !!content,
      contentType: typeof content,
      keys: content ? Object.keys(content) : []
    });

    // Validate content before adding to browser state
    if (!content || typeof content !== 'object') {
      logger.error('Invalid content returned from extractContent', {
        tabId,
        content,
        contentType: typeof content
      });
      throw new Error('Failed to extract valid content from page');
    }

    // Add page content to browser state
    this.addPageContent(tabId, pageUrl, content);

    return { content, page_url: pageUrl };
  }

  /**
   * Click an element in a tab
   * @param {number} tabId - Tab ID
   * @param {number} elementId - Element ID from READ_PAGE
   * @param {Object} modifiers - Click modifiers
   * @returns {Promise<Object>} Click result
   */
  async clickElement(tabId, elementId, modifiers = {}) {
    return await this.executeContentScript(tabId, ContentAction.CLICK_ELEMENT, {
      elementId,
      modifiers
    });
  }

  /**
   * Fill form fields in a tab
   * @param {number} tabId - Tab ID
   * @param {Array} fields - Form fields to fill
   * @param {boolean} submit - Whether to submit the form
   * @param {number} submitElementId - Submit button element ID
   * @returns {Promise<Object>} Fill result
   */
  async fillForm(tabId, fields, submit = false, submitElementId) {
    return await this.executeContentScript(tabId, ContentAction.FILL_FORM, {
      fields,
      submit,
      submitElementId
    });
  }

  /**
   * Scroll and wait in a tab
   * @param {number} tabId - Tab ID
   * @param {string} direction - Scroll direction
   * @param {number} pixels - Pixels to scroll
   * @param {number} waitMs - Milliseconds to wait
   * @returns {Promise<Object>} Scroll result
   */
  async scrollAndWait(tabId, direction, pixels = 500, waitMs = 500) {
    return await this.executeContentScript(tabId, ContentAction.SCROLL_AND_WAIT, {
      direction,
      pixels,
      waitMs
    });
  }

  /**
   * Navigate to a URL
   * @param {number} tabId - Tab ID
   * @param {string} url - URL to navigate to
   * @returns {Promise<Object>} Navigation result
   */
  async navigateTo(tabId, url) {
    // Validate URL
    let validatedUrl = url;
    if (!validatedUrl.match(/^https?:\/\//)) {
      validatedUrl = 'https://' + validatedUrl;
    }

    // Update tab URL
    await chrome.tabs.update(tabId, { url: validatedUrl });

    // Wait for navigation to start
    await new Promise(resolve => setTimeout(resolve, 500));

    // Register the new URL
    this.registerTab(tabId, validatedUrl);

    return {
      navigated: true,
      new_url: validatedUrl
    };
  }

  /**
   * Navigate back in browser history
   * @param {number} tabId - Tab ID
   * @returns {Promise<Object>} Navigation result
   */
  async goBack(tabId) {
    await chrome.tabs.goBack(tabId);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Get updated URL and register it
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) {
      this.registerTab(tabId, tab.url);
    }

    return { navigated: true, direction: 'back' };
  }

  /**
   * Navigate forward in browser history
   * @param {number} tabId - Tab ID
   * @returns {Promise<Object>} Navigation result
   */
  async goForward(tabId) {
    await chrome.tabs.goForward(tabId);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Get updated URL and register it
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) {
      this.registerTab(tabId, tab.url);
    }

    return { navigated: true, direction: 'forward' };
  }
}

// Singleton instance
let browserStateInstance = null;

/**
 * Get the singleton browser state instance
 * @returns {BrowserState}
 */
export function getBrowserState() {
  if (!browserStateInstance) {
    browserStateInstance = new BrowserState();
  }
  return browserStateInstance;
}

/**
 * Get browser state in all formats (formatted, JSON, instance)
 * @returns {Object} Object containing formatted, json, and instance
 */
export function getBrowserStateBundle() {
  const state = getBrowserState();
  return {
    formatted: state.formatForChat(),
    json: state.toJSON(),
    instance: state
  };
}

/**
 * Reset browser state (mainly for testing)
 */
export function resetBrowserState() {
  if (browserStateInstance) {
    browserStateInstance.clear();
  }
  browserStateInstance = new BrowserState();
  return browserStateInstance;
}
