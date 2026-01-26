/**
 * DOM Cleaner - Preserves structure while removing noise
 * Returns cleaned HTML when small enough, falls back to text extraction
 */

// ============================================================================
// TUNABLE CONFIGURATION
// ============================================================================

const CONFIG = {
  // Size thresholds
  maxHtmlBytes: 50000,          // Fallback to text if HTML exceeds this
  urlLengthThreshold: 60,       // URLs longer than this get shortened to [uN]
  noiseSizeThreshold: 5000,     // Only check elements > 5KB for heuristic removal

  // Heuristic detection
  maxLinkDensity: 0.7,          // >70% link text = likely navigation
  minLinkCount: 5,              // Need 5+ links to be considered navigation

  // Truncation limits
  maxListItems: 10,             // Truncate lists after N items
  maxTableRows: 10,             // Truncate tables after N rows
  textAttrLimit: 50,            // Text-like attrs: keep up to 50 chars
  otherAttrThreshold: 15,       // Other attrs: if > 15 chars, truncate
  otherAttrKeep: 7,             // Other attrs: keep first 7 chars
  minAltLength: 3,              // Alt text shorter than this = meaningless
  maxCollapseIterations: 5,     // Prevent infinite loops in wrapper collapse

  // Binary search truncation (slope-based linear taper)
  // Uses binary search to find minimum slope needed to get under targetSize
  // keepRatio(i, n, slope) = 1 - slope * (i / (n-1))
  targetSize: 45000,            // Target max HTML size for truncation

  // URL params worth keeping (strip all others)
  keepParams: ['q', 'query', 'search', 's', 'page', 'p', 'id', 'tab', 'v'],
};

// ============================================================================
// TAG/SELECTOR DEFINITIONS
// ============================================================================

// Blacklist: attributes to remove entirely (noise)
const REMOVE_ATTRS = new Set([
  // Styling
  'class', 'style',
  // Framework internals
  'data-reactid', 'data-react-checksum', 'data-emotion-css',
  // Testing selectors
  'data-testid', 'data-test', 'data-cy', 'data-qa',
  // Analytics
  'data-gtm', 'data-ga', 'data-analytics', 'data-track',
  // Web component noise
  'slot', 'part', 'exportparts', 'is',
  // Misc noise
  'draggable', 'spellcheck', 'translate', 'autocapitalize', 'autocorrect',
]);

const REMOVE_ATTR_PREFIXES = ['on', 'data-react', 'data-v-', 'ng-', 'v-', '_ngcontent', '_nghost'];

// Heuristic: detect if value is natural text vs hash/noise
// Compare frequency of common English chars vs rare chars + digits
const COMMON_CHARS = /[etaoinshrl ]/gi;  // Most frequent in English + space
const RARE_CHARS = /[zqxj0-9]/gi;        // Rare letters + digits (hash indicators)

const isTextLike = (value: string): boolean => {
  if (value.length < 15) return true;

  const common = (value.match(COMMON_CHARS) || []).length;
  const rare = (value.match(RARE_CHARS) || []).length;

  return common > 1.1 * rare;
};

const shouldRemoveAttr = (name: string): boolean => {
  if (REMOVE_ATTRS.has(name)) return true;
  if (REMOVE_ATTR_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
  return false;
};

const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'object', 'embed', 'link', 'meta', 'template',
  'header', 'footer', // Site chrome
  'tp-yt-paper-tooltip', 'paper-tooltip', // Tooltips
  'yt-live-chat-ticker-renderer', 'yt-guide-manager', 'yt-mdx-manager', 'yt-playlist-manager',
  'yt-hotkey-manager', 'yt-page-navigation-progress', 'yt-img-shadow', // YouTube noise
]);

const UNWRAP_TAGS = new Set([
  // YouTube
  'yt-touch-feedback-shape', 'yt-button-shape', 'yt-icon', 'yt-icon-button',
  'yt-formatted-string', 'yt-attributed-string', 'yt-interaction',
  'ytd-button-renderer', 'ytd-toggle-button-renderer', 'ytd-menu-renderer',
  'button-view-model', 'badge-shape', 'tp-yt-paper-button', 'tp-yt-paper-icon-button',
  // Polymer/Web Components
  'dom-if', 'dom-repeat', 'ps-dom-if', 'iron-icon', 'paper-button', 'paper-icon-button',
  // Reddit (shreddit-* elements are handled by unwrapCustomElements, but add common wrappers)
  'faceplate-screen-reader-content', 'faceplate-partial',
]);

const REMOVE_SELECTORS = [
  // Wikipedia
  '.reflist', '.references', '.reference', '.mw-references-wrap', 'sup.reference', 'sup.noprint',
  '.navbox', '.navbox-styles', '.sistersitebox', '.side-box', '.ambox', '.mbox-small',
  '#toc', '.toc', '.mw-editsection', '.catlinks',
  // Google
  '[data-hveid] [data-lk]', '[jsname="yEVEwb"]', 'g-accordion', '.kno-fv', '[data-initq]', '.AJLUJb', '.k8XOCe',
  '[data-attrid]', '[jscontroller][jsaction]', // Google interactive widgets
  // Generic noise
  '.ad', '.advertisement', '[data-ad]', '[data-google-query-id]',
  '[role="banner"]', '[role="contentinfo"]',
  '[role="navigation"]:not([aria-label*="page"]):not([aria-label*="content"])',
  '[href="#start-of-content"]', '[href="#main-content"]', '[href="#content"]', '.skip-link', '.skip-to-content',
  // GitHub
  '.footer', '.Header', '.AppHeader',
  '.js-header-wrapper', '.js-pjax-loader-bar', // GitHub dynamic elements
  // YouTube
  'ytd-guide-renderer', 'ytd-mini-guide-renderer', 'ytd-masthead', 'ytd-miniplayer',
  'ytd-topbar-logo-renderer', 'yt-searchbox', 'ytd-searchbox',
  'ytd-watch-next-secondary-results-renderer', // YouTube sidebar recommendations
  // Note: YouTube comments are preserved but truncated hierarchically
  // Reddit
  'shreddit-async-loader', 'shreddit-experience-tree',
  'faceplate-tooltip', 'faceplate-tracker',
  '[slot="visit-subreddit-button"]', '[slot="join-button"]',
  // Hash-only anchors
  'a[href^="#"]:not([href="#"])',
];

const REMOVE_IF_EMPTY = new Set([
  'div', 'span', 'p', 'section', 'article', 'aside', 'header', 'footer',
  'nav', 'main', 'figure', 'figcaption', 'li', 'ul', 'ol', 'dl', 'dt', 'dd'
]);

const GENERIC_ALT = new Set(['image', 'logo', 'icon']);

// ============================================================================
// TYPES
// ============================================================================

export interface CleanDOMResult {
  mode: 'html' | 'text';
  content: string;
  byteSize: number;
  elementCount: number;
  urlRegistry?: Record<string, string>;
  debugLog?: CleanupPhaseLog[];
}

export interface CleanupPhaseLog {
  phase: string;
  sizeBefore: number;
  sizeAfter: number;
  reduction: number;
  reductionPct: string;
  elementCount?: number;
}

export interface CleanDOMOptions {
  maxHtmlBytes?: number;
  preserveQueryParams?: boolean;
  removeHidden?: boolean;
  shortenUrls?: boolean;
  urlLengthThreshold?: number;
  debug?: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const removeByTags = (root: Element, tags: Set<string>) => {
  for (const tag of tags) {
    const els = root.getElementsByTagName(tag);
    while (els.length) els[0].remove();
  }
};

const removeBySelectors = (root: Element, selectors: string[]) => {
  for (const sel of selectors) {
    try { root.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
  }
};

const unwrapTags = (root: Element, tags: Set<string>) => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const tag of tags) {
      for (const el of Array.from(root.querySelectorAll(tag))) {
        if (el.parentNode) {
          while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
          el.remove();
          changed = true;
        }
      }
    }
  }
};

const unwrapCustomElements = (root: Element) => {
  const els = root.querySelectorAll('*');
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.tagName.includes('-') && el.parentNode) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
    }
  }
};

const cleanUrl = (href: string, keepParams: string[]): string => {
  try {
    const isRelative = !href.includes('://');
    const url = new URL(href, 'http://example.com');
    const params = new URLSearchParams();
    for (const p of keepParams) {
      if (url.searchParams.has(p)) params.set(p, url.searchParams.get(p)!);
    }
    const paramStr = params.toString();
    let clean = isRelative ? url.pathname : url.origin + url.pathname;
    if (paramStr) clean += '?' + paramStr;
    if (url.hash) clean += url.hash;
    return clean;
  } catch {
    return href;
  }
};

const collapseWhitespace = (html: string): string =>
  html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();

// ============================================================================
// BINARY SEARCH TRUNCATION (recursive slope-based linear taper)
// ============================================================================

/**
 * Measure element size (innerHTML length)
 */
const measureSize = (element: Element): number => element.innerHTML.length;

/**
 * Linear taper: keepRatio = 1 - slope * (i / (n-1))
 * slope=0: keep all equally, slope=1: first=100%, last=0%
 */
const taperRatio = (index: number, total: number, slope: number): number => {
  if (total <= 1) return 1;
  return Math.max(0, 1 - slope * (index / (total - 1)));
};

/** Threshold below which elements are removed */
const REMOVAL_THRESHOLD = 0.1;

/** Safety margin for binary search (accounts for estimation error) */
const SAFETY_MARGIN = 0.95;

/**
 * Build size cache for accurate estimation (outerHTML is expensive)
 */
const buildSizeCache = (root: Element): Map<Element, number> => {
  const cache = new Map<Element, number>();
  const all = root.querySelectorAll('*');
  for (const el of all) {
    cache.set(el, el.outerHTML.length);
  }
  cache.set(root, root.outerHTML.length);
  return cache;
};

/**
 * Recursively estimate size with given slope using BINARY decisions
 * Elements are either kept entirely or removed entirely based on threshold
 * Uses accurate overhead calculation: outerHTML - sum(children.outerHTML)
 */
const estimateTreeSize = (
  element: Element,
  inheritedRatio: number,
  slope: number,
  sizeCache: Map<Element, number>
): number => {
  // Binary decision: if ratio < threshold, element is removed entirely
  if (inheritedRatio < REMOVAL_THRESHOLD) return 0;

  const children = Array.from(element.children);
  if (children.length === 0) {
    // Leaf kept entirely
    return sizeCache.get(element) || element.outerHTML.length;
  }

  // Inner node overhead = outerHTML - sum(children outerHTML)
  const mySize = sizeCache.get(element) || element.outerHTML.length;
  const childrenOuterSum = children.reduce(
    (sum, c) => sum + (sizeCache.get(c) || c.outerHTML.length), 0
  );
  const ownOverhead = Math.max(0, mySize - childrenOuterSum);

  let childrenSize = 0;
  const n = children.length;
  for (let i = 0; i < n; i++) {
    const childRatio = inheritedRatio * taperRatio(i, n, slope);
    childrenSize += estimateTreeSize(children[i], childRatio, slope, sizeCache);
  }

  return ownOverhead + childrenSize;
};

/**
 * Recursively apply slope - remove elements where ratio < threshold
 * No notices added to avoid size increase from many small removals
 */
const applyTreeSlope = (
  element: Element,
  inheritedRatio: number,
  slope: number
): void => {
  const children = Array.from(element.children);
  const n = children.length;
  if (n === 0) return;

  // Process in reverse to safely remove
  for (let i = n - 1; i >= 0; i--) {
    const childRatio = inheritedRatio * taperRatio(i, n, slope);

    if (childRatio < REMOVAL_THRESHOLD) {
      children[i].remove();
    } else {
      // Recurse into surviving children
      applyTreeSlope(children[i], childRatio, slope);
    }
  }
};

/**
 * Truncate DOM using binary search on taper slope
 * Treats entire page as nested lists - slope controls taper at each level
 */
const truncateDOM = (root: Element, doc: Document, debug = false) => {
  const targetSize = CONFIG.targetSize;
  const currentSize = measureSize(root);

  if (debug) {
    console.log(`[truncateDOM] currentSize=${currentSize}, targetSize=${targetSize}`);
  }

  if (currentSize <= targetSize) {
    if (debug) console.log('[truncateDOM] Skipped: already under target');
    return;
  }

  // Build size cache for accurate estimation
  const sizeCache = buildSizeCache(root);
  if (debug) {
    console.log(`[truncateDOM] Cached ${sizeCache.size} elements`);
  }

  // Binary search on slope, targeting slightly under to account for estimation error
  const searchTarget = targetSize * SAFETY_MARGIN;
  let low = 0;
  let high = 3; // Higher max for deep nesting
  const epsilon = 0.01;
  let iterations = 0;
  const maxIterations = 25;

  while (high - low > epsilon && iterations < maxIterations) {
    iterations++;
    const mid = (low + high) / 2;
    const estimated = estimateTreeSize(root, 1.0, mid, sizeCache);

    if (debug && iterations <= 5) {
      console.log(`[truncateDOM] slope=${mid.toFixed(3)}, estimated=${Math.round(estimated)}`);
    }

    if (estimated <= searchTarget) {
      high = mid; // Can use gentler slope
    } else {
      low = mid;  // Need steeper slope
    }
  }

  if (debug) {
    console.log(`[truncateDOM] Binary search slope=${high.toFixed(3)} after ${iterations} iterations`);
  }

  // Apply and verify - increase slope if still over target
  let slope = high;
  const maxRetries = 10;
  for (let retry = 0; retry < maxRetries; retry++) {
    applyTreeSlope(root, 1.0, slope);
    const newSize = measureSize(root);

    if (debug) {
      console.log(`[truncateDOM] Applied slope=${slope.toFixed(3)}, size=${newSize}`);
    }

    if (newSize <= targetSize) {
      break;
    }

    // Still over target - increase slope by 20%
    slope *= 1.2;
    if (debug) {
      console.log(`[truncateDOM] Still over target, increasing slope to ${slope.toFixed(3)}`);
    }
  }

  if (debug) {
    console.log(`[truncateDOM] Final size=${measureSize(root)}`);
  }
};

// ============================================================================
// MAIN EXPORT
// ============================================================================

export function cleanDOM(html: string, options: CleanDOMOptions = {}): CleanDOMResult {
  const {
    maxHtmlBytes = CONFIG.maxHtmlBytes,
    preserveQueryParams = false,
    removeHidden = true,
    shortenUrls = true,
    urlLengthThreshold = CONFIG.urlLengthThreshold,
    debug = false
  } = options;

  const urlRegistry: Record<string, string> = {};
  let urlCounter = 0;
  const shorten = (url: string, prefix = 'u') => {
    const ref = `[${prefix}${++urlCounter}]`;
    urlRegistry[ref] = url;
    return ref;
  };

  // Debug logging helper
  const debugLog: CleanupPhaseLog[] = [];
  const logPhase = (phase: string, sizeBefore: number, root: Element) => {
    if (!debug) return;
    const sizeAfter = root.innerHTML.length;
    const reduction = sizeBefore - sizeAfter;
    debugLog.push({
      phase,
      sizeBefore,
      sizeAfter,
      reduction,
      reductionPct: sizeBefore > 0 ? `${((reduction / sizeBefore) * 100).toFixed(1)}%` : '0%',
      elementCount: root.querySelectorAll('*').length
    });
  };

  // Empty input
  if (!html?.trim()) {
    return { mode: 'text', content: '', byteSize: 0, elementCount: 0 };
  }

  // Parse HTML
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    const stripped = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { mode: 'text', content: stripped, byteSize: new TextEncoder().encode(stripped).length, elementCount: 0 };
  }

  const root = doc.body || doc.documentElement;
  let currentSize = root.innerHTML.length;

  if (debug) {
    debugLog.push({
      phase: '0-parsed',
      sizeBefore: html.length,
      sizeAfter: currentSize,
      reduction: html.length - currentSize,
      reductionPct: `${(((html.length - currentSize) / html.length) * 100).toFixed(1)}%`,
      elementCount: root.querySelectorAll('*').length
    });
  }

  // ========== CLEANUP PHASES (remove noise, clean attributes) ==========

  // Phase 1: Remove noise tags and selectors
  currentSize = root.innerHTML.length;
  removeByTags(root, REMOVE_TAGS);
  removeBySelectors(root, REMOVE_SELECTORS);
  logPhase('1-removeTags+Selectors', currentSize, root);

  // Phase 2: Remove meaningless images (no/generic alt)
  currentSize = root.innerHTML.length;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const alt = img.getAttribute('alt')?.trim() || '';
    if (alt.length < CONFIG.minAltLength || GENERIC_ALT.has(alt.toLowerCase())) img.remove();
  }
  logPhase('2-removeImages', currentSize, root);

  // Phase 3: Remove site navigation (not content navigation)
  currentSize = root.innerHTML.length;
  for (const nav of Array.from(root.querySelectorAll('nav'))) {
    const label = (nav.getAttribute('aria-label') || '').toLowerCase();
    if (!['page', 'content', 'article', 'section'].some(k => label.includes(k))) nav.remove();
  }
  logPhase('3-removeNav', currentSize, root);

  // Phase 4: Heuristic noise detection (high link density = navigation)
  currentSize = root.innerHTML.length;
  for (const el of Array.from(root.querySelectorAll('div, aside, ul, nav'))) {
    if (el.innerHTML.length < CONFIG.noiseSizeThreshold) continue;
    if (el.querySelector('main, article, video, form, input, textarea, [data-vish-id]')) continue;
    const links = el.querySelectorAll('a');
    if (links.length < CONFIG.minLinkCount) continue;
    const textLen = el.textContent?.trim().length || 0;
    const linkTextLen = Array.from(links).reduce((s, a) => s + (a.textContent?.length || 0), 0);
    if (textLen > 0 && linkTextLen / textLen > CONFIG.maxLinkDensity) el.remove();
  }
  logPhase('4-heuristicNoise', currentSize, root);

  // Phase 5: Clean attributes and handle URLs
  currentSize = root.innerHTML.length;
  const allElements = root.getElementsByTagName('*');
  const elementCount = allElements.length;

  for (let i = allElements.length - 1; i >= 0; i--) {
    const el = allElements[i] as HTMLElement;

    // Remove hidden elements
    if (removeHidden && (el.style.display === 'none' || el.style.visibility === 'hidden' ||
        el.getAttribute('aria-hidden') === 'true' || el.hidden)) {
      el.remove();
      continue;
    }

    // Clean attributes (blacklist + heuristic truncation)
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();

      // Remove blacklisted attributes
      if (shouldRemoveAttr(name)) { el.removeAttribute(attr.name); continue; }

      // Handle href (URL shortening)
      if (name === 'href' && !attr.value.startsWith('javascript:') && !attr.value.startsWith('#')) {
        const clean = preserveQueryParams ? attr.value : cleanUrl(attr.value, CONFIG.keepParams);
        el.setAttribute('href', shortenUrls && clean.length > urlLengthThreshold ? shorten(clean) : clean);
      }
      // Handle src (data URIs and long URLs)
      else if (name === 'src') {
        if (attr.value.startsWith('data:')) el.setAttribute('src', shorten(attr.value, 'data'));
        else if (shortenUrls && attr.value.length > urlLengthThreshold) el.setAttribute('src', shorten(attr.value));
      }
      // Heuristic truncation for other attributes
      else if (attr.value.length > CONFIG.otherAttrThreshold) {
        if (isTextLike(attr.value)) {
          // Text-like: keep up to 50 chars
          if (attr.value.length > CONFIG.textAttrLimit) {
            el.setAttribute(name, attr.value.slice(0, CONFIG.textAttrLimit) + '...');
          }
        } else {
          // Hash/noise: truncate to 7 chars
          el.setAttribute(name, attr.value.slice(0, CONFIG.otherAttrKeep) + '...');
        }
      }
    }
  }
  logPhase('5-cleanAttrs+Hidden', currentSize, root);

  // Phase 6: Remove empty elements
  currentSize = root.innerHTML.length;
  const removeEmpty = (el: Element) => {
    Array.from(el.children).forEach(removeEmpty);
    if (REMOVE_IF_EMPTY.has(el.tagName.toLowerCase()) &&
        !el.textContent?.trim() && !el.children.length &&
        !el.querySelector('a, button, input, select, textarea, img, video, audio')) {
      el.remove();
    }
  };
  removeEmpty(root);
  logPhase('6-removeEmpty', currentSize, root);

  // Phase 7: Truncate long lists
  currentSize = root.innerHTML.length;
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    const items = list.querySelectorAll(':scope > li');
    if (items.length > CONFIG.maxListItems) {
      for (let i = CONFIG.maxListItems; i < items.length; i++) items[i].remove();
      const li = doc.createElement('li');
      li.textContent = `... (${items.length - CONFIG.maxListItems} more)`;
      list.appendChild(li);
    }
  }
  logPhase('7-truncateLists', currentSize, root);

  // Phase 8: Truncate long tables
  currentSize = root.innerHTML.length;
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const rows = table.querySelectorAll('tr');
    if (rows.length > CONFIG.maxTableRows + 1) {
      for (let i = CONFIG.maxTableRows + 1; i < rows.length; i++) rows[i].remove();
      const tr = doc.createElement('tr');
      const td = doc.createElement('td');
      td.textContent = `... (${rows.length - CONFIG.maxTableRows - 1} more rows)`;
      tr.appendChild(td);
      (table.querySelector('tbody') || table).appendChild(tr);
    }
  }
  logPhase('8-truncateTables', currentSize, root);

  // Phase 9: Collapse single-child wrappers
  currentSize = root.innerHTML.length;
  for (let iter = 0, changed = true; changed && iter < CONFIG.maxCollapseIterations; iter++) {
    changed = false;
    for (const el of Array.from(root.querySelectorAll('div, span'))) {
      if (el.children.length === 1 && !el.attributes.length &&
          !el.textContent?.trim().replace(el.children[0]?.textContent || '', '').trim()) {
        el.parentNode?.insertBefore(el.children[0], el);
        el.remove();
        changed = true;
      }
    }
  }
  logPhase('9-collapseWrappers', currentSize, root);

  // Phase 10: Collapse whitespace in text nodes
  currentSize = root.innerHTML.length;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    walker.currentNode.textContent = walker.currentNode.textContent?.replace(/\s+/g, ' ') || '';
  }
  logPhase('10-collapseWhitespace', currentSize, root);

  // ========== STRUCTURAL PHASES (truncation uses hierarchy, then flatten) ==========

  // Phase 11: Hierarchical budget-based truncation (hierarchy still intact)
  // Uses element tree structure to allocate budget: parents get more than children
  currentSize = root.innerHTML.length;
  truncateDOM(root, doc, debug);
  logPhase('11-truncateDOM', currentSize, root);

  // Phase 12: Unwrap framework wrappers (specific known tags)
  currentSize = root.innerHTML.length;
  unwrapTags(root, UNWRAP_TAGS);
  logPhase('12-unwrapTags', currentSize, root);

  // Phase 13: Unwrap all remaining custom elements (flattens hierarchy)
  currentSize = root.innerHTML.length;
  unwrapCustomElements(root);
  logPhase('13-unwrapCustom', currentSize, root);

  // Finalize
  const cleanedHtml = collapseWhitespace(root.innerHTML);
  const byteSize = new TextEncoder().encode(cleanedHtml).length;
  const registry = Object.keys(urlRegistry).length ? urlRegistry : undefined;

  if (debug) {
    debugLog.push({
      phase: '14-final',
      sizeBefore: root.innerHTML.length,
      sizeAfter: byteSize,
      reduction: root.innerHTML.length - byteSize,
      reductionPct: `${(((root.innerHTML.length - byteSize) / root.innerHTML.length) * 100).toFixed(1)}%`,
      elementCount: root.querySelectorAll('*').length
    });
  }

  if (byteSize > maxHtmlBytes) {
    const text = root.textContent?.replace(/\s+/g, ' ').trim() || '';
    return {
      mode: 'text',
      content: text,
      byteSize: new TextEncoder().encode(text).length,
      elementCount,
      urlRegistry: registry,
      debugLog: debug ? debugLog : undefined
    };
  }

  return {
    mode: 'html',
    content: cleanedHtml,
    byteSize,
    elementCount,
    urlRegistry: registry,
    debugLog: debug ? debugLog : undefined
  };
}

// ============================================================================
// TEXT EXTRACTION (fast fallback)
// ============================================================================

export function extractText(html: string): string {
  if (!html?.trim()) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.body || doc.documentElement;
    removeByTags(root, REMOVE_TAGS);
    return root.textContent?.replace(/\s+/g, ' ').trim() || '';
  } catch {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
