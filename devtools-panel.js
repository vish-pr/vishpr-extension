/**
 * Vishpr Debug Panel - DevTools Panel Logic
 */

// ==========================================================================
// Action Registry - Available actions for autocomplete
// ==========================================================================

const ACTIONS = [
  { name: 'READ_PAGE', description: 'Extract page content including title, text, links, buttons', schema: {}, note: 'tabId auto-injected' },
  { name: 'CLICK_ELEMENT', description: 'Click a button or link by element ID', schema: { elementId: 'string' }, note: 'tabId auto-injected' },
  { name: 'NAVIGATE_TO', description: 'Navigate to a URL', schema: { url: 'string' }, note: 'tabId auto-injected' },
  { name: 'GET_PAGE_STATE', description: 'Get scroll position, viewport, and load status', schema: {}, note: 'tabId auto-injected' },
  { name: 'FILL_FORM', description: 'Fill form fields', schema: { form_fields: '[{elementId, value}]' }, note: 'tabId auto-injected' },
  { name: 'SELECT_OPTION', description: 'Select a dropdown option', schema: { elementId: 'string', value: 'string' }, note: 'tabId auto-injected' },
  { name: 'CHECK_CHECKBOX', description: 'Toggle a checkbox', schema: { elementId: 'string', checked: 'boolean' }, note: 'tabId auto-injected' },
  { name: 'SUBMIT_FORM', description: 'Submit a form', schema: { elementId: 'string' }, note: 'tabId auto-injected' },
  { name: 'SCROLL_TO', description: 'Scroll in a direction', schema: { direction: '"up"|"down"', pixels: 'number?' }, note: 'tabId auto-injected' },
  { name: 'WAIT_FOR_LOAD', description: 'Wait for page to finish loading', schema: { timeout_ms: 'number?' }, note: 'tabId auto-injected' },
  { name: 'WAIT_FOR_ELEMENT', description: 'Wait for an element to appear', schema: { elementId: 'string' }, note: 'tabId auto-injected' },
  { name: 'GO_BACK', description: 'Navigate back in browser history', schema: {}, note: 'tabId auto-injected' },
  { name: 'GO_FORWARD', description: 'Navigate forward in browser history', schema: {}, note: 'tabId auto-injected' },
  { name: 'BROWSER_ROUTER', description: 'Top-level router that decides which action to take', schema: { user_message: 'string' } },
  { name: 'CLEAN_CONTENT', description: 'Clean and summarize page content', schema: { content: 'string' } },
];

// ==========================================================================
// State
// ==========================================================================

let state = {
  history: [],
  currentRun: null,
  selectedHistoryIndex: -1,
  autocompleteIndex: -1,
  isRunning: false,
  currentTabId: null,
  currentTabTitle: '',
};

// ==========================================================================
// DOM Elements
// ==========================================================================

const elements = {
  commandInput: document.getElementById('commandInput'),
  runBtn: document.getElementById('runBtn'),
  autocompleteDropdown: document.getElementById('autocompleteDropdown'),
  schemaHint: document.getElementById('schemaHint'),
  historyList: document.getElementById('historyList'),
  historyCount: document.getElementById('historyCount'),
  traceSection: document.getElementById('traceSection'),
  traceEmpty: document.getElementById('traceEmpty'),
  traceTree: document.getElementById('traceTree'),
  statusIndicator: document.getElementById('statusIndicator'),
  tabInfo: document.getElementById('tabInfo'),
  timingInfo: document.getElementById('timingInfo'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
};

// ==========================================================================
// Initialization
// ==========================================================================

async function init() {
  setupEventListeners();
  await updateCurrentTab();
  connectToBackground();
}

function setupEventListeners() {
  // Command input
  elements.commandInput.addEventListener('input', handleInput);
  elements.commandInput.addEventListener('keydown', handleKeydown);
  elements.commandInput.addEventListener('focus', handleFocus);
  elements.commandInput.addEventListener('blur', () => {
    // Delay to allow click on autocomplete
    setTimeout(() => hideAutocomplete(), 150);
  });

  // Run button
  elements.runBtn.addEventListener('click', executeCommand);

  // Clear history
  elements.clearHistoryBtn.addEventListener('click', clearHistory);

  // Listen for trace updates from background
  chrome.runtime.onMessage.addListener(handleMessage);
}

async function updateCurrentTab() {
  try {
    // In DevTools, use inspectedWindow.tabId to get the tab being debugged
    state.currentTabId = chrome.devtools.inspectedWindow.tabId;

    // Get tab details
    const tab = await chrome.tabs.get(state.currentTabId);
    state.currentTabTitle = tab.title || 'Unknown';
    elements.tabInfo.textContent = `Tab: ${truncate(state.currentTabTitle, 40)}`;
    elements.statusIndicator.classList.add('connected');
    elements.statusIndicator.title = 'Connected';
  } catch (err) {
    elements.tabInfo.textContent = 'No tab selected';
    elements.statusIndicator.classList.remove('connected');
  }
}

function connectToBackground() {
  // Verify connection to background script
  chrome.runtime.sendMessage({ type: 'DEBUG_PING' }, (response) => {
    if (chrome.runtime.lastError) {
      elements.statusIndicator.classList.remove('connected');
      elements.statusIndicator.classList.add('error');
      elements.statusIndicator.title = 'Disconnected';
    } else {
      elements.statusIndicator.classList.add('connected');
      elements.statusIndicator.classList.remove('error');
      elements.statusIndicator.title = 'Connected';
    }
  });
}

// ==========================================================================
// Command Input & Autocomplete
// ==========================================================================

function handleFocus() {
  const value = elements.commandInput.value.trim();
  const actionPart = value.split(' ')[0].toUpperCase();

  // If no action selected yet, show all actions
  if (!actionPart || !ACTIONS.find(a => a.name === actionPart)) {
    const matches = actionPart
      ? ACTIONS.filter(a => a.name.startsWith(actionPart) || a.name.includes(actionPart))
      : ACTIONS;
    if (matches.length > 0) {
      showAutocomplete(matches);
    }
  }
}

function handleInput(e) {
  const value = e.target.value.trim();
  const actionPart = value.split(' ')[0].toUpperCase();

  if (actionPart.length > 0) {
    const matches = ACTIONS.filter(a =>
      a.name.startsWith(actionPart) || a.name.includes(actionPart)
    );
    if (matches.length > 0 && matches[0].name !== actionPart) {
      showAutocomplete(matches);
    } else {
      hideAutocomplete();
      // Show schema hint if exact match
      const exactMatch = ACTIONS.find(a => a.name === actionPart);
      if (exactMatch) {
        showSchemaHint(exactMatch);
      } else {
        hideSchemaHint();
      }
    }
  } else {
    // Empty input - show all actions
    showAutocomplete(ACTIONS);
    hideSchemaHint();
  }
}

function handleKeydown(e) {
  const dropdown = elements.autocompleteDropdown;
  const items = dropdown.querySelectorAll('.autocomplete-item');

  if (dropdown.classList.contains('visible')) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.autocompleteIndex = Math.min(state.autocompleteIndex + 1, items.length - 1);
      updateAutocompleteSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.autocompleteIndex = Math.max(state.autocompleteIndex - 1, 0);
      updateAutocompleteSelection(items);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (state.autocompleteIndex >= 0 && items[state.autocompleteIndex]) {
        selectAutocompleteItem(items[state.autocompleteIndex].dataset.name);
      }
    } else if (e.key === 'Escape') {
      hideAutocomplete();
    }
  } else {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      executeCommand();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      executeCommand(true); // Keep input after run
    }
  }
}

function showAutocomplete(matches) {
  const dropdown = elements.autocompleteDropdown;
  dropdown.innerHTML = matches.map((action, i) => `
    <div class="autocomplete-item ${i === 0 ? 'selected' : ''}" data-name="${action.name}">
      <span class="autocomplete-item-name">${action.name}</span>
      <span class="autocomplete-item-desc">${action.description}</span>
    </div>
  `).join('');

  dropdown.classList.add('visible');
  state.autocompleteIndex = 0;

  // Add click handlers
  dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
    item.addEventListener('click', () => {
      selectAutocompleteItem(item.dataset.name);
    });
  });
}

function hideAutocomplete() {
  elements.autocompleteDropdown.classList.remove('visible');
  state.autocompleteIndex = -1;
}

function updateAutocompleteSelection(items) {
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === state.autocompleteIndex);
  });
}

function selectAutocompleteItem(name) {
  const currentValue = elements.commandInput.value;
  const parts = currentValue.split(' ');
  parts[0] = name;
  elements.commandInput.value = parts.join(' ') + (parts.length === 1 ? ' ' : '');
  elements.commandInput.focus();
  hideAutocomplete();

  const action = ACTIONS.find(a => a.name === name);
  if (action) {
    showSchemaHint(action);
  }
}

function showSchemaHint(action) {
  const schema = action.schema;
  const keys = Object.keys(schema);
  let hint = '';

  if (keys.length === 0) {
    hint = `<code>${action.name}</code> takes no parameters`;
  } else {
    const params = keys.map(k => `${k}: ${schema[k]}`).join(', ');
    hint = `Params: <code>{ ${params} }</code>`;
  }

  if (action.note) {
    hint += ` <span style="color: var(--color-context);">(${action.note})</span>`;
  }

  elements.schemaHint.innerHTML = hint;
  elements.schemaHint.classList.add('visible');
}

function hideSchemaHint() {
  elements.schemaHint.classList.remove('visible');
}

// ==========================================================================
// Command Execution
// ==========================================================================

async function executeCommand(keepInput = false) {
  if (state.isRunning) return;

  const input = elements.commandInput.value.trim();
  if (!input) return;

  // Parse command
  const spaceIndex = input.indexOf(' ');
  const actionName = spaceIndex > -1 ? input.substring(0, spaceIndex).toUpperCase() : input.toUpperCase();
  const paramsStr = spaceIndex > -1 ? input.substring(spaceIndex + 1).trim() : '';

  let params = {};
  if (paramsStr) {
    try {
      params = JSON.parse(paramsStr);
    } catch (err) {
      showError('Invalid JSON parameters: ' + err.message);
      return;
    }
  }

  // Auto-inject tabId from inspected window if not provided
  if (!params.tabId && state.currentTabId) {
    params.tabId = state.currentTabId;
  }

  // Validate action exists
  const action = ACTIONS.find(a => a.name === actionName);
  if (!action) {
    showError(`Unknown action: ${actionName}`);
    return;
  }

  // Start execution
  setRunning(true);
  hideAutocomplete();
  hideSchemaHint();

  const runId = Date.now().toString();
  const startTime = performance.now();

  state.currentRun = {
    id: runId,
    actionName,
    params,
    startTime: new Date(),
    status: 'running',
    trace: null,
  };

  // Show running state in tree
  showRunningState(actionName);

  try {
    // Send to background for execution
    const response = await sendMessage({
      type: 'DEBUG_EXECUTE',
      actionName,
      params,
      tabId: state.currentTabId,
      runId,
    });

    const duration = performance.now() - startTime;
    state.currentRun.duration = duration;
    state.currentRun.status = response.error ? 'error' : 'success';
    state.currentRun.trace = response.trace;
    state.currentRun.error = response.error;

    // Render trace
    renderTrace(response.trace);
    elements.timingInfo.textContent = `${formatDuration(duration)}`;

  } catch (err) {
    const duration = performance.now() - startTime;
    state.currentRun.duration = duration;
    state.currentRun.status = 'error';
    state.currentRun.error = err.message;

    showError(err.message);
    elements.timingInfo.textContent = `${formatDuration(duration)} (error)`;
  }

  // Add to history
  addToHistory(state.currentRun);
  setRunning(false);

  if (!keepInput) {
    // Don't clear input - user might want to modify and re-run
  }
}

function setRunning(running) {
  state.isRunning = running;
  elements.runBtn.disabled = running;
  elements.runBtn.classList.toggle('running', running);
  elements.commandInput.disabled = running;

  if (running) {
    elements.runBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"></rect>
        <rect x="14" y="4" width="4" height="16"></rect>
      </svg>
      RUNNING
    `;
  } else {
    elements.runBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
      RUN
    `;
  }
}

function showRunningState(actionName) {
  elements.traceEmpty.style.display = 'none';
  elements.traceTree.classList.remove('hidden');
  elements.traceTree.innerHTML = `
    <div class="tree-node">
      <div class="node-header running">
        <span class="node-toggle empty">&#9656;</span>
        <span class="node-icon action">A</span>
        <span class="node-label">
          <span class="node-name">${actionName}</span>
        </span>
        <span class="node-status running">&#9679;</span>
      </div>
    </div>
  `;
}

function showError(message) {
  elements.traceEmpty.style.display = 'none';
  elements.traceTree.classList.remove('hidden');
  elements.traceTree.innerHTML = `
    <div class="tree-node">
      <div class="node-header">
        <span class="node-toggle empty">&#9656;</span>
        <span class="node-icon action">!</span>
        <span class="node-label">
          <span class="node-name">Error</span>
        </span>
        <span class="node-status error">&#10007;</span>
      </div>
      <div class="node-content expanded">
        <div class="node-detail">
          <span class="detail-label">Message</span>
          <span class="detail-value error">${escapeHtml(message)}</span>
        </div>
      </div>
    </div>
  `;
}

// ==========================================================================
// Trace Rendering
// ==========================================================================

function renderTrace(trace) {
  if (!trace) {
    elements.traceEmpty.style.display = 'flex';
    elements.traceTree.classList.add('hidden');
    return;
  }

  elements.traceEmpty.style.display = 'none';
  elements.traceTree.classList.remove('hidden');
  elements.traceTree.innerHTML = renderNode(trace);

  // Add toggle listeners
  elements.traceTree.querySelectorAll('.node-header').forEach(header => {
    header.addEventListener('click', () => toggleNode(header));
  });
}

function renderNode(node, depth = 0) {
  const hasChildren = node.children && node.children.length > 0;
  const hasDetails = node.input || node.output || node.error || node.context;
  const isExpandable = hasChildren || hasDetails;

  const iconClass = getIconClass(node.type);
  const iconLabel = getIconLabel(node.type);
  const statusIcon = getStatusIcon(node.status);

  let html = `
    <div class="tree-node" data-node-id="${node.id || ''}">
      <div class="node-header ${node.status === 'running' ? 'running' : ''}">
        <span class="node-toggle ${isExpandable ? '' : 'empty'}">&#9656;</span>
        <span class="node-icon ${iconClass}">${iconLabel}</span>
        <span class="node-label">
          <span class="node-name">${escapeHtml(node.name)}</span>
          ${node.stepType ? `<span class="node-type">${node.stepType}</span>` : ''}
        </span>
        ${node.duration !== undefined ? `<span class="node-timing">${formatDuration(node.duration)}</span>` : ''}
        <span class="node-status ${node.status}">${statusIcon}</span>
      </div>
  `;

  // Node details (collapsed by default)
  if (hasDetails) {
    html += `<div class="node-content">`;

    if (node.input !== undefined) {
      html += renderDetail('Input', node.input);
    }
    if (node.handler) {
      html += renderDetail('Handler', node.handler);
    }
    if (node.model) {
      html += renderDetail('Model', node.model);
    }
    if (node.tokens) {
      html += renderDetail('Tokens', `${node.tokens.input || 0} in / ${node.tokens.output || 0} out`);
    }
    if (node.prompt) {
      html += renderDetail('Prompt', node.prompt, true);
    }
    if (node.output !== undefined) {
      html += renderDetail('Result', node.output, true);
    }
    if (node.context !== undefined) {
      html += renderDetail('Context', node.context, true);
    }
    if (node.error) {
      html += `
        <div class="node-detail">
          <span class="detail-label">Error</span>
          <span class="detail-value error">${escapeHtml(String(node.error))}</span>
        </div>
      `;
    }

    html += `</div>`;
  }

  // Children
  if (hasChildren) {
    html += `<div class="node-children">`;
    for (const child of node.children) {
      html += renderNode(child, depth + 1);
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderDetail(label, value, isCode = false) {
  let displayValue;
  if (typeof value === 'object') {
    displayValue = isCode
      ? `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`
      : escapeHtml(JSON.stringify(value));
  } else {
    displayValue = isCode
      ? `<pre>${escapeHtml(String(value))}</pre>`
      : escapeHtml(String(value));
  }

  return `
    <div class="node-detail">
      <span class="detail-label">${label}</span>
      <span class="detail-value">${displayValue}</span>
    </div>
  `;
}

function toggleNode(header) {
  const node = header.closest('.tree-node');
  const toggle = header.querySelector('.node-toggle');
  const content = node.querySelector(':scope > .node-content');
  const children = node.querySelector(':scope > .node-children');

  const isExpanded = toggle.classList.contains('expanded');

  if (isExpanded) {
    toggle.classList.remove('expanded');
    if (content) content.classList.remove('expanded');
    if (children) children.classList.remove('expanded');
  } else {
    toggle.classList.add('expanded');
    if (content) content.classList.add('expanded');
    if (children) children.classList.add('expanded');
  }
}

function getIconClass(type) {
  const map = {
    action: 'action',
    step: 'step',
    function: 'function',
    llm: 'llm',
    chrome: 'chrome',
    context: 'context',
  };
  return map[type] || 'step';
}

function getIconLabel(type) {
  const map = {
    action: 'A',
    step: 'S',
    function: 'F',
    llm: 'L',
    chrome: 'C',
    context: '{}',
  };
  return map[type] || '?';
}

function getStatusIcon(status) {
  const map = {
    success: '&#10003;',
    error: '&#10007;',
    running: '&#9679;',
    pending: '&#9675;',
  };
  return map[status] || '';
}

// ==========================================================================
// History Management
// ==========================================================================

function addToHistory(run) {
  state.history.unshift(run);
  state.selectedHistoryIndex = 0;
  renderHistory();
}

function renderHistory() {
  if (state.history.length === 0) {
    elements.historyList.innerHTML = `
      <div class="history-empty">
        <span class="empty-icon">&#9711;</span>
        <span>No runs yet</span>
      </div>
    `;
    elements.historyCount.textContent = '0';
    return;
  }

  elements.historyCount.textContent = state.history.length.toString();
  elements.historyList.innerHTML = state.history.map((run, i) => `
    <div class="history-item ${run.status} ${i === state.selectedHistoryIndex ? 'active' : ''}" data-index="${i}">
      <div class="history-item-header">
        <span class="history-item-name">${run.actionName}</span>
        <span class="history-item-time">${formatTime(run.startTime)}</span>
      </div>
      <div class="history-item-meta">
        <span class="history-item-status ${run.status}">
          ${run.status === 'success' ? '&#10003;' : '&#10007;'}
          ${run.duration ? formatDuration(run.duration) : ''}
        </span>
      </div>
    </div>
  `).join('');

  // Add click handlers
  elements.historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.index);
      selectHistoryItem(index);
    });
  });
}

function selectHistoryItem(index) {
  state.selectedHistoryIndex = index;
  const run = state.history[index];

  // Update active state
  elements.historyList.querySelectorAll('.history-item').forEach((item, i) => {
    item.classList.toggle('active', i === index);
  });

  // Render trace
  if (run.trace) {
    renderTrace(run.trace);
  } else if (run.error) {
    showError(run.error);
  }

  // Update timing
  if (run.duration) {
    elements.timingInfo.textContent = formatDuration(run.duration);
  }
}

function clearHistory() {
  state.history = [];
  state.selectedHistoryIndex = -1;
  renderHistory();
  elements.traceEmpty.style.display = 'flex';
  elements.traceTree.classList.add('hidden');
  elements.traceTree.innerHTML = '';
  elements.timingInfo.textContent = '';
}

// ==========================================================================
// Message Handling
// ==========================================================================

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response || {});
      }
    });
  });
}

function handleMessage(message, sender, sendResponse) {
  if (message.type === 'DEBUG_TRACE_UPDATE' && message.runId === state.currentRun?.id) {
    // Incremental trace update
    renderTrace(message.trace);
  }
}

// ==========================================================================
// Utilities
// ==========================================================================

function formatDuration(ms) {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==========================================================================
// Initialize
// ==========================================================================

init();
