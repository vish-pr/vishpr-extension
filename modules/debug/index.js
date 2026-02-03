/**
 * Debug Mode - Action execution with trace/critique visualization
 */
import { elements } from '../dom.js';
import { renderModelStats, renderActionStats, setupStatsTimeFilter, getStatsTimeFilter } from '../ui-settings.js';
import { getModelStatsCounter, getActionStatsCounter } from './time-bucket-counter.js';
import { getChatStatus } from '../chat.js';
import { getTraces, getTraceById, deleteTrace } from './trace-collector.js';
import { getBrowserStateBundle } from '../content-bridge.js';

// SVG icons for consistent rendering
const ICONS = {
  chevron: '<svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>',
  check: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
  x: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  dot: '<svg class="size-2.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
  maximize: '<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>',
  close: '<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  copy: '<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  copied: '<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
};

// Node type icons for trace rendering
const NODE_ICONS = { action: 'A', step: 'S', function: 'F', llm: 'L', chrome: 'C', context: '{}', warning: '!', iteration: '↻' };

// Content length threshold for showing maximize button
const MAXIMIZE_THRESHOLD = 5000;

// Format object as key: value pairs instead of JSON
function formatKeyValue(obj) {
  if (!obj || typeof obj !== 'object') return String(obj);
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join('\n');
}

// Render tool calls as compact inline items with expandable args
function renderToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';

  return toolCalls.map((call, i) => {
    const fn = call.function || {};
    const name = fn.name || 'unknown';
    let argsRaw = fn.arguments || '';
    let paramNames = [];
    let formattedArgs = argsRaw;

    // Try to parse arguments and extract param names
    try {
      const parsed = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
      if (parsed && typeof parsed === 'object') {
        paramNames = Object.keys(parsed);
        formattedArgs = formatKeyValue(parsed);
      }
    } catch {
      // Keep as-is if not valid JSON
    }

    const signature = paramNames.length > 0 ? `(${paramNames.join(', ')})` : '()';
    const uniqueId = `tool-call-${i}-${Date.now()}`;

    return `<div class="tool-call-inline" data-expanded="false" data-target="${uniqueId}">
      <div class="tool-call-summary">
        <span class="tool-call-chevron">${ICONS.chevron}</span>
        <span class="tool-call-name">${escapeHtml(name)}</span><span class="tool-call-params">${escapeHtml(signature)}</span>
        ${call.id ? `<span class="tool-call-id">${escapeHtml(call.id)}</span>` : ''}
      </div>
      <pre class="tool-call-args" id="${uniqueId}">${escapeHtml(formattedArgs)}</pre>
    </div>`;
  }).join('');
}

// Find TRACE_ANALYZER child action result from trace tree
function findCritiqueResult(trace) {
  if (!trace?.children) return null;
  // Trace analyzer is attached directly to root action's children
  for (const child of trace.children) {
    if (child.type === 'action' && child.name === 'TRACE_ANALYZER' && child.output?.result) {
      return child.output.result;
    }
  }
  return null;
}

let state = { history: [], selected: -1 };
let prefsEditState = { editing: false, originalValue: '' };

export async function initDebug() {
  elements.debugToggle.addEventListener('click', toggleMode);
  elements.debugClearBtn.addEventListener('click', reloadTraces);

  // Tab switching
  document.querySelectorAll('[data-debug-tab]').forEach(tab => {
    tab.addEventListener('click', () => switchDebugTab(/** @type {HTMLElement} */ (tab).dataset.debugTab));
  });

  // Stats refresh and time filter
  elements.debugStatsRefreshBtn.addEventListener('click', refreshStats);
  setupStatsTimeFilter();

  // State refresh
  elements.debugStateRefreshBtn.addEventListener('click', refreshState);

  // Delegated history sidebar handlers
  elements.debugHistory.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete]');
    if (del) { e.stopPropagation(); return deleteHistoryItem(+del.dataset.delete); }
    const item = e.target.closest('[data-idx]');
    if (item) selectHistory(+item.dataset.idx);
  });

  // Delegated timeline handlers
  elements.debugTimeline.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.content-copy-btn');
    if (copyBtn?.dataset.copyId) { e.stopPropagation(); return handleCopy(copyBtn); }
    const maxBtn = e.target.closest('.content-maximize-btn');
    if (maxBtn?.dataset.maximizeId) { e.stopPropagation(); return handleMaximize(maxBtn); }
    const toolSum = e.target.closest('.tool-call-summary');
    if (toolSum) { e.stopPropagation(); const p = toolSum.closest('.tool-call-inline'); p.dataset.expanded = p.dataset.expanded !== 'true'; return; }
    const header = e.target.closest('.trace-header');
    if (header) header.closest('.trace-node')?.classList.toggle('expanded');
  });

  // Delegated state tab handlers
  elements.debugStateContent.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.content-copy-btn');
    if (copyBtn?.dataset.copyId) { e.stopPropagation(); return handleCopy(copyBtn); }
    const maxBtn = e.target.closest('.content-maximize-btn');
    if (maxBtn?.dataset.maximizeId) { e.stopPropagation(); return handleMaximize(maxBtn); }

    const editBtn = e.target.closest('.prefs-edit-btn');
    if (editBtn) { e.stopPropagation(); return handlePrefsEdit(); }

    const saveBtn = e.target.closest('.prefs-save-btn');
    if (saveBtn) { e.stopPropagation(); return handlePrefsSave(); }

    const cancelBtn = e.target.closest('.prefs-cancel-btn');
    if (cancelBtn) { e.stopPropagation(); return handlePrefsCancel(); }

    const undoBtn = e.target.closest('.prefs-undo-btn');
    if (undoBtn) { e.stopPropagation(); return handlePrefsUndo(); }

    const header = e.target.closest('.state-block-header');
    if (header) header.closest('.state-block')?.classList.toggle('collapsed');
  });

  await loadStoredTraces();
}

async function switchDebugTab(tabName) {
  document.querySelectorAll('[data-debug-tab]').forEach(tab => {
    tab.classList.toggle('tab-active', /** @type {HTMLElement} */ (tab).dataset.debugTab === tabName);
  });
  elements.debugTraceTab.classList.toggle('hidden', tabName !== 'trace');
  elements.debugStatsTab.classList.toggle('hidden', tabName !== 'stats');
  elements.debugStateTab.classList.toggle('hidden', tabName !== 'state');

  if (tabName === 'stats') {
    const timeFilter = getStatsTimeFilter();
    await Promise.all([renderModelStats(timeFilter), renderActionStats(timeFilter)]);
  }
  if (tabName === 'state') {
    await renderState();
  }
}

async function refreshStats() {
  elements.debugStatsRefreshBtn.disabled = true;
  elements.debugStatsRefreshBtn.classList.add('loading', 'loading-spinner');
  try {
    // Force reload from storage
    await Promise.all([
      getModelStatsCounter().load(true),
      getActionStatsCounter().load(true)
    ]);
    const timeFilter = getStatsTimeFilter();
    await Promise.all([renderModelStats(timeFilter), renderActionStats(timeFilter)]);
  } finally {
    elements.debugStatsRefreshBtn.disabled = false;
    elements.debugStatsRefreshBtn.classList.remove('loading', 'loading-spinner');
  }
}

function toggleMode() {
  const isDebug = elements.debugContainer.classList.toggle('hidden');
  elements.chatContainer.classList.toggle('hidden', !isDebug);
  elements.inputArea.classList.toggle('hidden', !isDebug);
  elements.debugToggle.classList.toggle('btn-active', !isDebug);

  if (isDebug) {
    // Switching to chat mode - restore chat status
    const { text, dotActive } = getChatStatus();
    elements.statusText.textContent = text;
    elements.statusDot?.classList.toggle('active', dotActive);
  } else {
    // Switching to debug mode
    elements.statusText.textContent = 'Debug Mode';
    elements.statusDot?.classList.remove('active');
  }
}

function renderTimeline(run) {
  if (!run) return;

  let html = '';

  // Trace section as stacked block
  if (run.trace) {
    html += `
      <div class="timeline-block timeline-block-trace">
        <div class="timeline-block-header">
          <span class="timeline-block-icon timeline-block-icon-trace">◈</span>
          <span class="timeline-block-title">EXECUTION TRACE</span>
          <span class="timeline-block-meta">${run.trace.duration ? formatDuration(run.trace.duration) : ''}</span>
        </div>
        <div class="timeline-block-content">
          ${renderNode(run.trace, 0)}
        </div>
      </div>
    `;
  }

  // Critique section as stacked block
  html += renderCritiqueBlock(run);

  elements.debugTimeline.innerHTML = html;
}

function renderNode(node, depth = 0) {
  const hasChildren = node.children?.length > 0;
  const hasDetails = node.input || node.output || node.error || node.context || node.model || node.prompt || node.status === 'skipped';
  const icon = NODE_ICONS[node.type] || '?';
  if (icon === '?') console.warn('Unknown node type:', node);
  const statusIcon = { success: ICONS.check, error: ICONS.x, running: ICONS.dot, skipped: '⏭' }[node.status] || '';
  const statusClass = `trace-status-${node.status || 'pending'}`;
  const expandedClass = depth === 0 ? 'expanded' : '';

  const details = [];
  // Stats row for actions/steps with aggregated LLM stats
  if (node.stats) {
    const { tokens, cost, upstreamCost, llmCalls } = node.stats;
    const costStr = `<span title="API cost">$${cost.toFixed(4)}</span> / <span title="Upstream inference cost">~$${upstreamCost.toFixed(4)}</span>`;
    const statsStr = `${tokens.input + tokens.output} tokens (${tokens.input} in / ${tokens.output} out) · ${costStr} · ${llmCalls} LLM calls`;
    details.push(detailRow('STATS', `<span class="opacity-70">${statsStr}</span>`));
  }
  // LLM-specific fields
  if (node.type === 'llm' && node.usageStats) {
    const { tokens, cost, upstreamCost } = node.usageStats;
    const costStr = `<span title="API cost">$${cost.toFixed(4)}</span> / <span title="Upstream inference cost">~$${upstreamCost.toFixed(4)}</span>`;
    const tokensStr = `${tokens.input} in / ${tokens.output} out`;
    details.push(detailRow('MODEL', `${node.model || 'unknown'} · ${tokensStr} · ${costStr}`));
  }
  if (node.input) {
    const inputStr = formatKeyValue(node.input);
    details.push(detailRow('INPUT', formatLargeContent(inputStr, 'INPUT')));
  }
  if (node.prompt) {
    details.push(detailRow('PROMPT', formatLargeContent(node.prompt, 'PROMPT')));
  }
  if (node.output && node.status !== 'skipped') {
    const outputData = node.output?.result ?? node.output;

    if (node.type === 'llm' && typeof outputData === 'object' && outputData !== null) {
      // Extract LLM response fields
      const reasoning = outputData.reasoning || null;
      const toolCalls = outputData.tool_calls || null;
      const content = outputData.content || null;
      const remainingEntries = Object.entries(outputData).filter(([k]) => !['reasoning', 'tool_calls', 'usage', 'model', 'content'].includes(k));
      const remaining = remainingEntries.length > 0 ? Object.fromEntries(remainingEntries) : null;

      if (reasoning) {
        details.push(detailRow('REASONING', formatLargeContent(reasoning, 'REASONING', 'llm-reasoning')));
      }
      if (toolCalls && toolCalls.length > 0) {
        details.push(detailRow('TOOL_CALLS', `<div class="tool-calls-container">${renderToolCalls(toolCalls)}</div>`));
      }
      if (content) {
        details.push(detailRow('CONTENT', formatLargeContent(content, 'CONTENT')));
      }
      if (remaining && Object.keys(remaining).length > 0) {
        const remainingStr = formatKeyValue(remaining);
        details.push(detailRow('RESPONSE', formatLargeContent(remainingStr, 'RESPONSE')));
      }
    } else {
      // Non-LLM nodes: filter out usage and display as before
      const filtered = typeof outputData === 'object' && outputData !== null
        ? Object.fromEntries(Object.entries(outputData).filter(([k]) => k !== 'usage'))
        : outputData;
      const label = node.type === 'llm' ? 'RESPONSE' : 'RESULT';
      const filteredStr = typeof filtered === 'string' ? filtered : formatKeyValue(filtered);
      details.push(detailRow(label, formatLargeContent(filteredStr, label)));
    }
  }
  if (node.context) details.push(detailRow('CONTEXT', `<pre>${escapeHtml(JSON.stringify(node.context, null, 2))}</pre>`));
  if (node.error) {
    const errorStr = typeof node.error === 'object' ? JSON.stringify(node.error, null, 2) : String(node.error);
    details.push(detailRow('ERROR', `<span class="text-error">${escapeHtml(errorStr)}</span>`));
  }
  if (node.status === 'skipped') {
    details.push(detailRow('RESULT', '<span class="opacity-50">Skipped (condition met)</span>'));
  }

  // For actions, add data attribute to enable polling if still running
  const actionAttr = node.type === 'action' ? `data-action-uuid="${node.id}" data-status="${node.status}"` : '';

  return `
    <div class="trace-node ${expandedClass}" ${actionAttr}>
      <div class="trace-header">
        <span class="trace-toggle">${hasChildren || hasDetails ? ICONS.chevron : ''}</span>
        <span class="trace-icon trace-icon-${node.type || 'step'}">${icon}</span>
        <span class="trace-name">${escapeHtml(node.name)}</span>
        ${node.stepType ? `<span class="trace-type">${node.stepType}</span>` : ''}
        ${node.duration ? `<span class="trace-timing">${formatDuration(node.duration)}</span>` : ''}
        <span class="${statusClass}">${statusIcon}</span>
      </div>
      ${details.length ? `<div class="trace-details">${details.join('')}</div>` : ''}
      ${hasChildren ? `<div class="trace-children">${node.children.map(c => renderNode(c, depth + 1)).join('')}</div>` : ''}
    </div>
  `;
}

// Format content with copy button (always) and maximize button (if exceeds threshold)
function formatLargeContent(content, label, preClass = '') {
  const id = `max-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const showMaximize = content.length > MAXIMIZE_THRESHOLD;
  const maximizeBtn = showMaximize
    ? `<button class="content-maximize-btn" data-maximize-id="${id}" data-label="${escapeHtml(label)}" title="Expand (${formatSize(content.length)} chars)">${ICONS.maximize}</button>`
    : '';
  const copyBtn = `<button class="content-copy-btn" data-copy-id="${id}" title="Copy to clipboard">${ICONS.copy}</button>`;
  const preClassAttr = preClass ? ` class="${preClass}"` : '';

  return `<div class="relative">
    <div class="content-action-btns">${copyBtn}${maximizeBtn}</div>
    <pre${preClassAttr}>${escapeHtml(content)}</pre>
    <template id="${id}">${escapeHtml(content)}</template>
  </div>`;
}

function detailRow(label, value) {
  return `<div class="trace-detail-row"><span class="trace-detail-label">${label}</span><div class="trace-detail-value">${value}</div></div>`;
}

function renderHistory() {
  const getLabel = (run) => {
    if (run.inputPreview) return run.inputPreview;
    if (run.params?.user_message) return run.params.user_message.slice(0, 30) + (run.params.user_message.length > 30 ? '…' : '');
    return run.action || 'Action';  // Fallback for old traces without inputPreview
  };
  elements.debugHistory.innerHTML = state.history.map((run, i) => `
    <div class="p-1.5 rounded text-xs cursor-pointer ${i === state.selected ? 'bg-primary/20' : 'hover:bg-base-300'} ${run.status === 'error' ? 'border-l-2 border-error' : ''}" data-idx="${i}">
      <div class="flex items-center gap-1">
        <span class="truncate flex-1">${escapeHtml(getLabel(run))}</span>
        <button class="opacity-40 hover:opacity-100 hover:text-error text-xs" data-delete="${i}" title="Delete">×</button>
      </div>
      <div class="opacity-50 flex justify-between">
        <span>${run.time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
        <span>${run.duration ? formatDuration(run.duration) : ''}</span>
      </div>
    </div>
  `).join('') || '<div class="opacity-30 text-center p-2">No runs yet</div>';
}

async function selectHistory(idx) {
  // Clear trace data from previously selected item to save RAM
  if (state.selected >= 0 && state.selected !== idx) {
    const prevRun = state.history[state.selected];
    if (prevRun) {
      prevRun.trace = null;
      prevRun.critique = null;
    }
  }

  state.selected = idx;
  const run = state.history[idx];
  renderHistory();
  elements.debugTiming.textContent = run.duration ? formatDuration(run.duration) : '';

  // If trace not loaded, fetch on demand
  if (!run.trace && run.id) {
    showPlaceholder('loading');
    try {
      const traceData = await getTraceById(run.id);
      if (traceData?.trace) {
        run.trace = traceData.trace;
        run.critique = findCritiqueResult(traceData.trace);
        run.error = traceData.error;
      }
    } catch (e) {
      run.error = e.message;
      console.error('Failed to load trace:', e);
    }
  }

  if (run.error && !run.trace) {
    elements.debugTimeline.innerHTML = `
      <div class="timeline-error-block">
        <div class="timeline-error-icon">✕</div>
        <div class="timeline-error-msg">${escapeHtml(run.error)}</div>
      </div>
    `;
  } else {
    renderTimeline(run);
  }
}

function showPlaceholder(type) {
  const isLoading = type === 'loading';
  elements.debugTimeline.innerHTML = `<div class="debug-empty-state">
    <div class="${isLoading ? 'timeline-loading-indicator' : 'debug-empty-icon'}">▷</div>
    <div class="debug-empty-text">${isLoading ? 'Loading trace...' : 'Select a trace from history'}</div>
  </div>`;
  if (!isLoading) { elements.debugTiming.textContent = ''; elements.debugCritiqueBadge.textContent = ''; }
}

function renderCritiqueBlock(run) {
  if (!run?.critique) {
    elements.debugCritiqueBadge.textContent = '...';
    elements.debugCritiqueBadge.className = 'badge badge-xs badge-ghost';
    return `
      <div class="timeline-block timeline-block-critique timeline-block-loading">
        <div class="timeline-block-header">
          <span class="timeline-block-icon timeline-block-icon-critique">⬡</span>
          <span class="timeline-block-title">ANALYSIS</span>
          <span class="timeline-loading-indicator"></span>
        </div>
        <div class="timeline-block-content">
          <div class="critique-generating">Generating critique...</div>
        </div>
      </div>
    `;
  }

  const c = run.critique;
  const issues = (c.prompts?.issues?.length || 0) + (c.efficiency?.issues?.length || 0) + (c.errors?.issues?.length || 0);
  elements.debugCritiqueBadge.textContent = issues || '✓';
  elements.debugCritiqueBadge.className = `badge badge-xs ${issues ? 'badge-warning' : 'badge-success'}`;

  const renderItem = i => `<div class="critique-item critique-item-${i.severity || 'low'}">
    <div class="critique-item-header">
      <span class="critique-item-location">${escapeHtml(i.location)}</span>
      <span class="critique-item-severity critique-item-severity-${i.severity || 'low'}">${i.severity?.toUpperCase() || 'LOW'}</span>
    </div>
    <div class="critique-item-problem">${escapeHtml(i.problem)}</div>
    ${i.suggestion ? `<div class="critique-item-suggestion">${escapeHtml(i.suggestion)}</div>` : ''}
  </div>`;

  const section = (key, label, icon) => {
    const items = c[key]?.issues || [];
    return items.length ? `<div class="critique-section">
      <div class="critique-section-header">
        <span class="critique-section-icon">${icon}</span>
        <span class="critique-section-title">${label}</span>
        <span class="critique-section-count">${items.length}</span>
      </div>
      <div class="critique-section-items">${items.map(renderItem).join('')}</div>
    </div>` : '';
  };

  return `
    <div class="timeline-block timeline-block-critique ${issues ? 'has-issues' : 'no-issues'}">
      <div class="timeline-block-header">
        <span class="timeline-block-icon timeline-block-icon-critique">⬡</span>
        <span class="timeline-block-title">ANALYSIS</span>
        <span class="timeline-block-badge ${issues ? 'has-issues' : ''}">${issues || '✓'}</span>
      </div>
      <div class="timeline-block-content">
        ${c.summary ? `<div class="critique-summary-block">${escapeHtml(c.summary)}</div>` : ''}
        ${c.topRecommendations?.length ? `
          <div class="critique-recommendations-block">
            <div class="critique-recs-title">TOP RECOMMENDATIONS</div>
            <ol class="critique-recs-list">
              ${c.topRecommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
            </ol>
          </div>
        ` : ''}
        ${section('prompts', 'PROMPTS', '◇')}${section('efficiency', 'EFFICIENCY', '◆')}${section('errors', 'ERRORS', '◈')}
      </div>
    </div>
  `;
}

// Capture expanded state of trace nodes and tool calls as index-based paths
function captureExpandedState() {
  const expandedPaths = new Set();

  // Capture expanded trace nodes - build path by walking up
  elements.debugTimeline.querySelectorAll('.trace-node.expanded').forEach(node => {
    const path = getTracePath(node);
    if (path !== null) expandedPaths.add('node:' + path);
  });

  // Capture expanded tool calls - simple index within container
  elements.debugTimeline.querySelectorAll('.tool-call-inline[data-expanded="true"]').forEach((call, globalIdx) => {
    expandedPaths.add('tool:' + globalIdx);
  });

  return expandedPaths;
}

// Get path for a trace node as indices at each depth level
function getTracePath(node) {
  const indices = [];
  let current = node;

  while (current?.classList.contains('trace-node')) {
    // Find index among siblings in the same container
    const container = current.parentElement;
    if (!container) break;

    const siblings = Array.from(container.querySelectorAll(':scope > .trace-node'));
    const idx = siblings.indexOf(current);
    if (idx === -1) break;

    indices.unshift(idx);

    // Move up: parent container might be .trace-children or .timeline-block-content
    const parentNode = container.closest('.trace-node');
    current = parentNode;
  }

  return indices.length ? indices.join('-') : null;
}

// Restore expanded state after re-render
function restoreExpandedState(expandedPaths) {
  if (!expandedPaths.size) return;

  expandedPaths.forEach(pathKey => {
    const [type, path] = pathKey.split(':');
    if (path === undefined) return;

    if (type === 'node') {
      // Traverse trace tree by indices
      const indices = path.split('-').map(Number);
      let container = elements.debugTimeline.querySelector('.timeline-block-content');
      if (!container) return;

      let targetNode = null;
      for (let i = 0; i < indices.length; i++) {
        const nodes = container.querySelectorAll(':scope > .trace-node');
        targetNode = nodes[indices[i]];
        if (!targetNode) return;
        // Next level is inside .trace-children (not needed for last index)
        if (i < indices.length - 1) {
          container = targetNode.querySelector(':scope > .trace-children');
          if (!container) return;
        }
      }

      if (targetNode) targetNode.classList.add('expanded');
    } else {
      // Tool calls - restore by global index
      const idx = parseInt(path, 10);
      const calls = elements.debugTimeline.querySelectorAll('.tool-call-inline');
      if (calls[idx]) calls[idx].dataset.expanded = 'true';
    }
  });
}

async function loadStoredTraces() {
  try {
    const traces = await getTraces(50);
    if (traces?.length) {
      // Only store metadata - full trace loaded on demand when selected
      state.history = traces.map(t => ({
        id: t.traceId, action: t.name, time: new Date(t.timestamp),
        status: t.status, duration: t.duration, inputPreview: t.inputPreview,
        trace: null, critique: null, error: null  // Loaded on demand
      }));
      renderHistory();
      // Auto-select most recent history item
      selectHistory(0);
    }
  } catch (e) { console.error('Load failed:', e); }
}

async function reloadTraces() {
  // Save currently selected trace ID before reload
  const previousSelectedId = state.selected >= 0 ? state.history[state.selected]?.id : null;

  // Capture expanded state of current trace view
  const expandedState = captureExpandedState();

  await loadStoredTraces();

  if (state.history.length === 0) {
    showPlaceholder('empty');
    return;
  }

  // Try to find and re-select the previously selected trace
  if (previousSelectedId) {
    const newIndex = state.history.findIndex(h => h.id === previousSelectedId);
    if (newIndex >= 0) {
      // Re-select the same trace to refresh its data
      await selectHistory(newIndex);
      // Restore expanded state after re-render
      restoreExpandedState(expandedState);
      return;
    }
  }

  // Fall back to first trace if previous selection no longer exists
  selectHistory(0);
}

async function deleteHistoryItem(idx) {
  const run = state.history[idx];
  if (!run) return;

  try { await deleteTrace(run.id); } catch {}

  state.history.splice(idx, 1);
  if (state.selected === idx) {
    state.selected = state.history.length > 0 ? 0 : -1;
    if (state.selected >= 0) {
      selectHistory(0);
    } else {
      showPlaceholder('empty');
    }
  } else if (state.selected > idx) {
    state.selected--;
  }
  renderHistory();
}

const formatDuration = ms => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;
const escapeHtml = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

// ==========================================================================
// Content Maximizer - Full-screen overlay for large content
// ==========================================================================

function formatSize(length) {
  if (length > 1000000) return `${(length / 1000000).toFixed(1)}M`;
  if (length > 1000) return `${(length / 1000).toFixed(1)}K`;
  return `${length}`;
}

function showMaximizer(content, label) {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'maximizer-overlay';
  overlay.innerHTML = `
    <div class="maximizer-container">
      <div class="maximizer-header">
        <span class="maximizer-header-icon">◈</span>
        <span class="maximizer-header-label">${escapeHtml(label)}</span>
        <span class="maximizer-header-size">${formatSize(content.length)} chars</span>
        <button class="maximizer-copy-btn btn btn-ghost btn-sm btn-square" title="Copy to clipboard">
          ${ICONS.copy}
        </button>
        <button class="maximizer-close-btn" title="Close (Esc)">
          ${ICONS.close}
        </button>
      </div>
      <div class="maximizer-content">
        <pre></pre>
      </div>
      <div class="maximizer-footer">
        <span>Press <kbd>Esc</kbd> to close</span>
      </div>
    </div>
  `;

  // Set content via textContent to avoid XSS
  overlay.querySelector('.maximizer-content pre').textContent = content;

  // Copy button handler
  const copyBtn = /** @type {HTMLButtonElement} */ (overlay.querySelector('.maximizer-copy-btn'));
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(content);
      copyBtn.innerHTML = ICONS.copied;
      copyBtn.classList.add('text-success');
      setTimeout(() => {
        copyBtn.innerHTML = ICONS.copy;
        copyBtn.classList.remove('text-success');
      }, 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  });

  // Close handlers
  const close = () => {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', handleKeydown);
  };

  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Close button
  overlay.querySelector('.maximizer-close-btn').addEventListener('click', close);

  // Keyboard support
  document.addEventListener('keydown', handleKeydown);

  // Add to DOM
  document.body.appendChild(overlay);

  // Focus the container for keyboard events
  /** @type {HTMLElement} */ (overlay.querySelector('.maximizer-container')).focus();
}

// Handle maximize button click - decode content from template
function handleMaximize(btn) {
  const template = document.getElementById(btn.dataset.maximizeId);
  if (!template) return;
  const decoded = document.createElement('textarea');
  decoded.innerHTML = template.innerHTML;
  showMaximizer(decoded.value, btn.dataset.label);
}

// Handle copy button click - copy content to clipboard
async function handleCopy(btn) {
  const template = document.getElementById(btn.dataset.copyId);
  if (!template) return;
  const decoded = document.createElement('textarea');
  decoded.innerHTML = template.innerHTML;

  try {
    await navigator.clipboard.writeText(decoded.value);
    // Show success feedback
    btn.innerHTML = ICONS.copied;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = ICONS.copy;
      btn.classList.remove('copied');
    }, 1500);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}

// ==========================================================================
// State Tab - Runtime state inspector
// ==========================================================================

async function renderState() {
  const container = elements.debugStateContent;
  container.innerHTML = `
    <div class="state-loading">
      <div class="timeline-loading-indicator"></div>
      <span class="text-xs font-mono opacity-50">Fetching state...</span>
    </div>
  `;

  try {
    const [prefsStorage, browserState] = await Promise.all([
      chrome.storage.local.get('user_preferences_kb'),
      getBrowserStateBundle()
    ]);

    const userPreferences = prefsStorage['user_preferences_kb'] || '';

    container.innerHTML = `
      ${renderStateBlock('user_preferences', 'User Preferences', userPreferences, 'prefs')}
      ${renderStateBlock('browser_state', 'Browser State', browserState, 'browser')}
    `;
  } catch (e) {
    container.innerHTML = `
      <div class="state-error">
        <span class="text-error text-xs font-mono">Failed to load state: ${escapeHtml(e.message)}</span>
      </div>
    `;
  }
}

function renderStateBlock(key, label, value, type) {
  const isEmpty = !value || (typeof value === 'string' && value.trim() === '');
  const rawValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const displayValue = isEmpty ? '<span class="opacity-40 italic">empty</span>' : escapeHtml(rawValue);
  const showMaximize = !isEmpty && rawValue.length > MAXIMIZE_THRESHOLD;
  const id = `state-${key}-${Date.now()}`;

  // Check if we're in edit mode for prefs
  if (type === 'prefs' && prefsEditState.editing) {
    return `
      <div class="state-block state-block-${type}" data-key="${key}">
        <div class="state-block-header">
          <span class="state-block-chevron">${ICONS.chevron}</span>
          <span class="state-block-icon state-block-icon-${type}">◉</span>
          <span class="state-block-label">${escapeHtml(label)}</span>
          <span class="state-block-key font-mono">${escapeHtml(key)}</span>
        </div>
        <div class="state-block-content">
          ${renderPrefsEditing(rawValue)}
        </div>
      </div>
    `;
  }

  return `
    <div class="state-block state-block-${type}" data-key="${key}">
      <div class="state-block-header">
        <span class="state-block-chevron">${ICONS.chevron}</span>
        <span class="state-block-icon state-block-icon-${type}">${type === 'prefs' ? '◉' : '◎'}</span>
        <span class="state-block-label">${escapeHtml(label)}</span>
        <span class="state-block-key font-mono">${escapeHtml(key)}</span>
        ${!isEmpty ? `<span class="state-block-size">${formatSize(rawValue.length)} chars</span>` : ''}
        ${type === 'prefs' ? `
          <button class="prefs-edit-btn btn btn-ghost btn-xs opacity-60 hover:opacity-100 ml-2" title="Edit preferences">
            <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        ` : ''}
      </div>
      <div class="state-block-content">
        ${!isEmpty ? `
          <div class="content-action-btns">
            <button class="content-copy-btn" data-copy-id="${id}" title="Copy to clipboard">${ICONS.copy}</button>
            ${showMaximize ? `<button class="content-maximize-btn" data-maximize-id="${id}" data-label="${escapeHtml(label)}" title="Expand">${ICONS.maximize}</button>` : ''}
          </div>
          <template id="${id}">${displayValue}</template>
        ` : ''}
        <pre class="state-block-value">${displayValue}</pre>
      </div>
    </div>
  `;
}

async function refreshState() {
  elements.debugStateRefreshBtn.disabled = true;
  elements.debugStateRefreshBtn.classList.add('loading', 'loading-spinner');
  try {
    await renderState();
  } finally {
    elements.debugStateRefreshBtn.disabled = false;
    elements.debugStateRefreshBtn.classList.remove('loading', 'loading-spinner');
  }
}

// ==========================================================================
// Preferences Editor
// ==========================================================================

function renderPrefsEditing(currentValue) {
  return `
    <div class="prefs-editor">
      <textarea class="textarea textarea-bordered textarea-sm w-full font-mono text-xs min-h-[200px] bg-base-200"
                id="prefsEditTextarea">${escapeHtml(currentValue)}</textarea>
      <div class="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-base-content/10">
        <button class="prefs-undo-btn btn btn-ghost btn-xs gap-1" title="Revert changes">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          Undo
        </button>
        <button class="prefs-cancel-btn btn btn-ghost btn-xs">Cancel</button>
        <button class="prefs-save-btn btn btn-primary btn-xs gap-1">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17,21 17,13 7,13 7,21"/>
            <polyline points="7,3 7,8 15,8"/>
          </svg>
          Save
        </button>
      </div>
    </div>
  `;
}

async function handlePrefsEdit() {
  const storage = await chrome.storage.local.get('user_preferences_kb');
  const currentValue = storage['user_preferences_kb'] || '';
  prefsEditState = { editing: true, originalValue: currentValue };
  await renderState();

  // Focus textarea after render
  document.getElementById('prefsEditTextarea')?.focus();
}

async function handlePrefsSave() {
  const textarea = document.getElementById('prefsEditTextarea');
  const newValue = /** @type {HTMLTextAreaElement} */ (textarea)?.value || '';

  await chrome.storage.local.set({ 'user_preferences_kb': newValue });
  prefsEditState = { editing: false, originalValue: '' };

  await renderState();
}

function handlePrefsCancel() {
  prefsEditState = { editing: false, originalValue: '' };
  renderState();
}

function handlePrefsUndo() {
  const textarea = document.getElementById('prefsEditTextarea');
  if (textarea) {
    /** @type {HTMLTextAreaElement} */ (textarea).value = prefsEditState.originalValue;
  }
}
