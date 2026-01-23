/**
 * DOM Cleaner - Preserves structure while removing noise
 * Returns cleaned HTML when small enough, falls back to text extraction
 */

// Attributes to always remove (tracking, styling, JS framework garbage)
const REMOVE_ATTRIBUTES = new Set([
  // Google/tracking
  'data-ved', 'ved', 'eid', 'data-csiid', 'data-async-fc', 'ping',
  // JS frameworks
  'jsaction', 'jscontroller', 'jsmodel', 'jsdata', 'jsname',
  // Styling (visual info lost anyway without CSS)
  'style', 'class',
  // Events
  'onclick', 'onmouseover', 'onmouseout', 'onfocus', 'onblur', 'onload', 'onerror'
]);

// data-* attributes to KEEP (semantic/state info)
const KEEP_DATA_ATTRS = new Set([
  'data-vish-id',     // Our element IDs for interaction
  'data-testid',      // Often describes element purpose
  'data-id',          // Entity IDs
  'data-product-id',
  'data-item-id',
  'data-page',
  'data-index',
  'data-value',
  'data-state',
  'data-selected',
  'data-disabled',
  'data-expanded',
  'data-active'
]);

// aria-* attributes to KEEP (accessibility = semantics)
const KEEP_ARIA_ATTRS = new Set([
  'aria-label',       // Element description
  'aria-labelledby',  // Reference to label
  'aria-describedby', // Reference to description
  'aria-expanded',    // State
  'aria-selected',
  'aria-checked',
  'aria-disabled',
  'aria-hidden',
  'aria-current',
  'aria-pressed',
  'role'              // Semantic role
]);

// Tags to completely remove (noise)
const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'object', 'embed',
  'link', 'meta', 'template'
]);

// Tags to remove if empty or just whitespace
const REMOVE_IF_EMPTY = new Set([
  'div', 'span', 'p', 'section', 'article', 'aside', 'header', 'footer',
  'nav', 'main', 'figure', 'figcaption', 'li', 'ul', 'ol', 'dl', 'dt', 'dd'
]);

export interface CleanDOMResult {
  mode: 'html' | 'text';
  content: string;
  byteSize: number;
  elementCount: number;
}

export interface CleanDOMOptions {
  maxHtmlBytes?: number;      // Fallback to text if HTML exceeds this (default: 50KB)
  preserveQueryParams?: boolean;  // Keep URL query params (default: false)
  removeHidden?: boolean;     // Remove display:none elements (default: true)
}

/**
 * Clean DOM while preserving structure and essential attributes
 */
export function cleanDOM(html: string, options: CleanDOMOptions = {}): CleanDOMResult {
  const {
    maxHtmlBytes = 50000,
    preserveQueryParams = false,
    removeHidden = true
  } = options;

  // Handle empty/missing input
  if (!html || typeof html !== 'string' || !html.trim()) {
    return {
      mode: 'text',
      content: '',
      byteSize: 0,
      elementCount: 0
    };
  }

  let doc: Document;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(html, 'text/html');
  } catch {
    // Malformed HTML - return raw text stripped of tags
    const stripped = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      mode: 'text',
      content: stripped,
      byteSize: new TextEncoder().encode(stripped).length,
      elementCount: 0
    };
  }

  const root = doc.body || doc.documentElement;

  // Phase 1: Remove noise tags entirely
  for (const tagName of Array.from(REMOVE_TAGS)) {
    const elements = root.getElementsByTagName(tagName);
    while (elements.length > 0) {
      elements[0].parentNode?.removeChild(elements[0]);
    }
  }

  // Phase 2: Remove stylesheet link tags
  const links = root.getElementsByTagName('link');
  for (let i = links.length - 1; i >= 0; i--) {
    if (links[i].getAttribute('rel') === 'stylesheet') {
      links[i].parentNode?.removeChild(links[i]);
    }
  }

  // Phase 3: Clean attributes on all elements
  const allElements = root.getElementsByTagName('*');
  const elementCount = allElements.length;

  for (let i = allElements.length - 1; i >= 0; i--) {
    const el = allElements[i] as HTMLElement;

    // Remove hidden elements if requested
    if (removeHidden) {
      const computedStyle = el.style;
      if (computedStyle.display === 'none' ||
          computedStyle.visibility === 'hidden' ||
          el.getAttribute('aria-hidden') === 'true' ||
          el.hidden) {
        el.parentNode?.removeChild(el);
        continue;
      }
    }

    // Clean attributes
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();

      // Always remove these
      if (REMOVE_ATTRIBUTES.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }

      // Handle data-* attributes
      if (name.startsWith('data-')) {
        if (!KEEP_DATA_ATTRS.has(name)) {
          el.removeAttribute(attr.name);
        }
        continue;
      }

      // Handle aria-* attributes
      if (name.startsWith('aria-')) {
        if (!KEEP_ARIA_ATTRS.has(name)) {
          el.removeAttribute(attr.name);
        }
        continue;
      }

      // Handle href - optionally strip query params
      if (name === 'href' && !preserveQueryParams) {
        const href = attr.value;
        // Only strip query params from same-site navigation links
        // Keep params for external links and dynamic pages
        if (href && !href.startsWith('javascript:') && !href.includes('#')) {
          try {
            const url = new URL(href, 'http://example.com');
            // Keep query params for search, filter, sort etc.
            const keepParams = ['q', 'query', 'search', 's', 'page', 'p', 'id', 'tab'];
            const hasImportantParams = keepParams.some(p => url.searchParams.has(p));
            if (!hasImportantParams && url.search) {
              el.setAttribute('href', href.split('?')[0]);
            }
          } catch {
            // Invalid URL, leave as-is
          }
        }
      }

      // Truncate long attribute values (>100 chars) to reduce size
      if (attr.value.length > 100) {
        el.setAttribute(attr.name, attr.value.substring(0, 100) + '...');
      }
    }
  }

  // Phase 4: Remove empty elements (bottom-up to handle nested empties)
  const removeEmpty = (element: Element) => {
    const children = Array.from(element.children);
    for (const child of children) {
      removeEmpty(child);
    }

    const tagLower = element.tagName.toLowerCase();
    if (REMOVE_IF_EMPTY.has(tagLower)) {
      const hasText = element.textContent?.trim();
      const hasChildren = element.children.length > 0;
      const hasInteractive = element.querySelector('a, button, input, select, textarea, img, video, audio');

      if (!hasText && !hasChildren && !hasInteractive) {
        element.parentNode?.removeChild(element);
      }
    }
  };
  removeEmpty(root);

  // Phase 5: Collapse excessive whitespace in text nodes
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }
  for (const node of textNodes) {
    node.textContent = node.textContent?.replace(/\s+/g, ' ') || '';
  }

  // Get cleaned HTML
  const cleanedHtml = root.innerHTML;
  const byteSize = new TextEncoder().encode(cleanedHtml).length;

  // Fallback to text if too large
  if (byteSize > maxHtmlBytes) {
    const textContent = root.textContent?.replace(/\s+/g, ' ').trim() || '';
    return {
      mode: 'text',
      content: textContent,
      byteSize: new TextEncoder().encode(textContent).length,
      elementCount
    };
  }

  return {
    mode: 'html',
    content: cleanedHtml,
    byteSize,
    elementCount
  };
}

/**
 * Extract just text content (fast fallback)
 */
export function extractText(html: string): string {
  // Handle empty/missing input
  if (!html || typeof html !== 'string' || !html.trim()) {
    return '';
  }

  let doc: Document;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(html, 'text/html');
  } catch {
    // Malformed HTML - strip tags with regex as fallback
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const root = doc.body || doc.documentElement;

  // Remove noise tags
  for (const tagName of Array.from(REMOVE_TAGS)) {
    const elements = root.getElementsByTagName(tagName);
    while (elements.length > 0) {
      elements[0].parentNode?.removeChild(elements[0]);
    }
  }

  return root.textContent?.replace(/\s+/g, ' ').trim() || '';
}
