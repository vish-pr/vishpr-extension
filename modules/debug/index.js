/**
 * Debug Mode - Action execution with trace/critique visualization
 */
import { elements } from '../dom.js';
import { renderModelStats, renderActionStats } from '../ui-settings.js';
import { getModelStatsCounter, getActionStatsCounter } from './time-bucket-counter.js';
import { getChatStatus } from '../chat.js';
import { getTraces, getTraceById, deleteTrace } from './trace-collector.js';
import { getBrowserStateBundle } from '../chrome-api.js';

// Storage key for user preferences
const PREFERENCES_KB_KEY = 'user_preferences_kb';

// SVG icons for consistent rendering
const ICONS = {
  chevron: '<svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>',
  check: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
  x: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  dot: '<svg class="size-2.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
  maximize: '<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>',
  close: '<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
};

// Content length threshold for showing maximize button
const MAXIMIZE_THRESHOLD = 5000;

// Format object as key: value pairs instead of JSON
function formatKeyValue(obj) {
  if (!obj || typeof obj !== 'object') return String(obj);
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join('\n');
}

// Format LLM response with separate sections for reasoning, tool_calls, content, and remaining fields
function formatLLMResponse(outputData) {
  if (!outputData || typeof outputData !== 'object') {
    return { reasoning: null, toolCalls: null, content: null, remaining: outputData };
  }

  const specialFields = ['reasoning', 'tool_calls', 'usage', 'model', 'content'];
  const reasoning = outputData.reasoning || null;
  const toolCalls = outputData.tool_calls || null;
  const content = outputData.content || null;

  // Collect remaining fields (exclude special ones)
  const remainingEntries = Object.entries(outputData).filter(([k]) => !specialFields.includes(k));
  const remaining = remainingEntries.length > 0 ? Object.fromEntries(remainingEntries) : null;

  return { reasoning, toolCalls, content, remaining };
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

// Find CRITIQUE child action result from trace tree
function findCritiqueResult(trace) {
  if (!trace?.children) return null;
  // Critique is attached directly to root action's children
  for (const child of trace.children) {
    if (child.type === 'action' && child.name === 'CRITIQUE' && child.output?.result) {
      return child.output.result;
    }
  }
  return null;
}

let state = { history: [], selected: -1, tabId: null };

export async function initDebug() {
  elements.debugToggle.addEventListener('click', toggleMode);
  elements.debugClearBtn.addEventListener('click', reloadTraces);
  elements.debugRefreshBtn.addEventListener('click', refreshCritique);

  // Tab switching
  document.querySelectorAll('[data-debug-tab]').forEach(tab => {
    tab.addEventListener('click', () => switchDebugTab(tab.dataset.debugTab));
  });

  // Stats refresh
  elements.debugStatsRefreshBtn.addEventListener('click', refreshStats);

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
    const maxBtn = e.target.closest('.content-maximize-btn');
    if (maxBtn?.dataset.maximizeId) { e.stopPropagation(); return handleMaximize(maxBtn); }
    const toolSum = e.target.closest('.tool-call-summary');
    if (toolSum) { e.stopPropagation(); const p = toolSum.closest('.tool-call-inline'); p.dataset.expanded = p.dataset.expanded !== 'true'; return; }
    const header = e.target.closest('.trace-header');
    if (header) header.closest('.trace-node')?.classList.toggle('expanded');
  });

  // Delegated state tab handlers
  elements.debugStateContent.addEventListener('click', (e) => {
    const maxBtn = e.target.closest('.content-maximize-btn');
    if (maxBtn?.dataset.maximizeId) { e.stopPropagation(); return handleMaximize(maxBtn); }
    const header = e.target.closest('.state-block-header');
    if (header) header.closest('.state-block')?.classList.toggle('collapsed');
  });

  state.tabId = await getCurrentTabId();
  await loadStoredTraces();
}

async function switchDebugTab(tabName) {
  document.querySelectorAll('[data-debug-tab]').forEach(tab => {
    tab.classList.toggle('tab-active', tab.dataset.debugTab === tabName);
  });
  elements.debugTraceTab.classList.toggle('hidden', tabName !== 'trace');
  elements.debugStatsTab.classList.toggle('hidden', tabName !== 'stats');
  elements.debugStateTab.classList.toggle('hidden', tabName !== 'state');

  if (tabName === 'stats') {
    await Promise.all([renderModelStats(), renderActionStats()]);
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
      getModelStatsCounter().reload(),
      getActionStatsCounter().reload()
    ]);
    await Promise.all([renderModelStats(), renderActionStats()]);
  } finally {
    elements.debugStatsRefreshBtn.disabled = false;
    elements.debugStatsRefreshBtn.classList.remove('loading', 'loading-spinner');
  }
}

async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
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

function showError(msg) {
  elements.debugTimeline.innerHTML = `
    <div class="timeline-error-block">
      <div class="timeline-error-icon">✕</div>
      <div class="timeline-error-msg">${escapeHtml(msg)}</div>
    </div>
  `;
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
  const icons = { action: 'A', step: 'S', function: 'F', llm: 'L', chrome: 'C', context: '{}', warning: '!', iteration: '↻' };
  const icon = icons[node.type] || '?';
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
      // Format LLM response with separate sections
      const { reasoning, toolCalls, content, remaining } = formatLLMResponse(outputData);

      if (reasoning) {
        if (reasoning.length > MAXIMIZE_THRESHOLD) {
          details.push(detailRow('REASONING', formatLargeContent(reasoning, 'REASONING')));
        } else {
          details.push(detailRow('REASONING', `<pre class="llm-reasoning">${escapeHtml(reasoning)}</pre>`));
        }
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

// Format content with maximize button if it exceeds threshold
function formatLargeContent(content, label) {
  if (content.length <= MAXIMIZE_THRESHOLD) {
    return `<pre>${escapeHtml(content)}</pre>`;
  }
  const id = `max-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `<div class="relative">
    <button class="content-maximize-btn" data-maximize-id="${id}" data-label="${escapeHtml(label)}" title="Expand (${formatSize(content.length)} chars)">
      ${ICONS.maximize}
    </button>
    <pre>${escapeHtml(content)}</pre>
    <template id="${id}">${escapeHtml(content)}</template>
  </div>`;
}

function detailRow(label, value) {
  return `<div class="trace-detail-row"><span class="trace-detail-label">${label}</span><div class="trace-detail-value">${value}</div></div>`;
}

function renderHistory() {
  const getLabel = (run) => {
    if (run.params?.user_message) return run.params.user_message.slice(0, 30) + (run.params.user_message.length > 30 ? '…' : '');
    return run.action || 'Action';  // Fallback for old traces without name in metadata
  };
  elements.debugHistory.innerHTML = state.history.map((run, i) => `
    <div class="p-1.5 rounded text-xs cursor-pointer ${i === state.selected ? 'bg-primary/20' : 'hover:bg-base-300'} ${run.status === 'error' ? 'border-l-2 border-error' : ''}" data-idx="${i}">
      <div class="flex items-center gap-1">
        <span class="truncate flex-1">${escapeHtml(getLabel(run))}</span>
        <button class="opacity-40 hover:opacity-100 hover:text-error text-xs" data-delete="${i}" title="Delete">×</button>
      </div>
      <div class="opacity-50 flex justify-between">
        <span>${formatTime(run.time)}</span>
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
    showError(run.error);
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

async function refreshCritique() {
  if (state.selected < 0) return;
  const run = state.history[state.selected];

  // Show loading state
  elements.debugCritiqueBadge.textContent = '...';
  elements.debugCritiqueBadge.className = 'badge badge-xs badge-ghost animate-pulse';

  try {
    const traceData = await getTraceById(run.id);
    if (traceData?.trace) {
      run.trace = traceData.trace;
      run.critique = findCritiqueResult(traceData.trace);
    }
    renderTimeline(run);
  } catch (e) {
    elements.debugCritiqueBadge.textContent = '!';
    elements.debugCritiqueBadge.className = 'badge badge-xs badge-error';
    console.error('Refresh failed:', e);
  }
}

async function loadStoredTraces() {
  try {
    const traces = await getTraces(50);
    if (traces?.length) {
      // Only store metadata - full trace loaded on demand when selected
      state.history = traces.map(t => ({
        id: t.traceId, action: t.name, time: new Date(t.timestamp),
        status: t.status, duration: t.duration,
        trace: null, critique: null, error: null  // Loaded on demand
      }));
      renderHistory();
      // Auto-select most recent history item
      selectHistory(0);
    }
  } catch (e) { console.error('Load failed:', e); }
}

async function reloadTraces() {
  await loadStoredTraces();
  if (state.history.length > 0) {
    selectHistory(0);
  } else {
    showPlaceholder('empty');
  }
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
const formatTime = d => d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
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
  overlay.querySelector('.maximizer-container').focus();
}

// Handle maximize button click - decode content from template
function handleMaximize(btn) {
  const template = document.getElementById(btn.dataset.maximizeId);
  if (!template) return;
  const decoded = document.createElement('textarea');
  decoded.innerHTML = template.innerHTML;
  showMaximizer(decoded.value, btn.dataset.label);
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
      chrome.storage.local.get(PREFERENCES_KB_KEY),
      getBrowserStateBundle()
    ]);

    const userPreferences = prefsStorage[PREFERENCES_KB_KEY] || '';

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

  return `
    <div class="state-block state-block-${type}" data-key="${key}">
      <div class="state-block-header">
        <span class="state-block-chevron">${ICONS.chevron}</span>
        <span class="state-block-icon state-block-icon-${type}">${type === 'prefs' ? '◉' : '◎'}</span>
        <span class="state-block-label">${escapeHtml(label)}</span>
        <span class="state-block-key font-mono">${escapeHtml(key)}</span>
        ${!isEmpty ? `<span class="state-block-size">${formatSize(rawValue.length)} chars</span>` : ''}
      </div>
      <div class="state-block-content">
        ${showMaximize ? `
          <button class="content-maximize-btn" data-maximize-id="${id}" data-label="${escapeHtml(label)}" title="Expand">
            ${ICONS.maximize}
          </button>
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
