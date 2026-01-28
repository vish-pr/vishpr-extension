/**
 * Content script bridge + Tab state management
 * Handles messaging to content scripts, tab state, and navigation
 */
import { ContentAction } from './content-actions.js';

// --- Tab State (synced to chrome.storage.session) ---
const STORAGE_KEY = 'tabState';
let tabs = new Map();
let aliasCounter = 0;
let tabIdToAlias = new Map();
let aliasToTabId = new Map();
let pendingNav = new Map();
let initialized = false;
let readyPromise = null;
let saveTimeout = null;
let lastActivatedTabId = null;

function saveState() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      await chrome.storage.session.set({
        [STORAGE_KEY]: {
          tabs: Array.from(tabs.entries()),
          aliasCounter,
          tabIdToAlias: Array.from(tabIdToAlias.entries()),
          aliasToTabId: Array.from(aliasToTabId.entries())
        }
      });
    } catch (e) { console.warn('Failed to save tab state:', e.message); }
  }, 500);
}

async function loadState() {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const s = result[STORAGE_KEY];
    if (!s) return false;
    tabs = new Map(s.tabs || []);
    aliasCounter = s.aliasCounter || 0;
    tabIdToAlias = new Map(s.tabIdToAlias || []);
    aliasToTabId = new Map(s.aliasToTabId || []);
    return true;
  } catch (e) { console.warn('Failed to load tab state:', e.message); return false; }
}

function ensureTabInternal(tabId, url, windowId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, { tabId, windowId, lastVisitedAt: new Date().toISOString(), history: [{ url, lastError: null }], historyIndex: 0 });
  } else {
    const t = tabs.get(tabId);
    if (windowId !== undefined) t.windowId = windowId;
    if (t.history[t.historyIndex]?.url !== url) {
      const dir = pendingNav.get(tabId);
      pendingNav.delete(tabId);
      if (dir === 'back' && t.historyIndex > 0) t.historyIndex--;
      else if (dir === 'forward' && t.historyIndex < t.history.length - 1) t.historyIndex++;
      else {
        t.history = t.history.slice(0, t.historyIndex + 1);
        t.history.push({ url, lastError: null });
        t.historyIndex = t.history.length - 1;
        if (t.history.length > 50) { const ex = t.history.length - 50; t.history = t.history.slice(ex); t.historyIndex -= ex; }
      }
    }
  }
  return tabs.get(tabId);
}

function initListeners() {
  chrome.tabs.onCreated.addListener(t => { if (t.id && t.url) { ensureTabInternal(t.id, t.url, t.windowId); saveState(); } });
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    try { const t = await chrome.tabs.get(tabId); ensureTabInternal(tabId, t.url, windowId); tabs.get(tabId).lastVisitedAt = new Date().toISOString(); saveState(); } catch {}
  });
  chrome.tabs.onUpdated.addListener((id, info, t) => { if (info.url) { ensureTabInternal(id, info.url, t.windowId); saveState(); } });
  chrome.tabs.onRemoved.addListener(id => { tabs.delete(id); saveState(); });
  chrome.tabs.onReplaced.addListener((newId, oldId) => {
    const t = tabs.get(oldId);
    if (t) { t.tabId = newId; tabs.set(newId, t); const a = tabIdToAlias.get(oldId); if (a) { tabIdToAlias.delete(oldId); tabIdToAlias.set(newId, a); aliasToTabId.set(a, newId); } tabs.delete(oldId); saveState(); }
  });
  chrome.tabs.onAttached.addListener((id, { newWindowId }) => { const t = tabs.get(id); if (t) { t.windowId = newWindowId; saveState(); } });
  chrome.webRequest.onErrorOccurred.addListener(d => {
    if (d.type === 'main_frame' && d.tabId > 0) { const t = tabs.get(d.tabId); const p = t?.history[t.historyIndex]; if (p?.url === d.url) { p.lastError = d.error; saveState(); } }
  }, { urls: ['<all_urls>'] });
  chrome.webRequest.onCompleted.addListener(d => {
    if (d.type === 'main_frame' && d.tabId > 0) { const t = tabs.get(d.tabId); const p = t?.history[t.historyIndex]; if (p?.lastError) { p.lastError = null; saveState(); } }
  }, { urls: ['<all_urls>'] });
  chrome.webNavigation.onCommitted.addListener(d => {
    if (d.frameId !== 0) return;
    if (d.transitionQualifiers?.includes('forward_back')) {
      const t = tabs.get(d.tabId);
      if (t && !pendingNav.has(d.tabId)) {
        if (t.historyIndex > 0 && t.history[t.historyIndex - 1]?.url === d.url) pendingNav.set(d.tabId, 'back');
        else if (t.historyIndex < t.history.length - 1 && t.history[t.historyIndex + 1]?.url === d.url) pendingNav.set(d.tabId, 'forward');
      }
    }
  });
  readyPromise = (async () => {
    const restored = await loadState();
    const current = await chrome.tabs.query({});
    const ids = new Set(current.map(t => t.id));
    if (restored) { for (const id of tabs.keys()) if (!ids.has(id)) tabs.delete(id); }
    else tabs.clear();
    for (const t of current) if (t.id && t.url && !tabs.has(t.id)) ensureTabInternal(t.id, t.url, t.windowId);
    saveState();
  })();
}

function ensureInit() { if (!initialized) { initialized = true; initListeners(); } }

// --- Tab Manager API ---
export const tabManager = {
  ready: () => { ensureInit(); return readyPromise || Promise.resolve(); },
  getAlias: id => { ensureInit(); if (tabIdToAlias.has(id)) return tabIdToAlias.get(id); const a = `t${++aliasCounter}`; tabIdToAlias.set(id, a); aliasToTabId.set(a, id); saveState(); return a; },
  resolveAlias: v => { ensureInit(); if (typeof v === 'number') return v; if (aliasToTabId.has(v)) return aliasToTabId.get(v); const n = parseInt(v, 10); return isNaN(n) ? null : n; },
  ensureTab: (id, url, wid) => { ensureInit(); ensureTabInternal(id, url, wid); saveState(); return tabs.get(id); },
  getTab: id => { ensureInit(); return tabs.get(id); },
  getNavigationStatus: id => { ensureInit(); const t = tabs.get(id); return t ? { canGoBack: t.historyIndex > 0, canGoForward: t.historyIndex < t.history.length - 1, historyLength: t.history.length, historyIndex: t.historyIndex } : { canGoBack: false, canGoForward: false, historyLength: 0, historyIndex: -1 }; },
  setPendingNavigation: (id, dir) => { ensureInit(); pendingNav.set(id, dir); },
  getPageError: id => { ensureInit(); const t = tabs.get(id); return t?.history[t.historyIndex]?.lastError || null; },
  formatForChat(wid, curId, curUrl) {
    ensureInit();
    const lines = ['=== BROWSER STATE ==='];
    const wTabs = Array.from(tabs.entries()).filter(([, t]) => t.windowId === wid);
    const cur = tabs.get(curId);
    lines.push(`Current Tab: ${this.getAlias(curId)} - ${curUrl || 'unknown'}`);
    if (cur?.history.length > 1) {
      const nav = this.getNavigationStatus(curId);
      lines.push(`Navigation: canGoBack=${nav.canGoBack}, canGoForward=${nav.canGoForward}`);
      if (nav.canGoBack) { lines.push('Back History:'); for (let i = nav.historyIndex - 1; i >= Math.max(0, nav.historyIndex - 3); i--) lines.push(`  ${nav.historyIndex - i}. ${cur.history[i]?.url}`); }
      if (nav.canGoForward) { lines.push('Forward History:'); for (let i = nav.historyIndex + 1; i <= Math.min(cur.history.length - 1, nav.historyIndex + 3); i++) lines.push(`  ${i - nav.historyIndex}. ${cur.history[i]?.url}`); }
    }
    const others = wTabs.filter(([id]) => id !== curId).sort((a, b) => (b[1].lastVisitedAt || '').localeCompare(a[1].lastVisitedAt || '')).slice(0, 10);
    if (others.length) { lines.push('', 'Other Tabs (by recent activity):'); for (const [id, t] of others) lines.push(`  ${this.getAlias(id)} - ${t.history[t.historyIndex]?.url || 'unknown'}`); }
    return lines.join('\n');
  }
};

export async function getBrowserStateBundle() {
  await tabManager.ready();
  const win = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tabManager.formatForChat(win.id, tab?.id, tab?.url);
}

// --- Content Script Bridge ---
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTabUrl(tabId) {
  try { return (await chrome.tabs.get(tabId)).url || 'unknown'; } catch { return 'unknown'; }
}

function isRestricted(url) {
  if (!url) return 'No URL';
  if (/^(chrome|chrome-extension|edge|devtools|about|view-source):/i.test(url)) return 'Browser internal page';
  if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url)) return 'Extension store';
  return null;
}

export async function sendToContent(tabIdOrAlias, action, params = {}) {
  const tabId = tabManager.resolveAlias(tabIdOrAlias);
  if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);
  try { await chrome.tabs.get(tabId); } catch { throw new Error('Tab no longer exists'); }

  if (tabId !== lastActivatedTabId) { await chrome.tabs.update(tabId, { active: true }); lastActivatedTabId = tabId; await sleep(50); }

  const url = await getTabUrl(tabId);
  const restricted = isRestricted(url);
  if (restricted) throw new Error(restricted);

  try {
    return await chrome.tabs.sendMessage(tabId, { action, ...params });
  } catch (e) {
    const pageError = tabManager.getPageError(tabId);
    const isErrPage = /ERR_CERT|ERR_SSL|ERR_CONNECTION|ERR_NAME|ERR_INTERNET|ERR_NETWORK|error page/i.test(e.message);
    if (isErrPage) throw Object.assign(new Error(`Cannot read page: ${pageError || e.message}`), { code: 'BROWSER_ERROR_PAGE', url });
    if (e.message.includes('Could not establish connection') || e.message.includes('Receiving end does not exist')) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        return await chrome.tabs.sendMessage(tabId, { action, ...params });
      } catch (e2) {
        if (/ERR_|error page/i.test(e2.message) || pageError) throw Object.assign(new Error(`Cannot read page: ${pageError || e2.message}`), { code: 'BROWSER_ERROR_PAGE', url });
        throw e2;
      }
    }
    throw e;
  }
}

export async function sendWithNavDetect(tabIdOrAlias, action, params = {}) {
  const tabId = tabManager.resolveAlias(tabIdOrAlias);
  if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);
  const urlBefore = await getTabUrl(tabId);
  const result = await sendToContent(tabId, action, params);
  await sleep(100);
  let urlAfter = await getTabUrl(tabId);
  if (urlAfter === urlBefore) { await sleep(400); urlAfter = await getTabUrl(tabId); }
  if (urlAfter === urlBefore) return result;

  tabManager.ensureTab(tabId, urlAfter);
  const start = Date.now();
  while (Date.now() - start < 10000) {
    await sleep(200);
    const cur = await getTabUrl(tabId);
    if (cur !== urlAfter) { urlAfter = cur; tabManager.ensureTab(tabId, urlAfter); }
    try { if ((await chrome.tabs.get(tabId)).status === 'complete') return { ...result, navigated: true, new_url: urlAfter }; } catch { return { ...result, navigated: true, new_url: urlAfter }; }
  }
  return { ...result, navigated: true, new_url: urlAfter };
}

export function setLastActivatedTab(tabId) { lastActivatedTabId = tabId; }

// --- Content Action Wrappers ---
export const extractA11yTree = tabId => sendToContent(tabId, ContentAction.EXTRACT_ACCESSIBILITY_TREE);
export const clickElement = (tabId, ref, modifiers = {}) => sendWithNavDetect(tabId, ContentAction.CLICK_ELEMENT, { ref, modifiers });
export const fillForm = (tabId, fields, submit = false, submitRef) => sendToContent(tabId, ContentAction.FILL_FORM, { fields, submit, submitRef });
export const selectOption = (tabId, ref, value) => sendToContent(tabId, ContentAction.SELECT_OPTION, { ref, value });
export const checkCheckbox = (tabId, ref, checked) => sendToContent(tabId, ContentAction.CHECK_CHECKBOX, { ref, checked });
export const submitForm = (tabId, ref) => sendWithNavDetect(tabId, ContentAction.SUBMIT_FORM, { ref });
export const scrollAndWait = (tabId, direction, pixels = 500, waitMs = 500) => sendToContent(tabId, ContentAction.SCROLL_AND_WAIT, { direction, pixels, waitMs });
export const hoverElement = (tabId, ref) => sendToContent(tabId, ContentAction.HOVER_ELEMENT, { ref });
export const pressKey = (tabId, key, modifiers = {}) => sendToContent(tabId, ContentAction.PRESS_KEY, { key, modifiers });
export const handleDialog = (tabId, accept, promptText) => sendToContent(tabId, ContentAction.HANDLE_DIALOG, { accept, promptText });
export const getDialogs = tabId => sendToContent(tabId, ContentAction.GET_DIALOGS);

export async function getPageState(tabIdOrAlias) {
  const tabId = tabManager.resolveAlias(tabIdOrAlias);
  if (!tabId) throw new Error(`Invalid tab: ${tabIdOrAlias}`);
  const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ scroll_y: scrollY, scroll_x: scrollX, viewport_height: innerHeight, viewport_width: innerWidth, page_height: document.documentElement.scrollHeight, page_width: document.documentElement.scrollWidth, loaded: document.readyState === 'complete' }) });
  return r[0].result;
}
