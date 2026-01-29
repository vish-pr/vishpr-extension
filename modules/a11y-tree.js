// Accessibility Tree Extraction Module
// Extracted from content.js for testability

// Role mapping based on HTML tag
export const IMPLICIT_ROLES = {
  a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading',
  h4: 'heading', h5: 'heading', h6: 'heading', img: 'img', input: 'textbox',
  select: 'combobox', textarea: 'textbox', nav: 'navigation', main: 'main',
  header: 'banner', footer: 'contentinfo', article: 'article', section: 'region',
  aside: 'complementary', form: 'form', table: 'table', ul: 'list', ol: 'list',
  li: 'listitem', dialog: 'dialog', progress: 'progressbar', meter: 'meter',
  tr: 'row', td: 'cell', th: 'columnheader'
};

export const INPUT_TYPE_ROLES = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button',
  submit: 'button', reset: 'button', search: 'searchbox', email: 'textbox',
  tel: 'textbox', url: 'textbox', number: 'spinbutton'
};

// Structural roles that can be collapsed if they have no name
export const STRUCTURAL_ROLES = new Set([
  'presentation', 'none', 'group', 'row', 'cell', 'gridcell', 'rowgroup',
  'table', 'grid', 'treegrid', 'rowheader', 'columnheader'
]);

export function computeRole(element) {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;

  const tag = element.tagName.toLowerCase();

  if (tag === 'input') {
    const type = element.getAttribute('type') || 'text';
    return INPUT_TYPE_ROLES[type] || 'textbox';
  }

  return IMPLICIT_ROLES[tag] || null;
}

export function computeAccessibleName(element, doc, isContentContainer = false) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const names = labelledBy.split(/\s+/)
      .map(id => doc.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (names.length) return names.join(' ');
  }

  if (element.id) {
    const label = doc.querySelector(`label[for="${element.id}"]`);
    if (label) return label.textContent?.trim() || '';
  }

  if (element.tagName.toLowerCase() === 'img') {
    return element.getAttribute('alt') || '';
  }

  const title = element.getAttribute('title');
  if (title) return title.trim();

  if (element.placeholder) return element.placeholder;

  // For content containers, extract full text (up to 500 chars)
  if (isContentContainer) {
    const fullText = element.textContent?.trim().replace(/\s+/g, ' ') || '';
    if (fullText.length > 0) {
      return fullText.length <= 500 ? fullText : fullText.substring(0, 500) + '...';
    }
  }

  // For other elements, only use direct text (not descendants) to reduce noise
  let directText = '';
  for (const node of element.childNodes) {
    if (node.nodeType === 3) { // TEXT_NODE
      directText += node.textContent;
    }
  }
  directText = directText.trim().replace(/\s+/g, ' ');
  if (directText && directText.length <= 80) return directText;

  return '';
}

// Check if element is a content container (has substantial text)
export function isContentContainer(element, children) {
  // Must have substantial text content
  const text = element.textContent?.trim() || '';
  if (text.length < 50) return false;

  // Check if it's a known content container role or tag
  const role = element.getAttribute('role');
  const tag = element.tagName.toLowerCase();

  // These are typically content containers - capture even with children
  if (['article', 'main', 'region', 'section'].includes(role)) return children.length === 0;
  if (['article', 'section', 'p', 'blockquote'].includes(tag)) return children.length === 0;

  // Table cells and list items - capture if no semantic children OR text is substantial
  if (['cell', 'gridcell', 'listitem'].includes(role)) {
    // If has semantic children, only capture if they don't have much text themselves
    if (children.length > 0) {
      const childrenText = children.map(c => c.name || '').join('').length;
      return text.length > childrenText + 100; // Capture if element has significantly more text
    }
    return true;
  }
  if (['td', 'th', 'li', 'dd'].includes(tag)) {
    if (children.length > 0) {
      const childrenText = children.map(c => c.name || '').join('').length;
      return text.length > childrenText + 100;
    }
    return true;
  }

  // Divs/spans with substantial text - only if no semantic children
  if (['div', 'span'].includes(tag) && text.length > 80 && children.length === 0) {
    return true;
  }

  return false;
}

export function isInteractiveA11y(element) {
  const tag = element.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
  if (element.getAttribute('tabindex') !== null) return true;
  if (element.getAttribute('onclick')) return true;
  if (element.getAttribute('jsaction')) return true; // Gmail uses jsaction
  if (element.getAttribute('role')?.match(/button|link|checkbox|radio|textbox|combobox|slider|switch|tab|menuitem|option|row|gridcell/)) return true;
  return false;
}

export function isHiddenA11y(element) {
  if (element.hidden) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  const style = element.getAttribute('style') || '';
  if (style.includes('display: none') || style.includes('display:none')) return true;
  if (style.includes('visibility: hidden') || style.includes('visibility:hidden')) return true;
  return false;
}

/**
 * Build accessibility tree from document
 * @param {Document} doc - The document to process (for testability)
 * @returns {{ tree: object, refCount: number, refMap: object }}
 */
export function buildAccessibilityTree(doc) {
  const refMap = {};
  let refCounter = 0;

  function processNode(element, depth = 0) {
    if (isHiddenA11y(element)) return null;
    if (depth > 100) return null; // Prevent deep recursion

    // Skip non-content elements
    const tag = element.tagName.toLowerCase();
    if (['style', 'script', 'noscript', 'template'].includes(tag)) return null;

    const role = computeRole(element);
    const interactive = isInteractiveA11y(element);

    // Process children first
    let children = [];
    for (const child of element.children) {
      const childNode = processNode(child, depth + 1);
      if (childNode) children.push(childNode);
    }

    // Check if this is a content container (leaf with substantial text)
    const isContainer = isContentContainer(element, children);

    // Compute name with content container awareness
    const name = computeAccessibleName(element, doc, isContainer);

    // Skip non-semantic elements without meaningful content or children
    if (!role && !name && !interactive && children.length === 0) {
      return null;
    }

    // Collapse pass-through nodes: no meaningful content
    const isStructural = STRUCTURAL_ROLES.has(role);
    const isMeaningfulInteractive = interactive && (name || role);
    const isPassThrough = !name && !isMeaningfulInteractive && (!role || isStructural);

    if (isPassThrough) {
      // If single child, return that child directly (collapse this level)
      if (children.length === 1) {
        return children[0];
      }
      // If multiple children, keep as anonymous container (no ref)
      if (children.length > 1) {
        return { children };
      }
      // No children - skip entirely
      return null;
    }

    const node = {};

    // Assign ref only to meaningful nodes
    const needsRef = isMeaningfulInteractive || (role && !isStructural) || (role && name);
    if (needsRef) {
      const ref = `e${++refCounter}`;
      node.ref = ref;
      refMap[ref] = element;
      element.setAttribute('data-vish-ref', ref);
    }

    if (role) node.role = role;
    if (name) node.name = name;

    // Add state info
    if (element.checked) node.checked = true;
    if (element.selected) node.selected = true;
    if (element.disabled) node.disabled = true;
    const expanded = element.getAttribute('aria-expanded');
    if (expanded) node.expanded = expanded === 'true';
    const pressed = element.getAttribute('aria-pressed');
    if (pressed) node.pressed = pressed === 'true';
    const selected = element.getAttribute('aria-selected');
    if (selected) node.selected = selected === 'true';

    if (children.length > 0) {
      node.children = children;
    }

    return node;
  }

  const tree = processNode(doc.body);

  return { tree, refCount: refCounter, refMap };
}

export function serializeForLLM(tree, indent = 0) {
  if (!tree) return '';

  const pad = '  '.repeat(indent);
  let lines = [];

  let parts = [];
  if (tree.ref) parts.push(`[${tree.ref}]`);
  if (tree.role) parts.push(tree.role);
  if (tree.name) parts.push(`"${tree.name}"`);
  if (tree.checked) parts.push('(checked)');
  if (tree.disabled) parts.push('(disabled)');
  if (tree.selected) parts.push('(selected)');
  if (tree.expanded !== undefined) parts.push(tree.expanded ? '(expanded)' : '(collapsed)');
  if (tree.pressed !== undefined) parts.push(tree.pressed ? '(pressed)' : '(not pressed)');

  if (parts.length > 0) {
    lines.push(pad + parts.join(' '));
  }

  if (tree.children) {
    for (const child of tree.children) {
      const childLines = serializeForLLM(child, indent + 1);
      if (childLines) lines.push(childLines);
    }
  }

  return lines.join('\n');
}
