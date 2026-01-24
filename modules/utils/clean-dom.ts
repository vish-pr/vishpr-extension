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
  maxAriaLabel: 50,             // Truncate aria-labels at N chars
  maxAttrValue: 100,            // Truncate other attrs at N chars
  minAltLength: 3,              // Alt text shorter than this = meaningless
  maxCollapseIterations: 5,     // Prevent infinite loops in wrapper collapse

  // Hierarchical budget-based truncation (applied to entire DOM)
  // importance = text content (without tags), size = HTML size
  // Budget allocated with linear decay: earlier siblings get more
  targetSize: 45000,            // Target max HTML size after truncation
  decayRate: 0.4,               // Linear decay (0.4 = last child gets 60% of first's budget)
  minBudget: 100,               // Minimum budget per element before removal
  preserveRatio: 0.3,           // Always preserve at least 30% of children by count

  // URL params worth keeping (strip all others)
  keepParams: ['q', 'query', 'search', 's', 'page', 'p', 'id', 'tab', 'v'],
};

// ============================================================================
// TAG/SELECTOR DEFINITIONS
// ============================================================================

const KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'type', 'value', 'placeholder',
  'data-vish-id', 'role', 'aria-label'
]);

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

// Comment container patterns for hierarchical truncation
// Each entry: [containerSelector, itemSelector, replyContainerSelector?]
const COMMENT_PATTERNS: Array<{ container: string; item: string; replies?: string }> = [
  // YouTube
  { container: 'ytd-comments', item: 'ytd-comment-thread-renderer', replies: 'ytd-comment-replies-renderer' },
  // Reddit (new design)
  { container: 'shreddit-comment-tree', item: 'shreddit-comment' },
  { container: '[data-testid="comments-page"]', item: 'shreddit-comment' },
  // Reddit (old design)
  { container: '.commentarea', item: '.comment' },
  // Hacker News
  { container: '.comment-tree', item: '.athing.comtr' },
  // Generic patterns (class/id containing "comment")
  { container: '[class*="comment-list"], [class*="comments-list"], [id*="comments"]', item: '[class*="comment-item"], [class*="comment-thread"], [class*="comment "]' },
  // Disqus
  { container: '#disqus_thread', item: '.post' },
  // Facebook
  { container: '[data-testid="UFI2CommentsProvider"]', item: '[data-testid="UFI2Comment"]' },
];

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
    const url = new URL(href, 'http://example.com');
    const params = new URLSearchParams();
    for (const p of keepParams) {
      if (url.searchParams.has(p)) params.set(p, url.searchParams.get(p)!);
    }
    let clean = url.origin + url.pathname;
    const paramStr = params.toString();
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
// HIERARCHICAL TRUNCATION (DFS with importance-based budgeting)
// ============================================================================

/**
 * Measure actual element size using innerHTML length
 * Previously used text * 1.5 estimate, but this was wildly inaccurate
 * for sites like YouTube with deep nesting and custom elements (32x underestimate)
 */
const measureSize = (element: Element): number => {
  return element.innerHTML.length;
};

/**
 * Generalized hierarchical truncation using DFS
 * Uses text content as importance metric, actual HTML size for budget
 *
 * @param element - Element to truncate
 * @param budget - Available character budget for this subtree
 * @param doc - Document for creating elements
 * @param depth - Current recursion depth
 * @returns Actual HTML size after truncation
 */
const truncateByBudget = (
  element: Element,
  budget: number,
  doc: Document,
  depth = 0
): number => {
  void depth; // Used only in base case check
  const maxDepth = 3;
  const maxChildrenToProcess = 100; // Limit for performance
  const decayRate = CONFIG.decayRate;
  const minBudget = CONFIG.minBudget;

  // Base case: max depth or small enough
  const estSize = measureSize(element);
  if (depth >= maxDepth || estSize <= budget) {
    return estSize;
  }

  // Get children with content (limit for performance)
  const allChildren = Array.from(element.children);
  const children = allChildren.filter(c =>
    c.textContent?.trim() && !c.hasAttribute('data-truncated')
  ).slice(0, maxChildrenToProcess * 2); // Pre-filter limit

  if (children.length === 0) {
    return estSize;
  }

  // Calculate importance (text length) for each child - fast operation
  const childData = children.map(child => ({
    element: child,
    importance: child.textContent?.length || 0,
    estSize: measureSize(child)
  }));

  const totalImportance = childData.reduce((sum, c) => sum + c.importance, 0);
  if (totalImportance === 0) return estSize;

  // Calculate weights with linear decay
  const weights: number[] = [];
  let totalWeight = 0;
  for (let i = 0; i < children.length; i++) {
    const posWeight = 1 - (i / children.length) * decayRate;
    const impWeight = childData[i].importance / totalImportance;
    const w = posWeight * 0.6 + impWeight * children.length * 0.4;
    weights.push(w);
    totalWeight += w;
  }

  let usedBudget = 0;
  let truncatedAt = -1;

  for (let i = 0; i < children.length; i++) {
    const data = childData[i];
    const itemBudget = Math.floor((budget * weights[i]) / totalWeight);
    const remaining = budget - usedBudget;

    if (remaining < minBudget) {
      truncatedAt = i;
      break;
    }

    const effectiveBudget = Math.min(itemBudget, remaining);

    if (data.estSize <= effectiveBudget) {
      usedBudget += data.estSize;
    } else {
      // Recursively truncate
      const used = truncateByBudget(data.element, effectiveBudget, doc, depth + 1);
      usedBudget += used;
    }
  }

  // Remove truncated elements, preserving minimum ratio
  const minPreserve = Math.max(1, Math.ceil(children.length * CONFIG.preserveRatio));
  if (truncatedAt >= 0 && truncatedAt < children.length) {
    const actualCutoff = Math.max(truncatedAt, minPreserve);
    if (actualCutoff < children.length) {
      const removedCount = children.length - actualCutoff;
      const removedText = childData.slice(actualCutoff).reduce((s, c) => s + c.importance, 0);

      for (let i = actualCutoff; i < children.length; i++) {
        children[i].remove();
      }

      if (removedCount > 0 && removedText > 100) {
        const notice = doc.createElement('span');
        notice.textContent = ` [+${removedCount} more, ~${Math.round(removedText / 1000)}k text]`;
        notice.setAttribute('data-truncated', String(removedCount));
        element.appendChild(notice);
      }
    }
  }

  return measureSize(element);
};

/**
 * Fast truncation for very large element lists
 * Simply removes excess items without recursing
 */
const fastTruncateChildren = (element: Element, keepCount: number, doc: Document) => {
  const children = Array.from(element.children).filter(c =>
    c.textContent?.trim() && !c.hasAttribute('data-truncated')
  );

  if (children.length <= keepCount) return;

  const removedCount = children.length - keepCount;
  const removedText = children.slice(keepCount).reduce(
    (sum, c) => sum + (c.textContent?.length || 0), 0
  );

  for (let i = keepCount; i < children.length; i++) {
    children[i].remove();
  }

  if (removedCount > 0) {
    const notice = doc.createElement('span');
    notice.textContent = ` [+${removedCount} more, ~${Math.round(removedText / 1000)}k text]`;
    notice.setAttribute('data-truncated', String(removedCount));
    element.appendChild(notice);
  }
};

/**
 * Apply hierarchical truncation to the entire DOM
 * Uses fast path for very large content
 */
const truncateDOM = (root: Element, doc: Document, debug = false) => {
  const targetSize = CONFIG.targetSize;
  const currentSize = measureSize(root);

  if (debug) {
    console.log(`[truncateDOM] currentSize=${currentSize}, targetSize=${targetSize}, threshold=${targetSize * 1.2}`);
  }

  // Skip if already under target or only slightly over
  if (currentSize <= targetSize * 1.2) {
    if (debug) console.log('[truncateDOM] Skipped: under threshold');
    return;
  }

  // For very large DOMs (>500KB HTML), use fast path
  if (currentSize > 500000) {
    // Find large containers - use lower thresholds for YouTube-style DOMs
    const containers = Array.from(root.querySelectorAll('*')).filter(el =>
      el.children.length > 10 && measureSize(el) > 5000
    );

    if (debug) {
      console.log(`[truncateDOM] Fast path: found ${containers.length} large containers`);
    }

    // Sort by size descending and truncate the largest ones
    containers.sort((a, b) => measureSize(b) - measureSize(a));

    const keepRatio = Math.max(0.05, targetSize / currentSize); // More aggressive: 5% minimum
    if (debug) console.log(`[truncateDOM] keepRatio=${keepRatio.toFixed(3)}`);

    for (const container of containers.slice(0, 50)) { // Process top 50 largest
      const childCount = container.children.length;
      const containerSize = measureSize(container);
      const keepCount = Math.max(3, Math.ceil(childCount * keepRatio)); // Keep at least 3

      if (debug && childCount > keepCount) {
        console.log(`[truncateDOM] Truncating ${container.tagName}: ${childCount} children → ${keepCount}, size=${containerSize}`);
      }

      fastTruncateChildren(container, keepCount, doc);
    }
    return;
  }

  // Normal path for moderate-sized DOMs
  if (debug) console.log('[truncateDOM] Using budget-based truncation');
  truncateByBudget(root, targetSize, doc);
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

    // Clean attributes
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!KEEP_ATTRS.has(name)) { el.removeAttribute(attr.name); continue; }

      // Handle href
      if (name === 'href' && !attr.value.startsWith('javascript:') && !attr.value.startsWith('#')) {
        const clean = preserveQueryParams ? attr.value : cleanUrl(attr.value, CONFIG.keepParams);
        el.setAttribute('href', shortenUrls && clean.length > urlLengthThreshold ? shorten(clean) : clean);
      }
      // Handle src (data URIs and long URLs)
      else if (name === 'src') {
        if (attr.value.startsWith('data:')) el.setAttribute('src', shorten(attr.value, 'data'));
        else if (shortenUrls && attr.value.length > urlLengthThreshold) el.setAttribute('src', shorten(attr.value));
      }
      // Truncate long values
      else if (name === 'aria-label' && attr.value.length > CONFIG.maxAriaLabel) {
        el.setAttribute(name, attr.value.slice(0, CONFIG.maxAriaLabel) + '...');
      }
      else if (attr.value.length > CONFIG.maxAttrValue) {
        el.setAttribute(name, attr.value.slice(0, CONFIG.maxAttrValue) + '...');
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
