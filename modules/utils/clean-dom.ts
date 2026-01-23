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

  // Character-budget based hierarchical truncation
  // Uses budget allocation with linear decay for nested lists
  listBudget: 30000,            // Total character budget for list-like content
  budgetDecayRate: 0.6,         // Items later in list get less budget (0.6 = last gets 40% of first)
  minItemBudget: 100,           // Minimum chars per item before truncating

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
}

export interface CleanDOMOptions {
  maxHtmlBytes?: number;
  preserveQueryParams?: boolean;
  removeHidden?: boolean;
  shortenUrls?: boolean;
  urlLengthThreshold?: number;
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

/**
 * Character-budget based hierarchical truncation
 *
 * Treats any repeating element structure as a list and allocates character
 * budget with linear decay: earlier items get more budget than later ones.
 * Nested lists inherit remaining budget from their parent item.
 *
 * @returns Number of characters used
 */
const truncateWithBudget = (
  element: Element,
  budget: number,
  decayRate: number,
  doc: Document,
  depth = 0
): number => {
  // depth is used for recursive calls but not currently for logic
  void depth;
  const minBudget = CONFIG.minItemBudget;

  // Find list-like children (groups of 3+ similar elements)
  const childGroups = findListGroups(element);

  if (childGroups.length === 0) {
    // No list-like structure, just return text length
    return element.textContent?.length || 0;
  }

  let totalUsed = 0;

  for (const group of childGroups) {
    const { items, parent } = group;
    if (items.length < 3) continue; // Not really a list

    // Calculate budget for this group (proportional to current remaining budget)
    const groupBudget = Math.min(budget - totalUsed, budget * 0.8);
    if (groupBudget < minBudget) break;

    // Calculate weights with linear decay
    // weight[i] = 1 - (i / n) * decayRate
    // So first item weight = 1, last item weight = 1 - decayRate
    const weights: number[] = [];
    let totalWeight = 0;
    for (let i = 0; i < items.length; i++) {
      const w = 1 - (i / items.length) * decayRate;
      weights.push(w);
      totalWeight += w;
    }

    let usedInGroup = 0;
    let truncatedAt = -1;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemWeight = weights[i];
      const itemBudget = Math.floor((groupBudget * itemWeight) / totalWeight);
      const remainingGroupBudget = groupBudget - usedInGroup;

      // Stop if we're out of budget
      if (remainingGroupBudget < minBudget) {
        truncatedAt = i;
        break;
      }

      const effectiveBudget = Math.min(itemBudget, remainingGroupBudget);
      const itemSize = item.textContent?.length || 0;

      if (itemSize <= effectiveBudget) {
        // Item fits within budget, recursively truncate nested lists
        const nestedUsed = truncateWithBudget(item, effectiveBudget, decayRate, doc, depth + 1);
        usedInGroup += nestedUsed;
      } else {
        // Item exceeds budget, try to truncate its nested content
        const nestedUsed = truncateWithBudget(item, effectiveBudget, decayRate, doc, depth + 1);
        usedInGroup += nestedUsed;

        // If still way over budget after nested truncation, stop here
        if (nestedUsed > effectiveBudget * 1.5) {
          truncatedAt = i + 1;
          break;
        }
      }
    }

    // Remove truncated items
    if (truncatedAt >= 0 && truncatedAt < items.length) {
      const removedCount = items.length - truncatedAt;
      const removedChars = items.slice(truncatedAt).reduce(
        (sum, el) => sum + (el.textContent?.length || 0), 0
      );

      for (let i = truncatedAt; i < items.length; i++) {
        items[i].remove();
      }

      // Add truncation notice
      if (parent && removedCount > 0) {
        const notice = doc.createElement('span');
        notice.textContent = ` [+${removedCount} more, ~${Math.round(removedChars / 1000)}k chars]`;
        notice.setAttribute('data-truncated', String(removedCount));
        parent.appendChild(notice);
      }
    }

    totalUsed += usedInGroup;
  }

  return totalUsed;
};

/**
 * Find groups of similar child elements (list-like structures)
 */
const findListGroups = (element: Element): Array<{ items: Element[]; parent: Element }> => {
  const groups: Array<{ items: Element[]; parent: Element }> = [];
  const processed = new Set<Element>();

  // Helper to get element signature (tag + key classes)
  const getSignature = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList)
      .filter(c => /item|comment|thread|post|reply|card|row|entry/i.test(c))
      .sort()
      .join('.');
    return classes ? `${tag}.${classes}` : tag;
  };

  // Walk through all descendants looking for list-like patterns
  const containers = [element, ...Array.from(element.querySelectorAll('*'))];

  for (const container of containers) {
    if (processed.has(container)) continue;

    const children = Array.from(container.children).filter(c =>
      c.textContent?.trim() && !processed.has(c)
    );
    if (children.length < 3) continue;

    // Group children by signature
    const bySignature = new Map<string, Element[]>();
    for (const child of children) {
      const sig = getSignature(child);
      if (!bySignature.has(sig)) bySignature.set(sig, []);
      bySignature.get(sig)!.push(child);
    }

    // Add groups of 3+ similar items
    for (const [, items] of bySignature) {
      if (items.length >= 3) {
        groups.push({ items, parent: container });
        items.forEach(item => processed.add(item));
      }
    }
  }

  return groups;
};

/**
 * Truncate hierarchical list-like content using character budgets
 * Detects comment threads, repeated items, and nested structures
 */
const truncateHierarchicalLists = (root: Element, doc: Document) => {
  const budget = CONFIG.listBudget;
  const decayRate = CONFIG.budgetDecayRate;

  // Strategy 1: Use known comment patterns to find containers
  for (const pattern of COMMENT_PATTERNS) {
    try {
      const containers = root.querySelectorAll(pattern.container);
      for (const container of Array.from(containers)) {
        truncateWithBudget(container, budget, decayRate, doc);
      }
    } catch { /* Selector may not be valid */ }
  }

  // Strategy 2: Find any large list-like structures not covered by patterns
  const largeElements = Array.from(root.querySelectorAll('*')).filter(el => {
    const size = el.textContent?.length || 0;
    return size > budget && el.children.length >= 5;
  });

  for (const el of largeElements) {
    // Skip if already processed (inside a comment container)
    let isNested = false;
    for (const pattern of COMMENT_PATTERNS) {
      try {
        if (el.closest(pattern.container)) {
          isNested = true;
          break;
        }
      } catch {}
    }
    if (!isNested) {
      truncateWithBudget(el, budget, decayRate, doc);
    }
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
    urlLengthThreshold = CONFIG.urlLengthThreshold
  } = options;

  const urlRegistry: Record<string, string> = {};
  let urlCounter = 0;
  const shorten = (url: string, prefix = 'u') => {
    const ref = `[${prefix}${++urlCounter}]`;
    urlRegistry[ref] = url;
    return ref;
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

  // Phase 1: Remove noise tags and selectors
  removeByTags(root, REMOVE_TAGS);
  removeBySelectors(root, REMOVE_SELECTORS);

  // Phase 2: Truncate hierarchical list-like content (comments, feeds, etc.)
  truncateHierarchicalLists(root, doc);

  // Phase 3: Remove meaningless images (no/generic alt)
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const alt = img.getAttribute('alt')?.trim() || '';
    if (alt.length < CONFIG.minAltLength || GENERIC_ALT.has(alt.toLowerCase())) img.remove();
  }

  // Phase 4: Remove site navigation (not content navigation)
  for (const nav of Array.from(root.querySelectorAll('nav'))) {
    const label = (nav.getAttribute('aria-label') || '').toLowerCase();
    if (!['page', 'content', 'article', 'section'].some(k => label.includes(k))) nav.remove();
  }

  // Phase 5: Heuristic noise detection (high link density = navigation)
  for (const el of Array.from(root.querySelectorAll('div, aside, ul, nav'))) {
    if (el.innerHTML.length < CONFIG.noiseSizeThreshold) continue;
    if (el.querySelector('main, article, video, form, input, textarea, [data-vish-id]')) continue;
    const links = el.querySelectorAll('a');
    if (links.length < CONFIG.minLinkCount) continue;
    const textLen = el.textContent?.trim().length || 0;
    const linkTextLen = Array.from(links).reduce((s, a) => s + (a.textContent?.length || 0), 0);
    if (textLen > 0 && linkTextLen / textLen > CONFIG.maxLinkDensity) el.remove();
  }

  // Phase 6: Unwrap framework wrappers
  unwrapTags(root, UNWRAP_TAGS);

  // Phase 7: Clean attributes and handle URLs
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

  // Phase 8: Remove empty elements
  const removeEmpty = (el: Element) => {
    Array.from(el.children).forEach(removeEmpty);
    if (REMOVE_IF_EMPTY.has(el.tagName.toLowerCase()) &&
        !el.textContent?.trim() && !el.children.length &&
        !el.querySelector('a, button, input, select, textarea, img, video, audio')) {
      el.remove();
    }
  };
  removeEmpty(root);

  // Phase 9: Unwrap remaining custom elements
  unwrapCustomElements(root);

  // Phase 10: Truncate long lists
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    const items = list.querySelectorAll(':scope > li');
    if (items.length > CONFIG.maxListItems) {
      for (let i = CONFIG.maxListItems; i < items.length; i++) items[i].remove();
      const li = doc.createElement('li');
      li.textContent = `... (${items.length - CONFIG.maxListItems} more)`;
      list.appendChild(li);
    }
  }

  // Phase 11: Truncate long tables
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

  // Phase 12: Collapse single-child wrappers
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

  // Phase 13: Collapse whitespace in text nodes
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    walker.currentNode.textContent = walker.currentNode.textContent?.replace(/\s+/g, ' ') || '';
  }

  // Finalize
  const cleanedHtml = collapseWhitespace(root.innerHTML);
  const byteSize = new TextEncoder().encode(cleanedHtml).length;
  const registry = Object.keys(urlRegistry).length ? urlRegistry : undefined;

  if (byteSize > maxHtmlBytes) {
    const text = root.textContent?.replace(/\s+/g, ' ').trim() || '';
    return { mode: 'text', content: text, byteSize: new TextEncoder().encode(text).length, elementCount, urlRegistry: registry };
  }

  return { mode: 'html', content: cleanedHtml, byteSize, elementCount, urlRegistry: registry };
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
