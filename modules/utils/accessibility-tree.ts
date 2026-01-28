/**
 * Accessibility Tree Utilities
 * Types and helper functions for working with accessibility tree data
 */

// Accessibility tree node structure returned from content script
export interface A11yNode {
  ref?: string;
  role?: string;
  name?: string;
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  value?: string;
  children?: A11yNode[];
}

// Result from extractAccessibilityTree content script action
export interface A11yTreeResult {
  success: boolean;
  mode?: 'a11y';
  content?: string;
  refCount?: number;
  error?: string;
}

// Implicit role mapping based on HTML element tag
export const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  input: 'textbox',
  select: 'combobox',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  article: 'article',
  section: 'region',
  aside: 'complementary',
  form: 'form',
  table: 'table',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  dialog: 'dialog',
  progress: 'progressbar',
  meter: 'meter'
};

// Role mapping for input types
export const INPUT_TYPE_ROLES: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  button: 'button',
  submit: 'button',
  reset: 'button',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  number: 'spinbutton'
};

/**
 * Parse serialized accessibility tree back to node structure
 * Note: This is a simplified parser for the indented format
 */
export function parseSerializedTree(content: string): A11yNode | null {
  if (!content?.trim()) return null;

  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return null;

  const root: A11yNode = { children: [] };
  const stack: { node: A11yNode; depth: number }[] = [{ node: root, depth: -1 }];

  for (const line of lines) {
    const depth = line.match(/^(\s*)/)?.[1].length ?? 0;
    const text = line.trim();

    const node: A11yNode = {};

    // Parse ref: [e1], [e2], etc.
    const refMatch = text.match(/^\[(\w+)\]/);
    if (refMatch) {
      node.ref = refMatch[1];
    }

    // Parse role (first word after ref)
    const roleMatch = text.match(/^\[?\w*\]?\s*(\w+)/);
    if (roleMatch) {
      node.role = roleMatch[1];
    }

    // Parse name: "text"
    const nameMatch = text.match(/"([^"]+)"/);
    if (nameMatch) {
      node.name = nameMatch[1];
    }

    // Parse states
    if (text.includes('(checked)')) node.checked = true;
    if (text.includes('(unchecked)')) node.checked = false;
    if (text.includes('(disabled)')) node.disabled = true;
    if (text.includes('(expanded)')) node.expanded = true;
    if (text.includes('(collapsed)')) node.expanded = false;

    // Parse value
    const valueMatch = text.match(/value="([^"]+)"/);
    if (valueMatch) {
      node.value = valueMatch[1];
    }

    // Find parent based on depth
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    if (!parent.children) parent.children = [];
    parent.children.push(node);

    stack.push({ node, depth });
  }

  return root.children?.[0] || null;
}

/**
 * Find a node by ref in the tree
 */
export function findNodeByRef(tree: A11yNode | null, ref: string): A11yNode | null {
  if (!tree) return null;
  if (tree.ref === ref) return tree;

  if (tree.children) {
    for (const child of tree.children) {
      const found = findNodeByRef(child, ref);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Get all interactive nodes from the tree
 */
export function getInteractiveNodes(tree: A11yNode | null): A11yNode[] {
  const result: A11yNode[] = [];

  function traverse(node: A11yNode | null) {
    if (!node) return;

    if (node.ref) {
      result.push(node);
    }

    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  traverse(tree);
  return result;
}
