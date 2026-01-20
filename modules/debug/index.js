/**
 * Debug Mode - Action execution with trace/critique visualization
 */
import { renderModelStats, renderActionStats } from '../ui-settings.js';
import { getModelStatsCounter, getActionStatsCounter } from './time-bucket-counter.js';
import { getChatStatus } from '../chat.js';

// SVG icons for consistent rendering
const ICONS = {
  chevron: '<svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>',
  check: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
  x: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  dot: '<svg class="size-2.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
};

// Format object as key: value pairs instead of JSON
function formatKeyValue(obj) {
  if (!obj || typeof obj !== 'object') return String(obj);
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join('\n');
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

const ACTIONS = [
  { name: 'READ_PAGE', desc: 'Extract page content', params: {} },
  { name: 'CLICK_ELEMENT', desc: 'Click element by ID', params: { elementId: 'string' } },
  { name: 'NAVIGATE_TO', desc: 'Go to URL', params: { url: 'string' } },
  { name: 'FILL_FORM', desc: 'Fill form fields', params: { form_fields: '[{elementId, value}]' } },
  { name: 'SCROLL_TO', desc: 'Scroll page', params: { direction: '"up"|"down"' } },
  { name: 'BROWSER_ROUTER', desc: 'Natural language command', params: { user_message: 'string' } },
];

let state = { history: [], selected: -1, running: false, tabId: null };
let els = {};

export async function initDebug() {
  els = {
    toggle: document.getElementById('debugToggle'),
    container: document.getElementById('debugContainer'),
    chat: document.getElementById('chatContainer'),
    input: document.getElementById('debugInput'),
    inputArea: document.querySelector('.bg-base-200.border-t'), // chat input area
    runBtn: document.getElementById('debugRunBtn'),
    autocomplete: document.getElementById('debugAutocomplete'),
    params: document.getElementById('debugParams'),
    history: document.getElementById('debugHistory'),
    clearBtn: document.getElementById('debugClearBtn'),
    timeline: document.getElementById('debugTimeline'),
    timing: document.getElementById('debugTiming'),
    badge: document.getElementById('debugCritiqueBadge'),
    refreshBtn: document.getElementById('debugRefreshBtn'),
    // Debug tabs
    traceTab: document.getElementById('debugTraceTab'),
    statsTab: document.getElementById('debugStatsTab'),
    tabs: document.querySelectorAll('[data-debug-tab]'),
    statsRefreshBtn: document.getElementById('debugStatsRefreshBtn'),
  };

  els.toggle.addEventListener('click', toggleMode);
  els.input.addEventListener('input', onInput);
  els.input.addEventListener('keydown', onKeydown);
  els.input.addEventListener('focus', () => showAutocomplete(ACTIONS));
  els.input.addEventListener('blur', () => setTimeout(hideAutocomplete, 150));
  els.runBtn.addEventListener('click', execute);
  els.clearBtn.addEventListener('click', reloadTraces);
  els.refreshBtn.addEventListener('click', refreshCritique);

  // Tab switching
  els.tabs.forEach(tab => {
    tab.addEventListener('click', () => switchDebugTab(tab.dataset.debugTab));
  });

  // Stats refresh
  els.statsRefreshBtn.addEventListener('click', refreshStats);

  state.tabId = await getCurrentTabId();
  await loadStoredTraces();
}

async function switchDebugTab(tabName) {
  els.tabs.forEach(tab => {
    tab.classList.toggle('tab-active', tab.dataset.debugTab === tabName);
  });
  els.traceTab.classList.toggle('hidden', tabName !== 'trace');
  els.statsTab.classList.toggle('hidden', tabName !== 'stats');

  if (tabName === 'stats') {
    await Promise.all([renderModelStats(), renderActionStats()]);
  }
}

async function refreshStats() {
  els.statsRefreshBtn.disabled = true;
  els.statsRefreshBtn.classList.add('loading', 'loading-spinner');
  try {
    // Force reload from storage
    await Promise.all([
      getModelStatsCounter().reload(),
      getActionStatsCounter().reload()
    ]);
    await Promise.all([renderModelStats(), renderActionStats()]);
  } finally {
    els.statsRefreshBtn.disabled = false;
    els.statsRefreshBtn.classList.remove('loading', 'loading-spinner');
  }
}

async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function toggleMode() {
  const isDebug = els.container.classList.toggle('hidden');
  els.chat.classList.toggle('hidden', !isDebug);
  els.inputArea.classList.toggle('hidden', !isDebug);
  els.toggle.classList.toggle('btn-active', !isDebug);

  const statusText = document.getElementById('statusText');
  const statusDot = document.getElementById('statusDot');
  if (isDebug) {
    // Switching to chat mode - restore chat status
    const { text, dotActive } = getChatStatus();
    statusText.textContent = text;
    if (statusDot) {
      statusDot.classList.toggle('active', dotActive);
    }
  } else {
    // Switching to debug mode
    statusText.textContent = 'Debug Mode';
    if (statusDot) {
      statusDot.classList.remove('active');
    }
  }
}

function onInput(e) {
  const val = e.target.value.trim().split(' ')[0].toUpperCase();
  const matches = val ? ACTIONS.filter(a => a.name.includes(val)) : ACTIONS;
  matches.length && matches[0].name !== val ? showAutocomplete(matches) : hideAutocomplete();
  const action = ACTIONS.find(a => a.name === val);
  action ? showParams(action) : hideParams();
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); execute(); }
  if (e.key === 'Escape') hideAutocomplete();
}

function showAutocomplete(items) {
  els.autocomplete.innerHTML = items.map(a =>
    `<div class="p-2 hover:bg-base-300 cursor-pointer flex justify-between" data-name="${a.name}">
      <span class="font-mono text-xs">${a.name}</span>
      <span class="text-xs opacity-50">${a.desc}</span>
    </div>`
  ).join('');
  els.autocomplete.classList.remove('hidden');
  els.autocomplete.querySelectorAll('[data-name]').forEach(el =>
    el.addEventListener('click', () => selectAction(el.dataset.name))
  );
}

function hideAutocomplete() { els.autocomplete.classList.add('hidden'); }

function selectAction(name) {
  els.input.value = name + ' ';
  els.input.focus();
  hideAutocomplete();
  const action = ACTIONS.find(a => a.name === name);
  if (action) showParams(action);
}

function showParams(action) {
  const keys = Object.keys(action.params);
  if (!keys.length) return hideParams();
  els.params.innerHTML = keys.map(k => `
    <div class="flex items-center gap-2 mb-1">
      <label class="opacity-50 min-w-20">${k}</label>
      <input type="text" data-param="${k}" class="input input-xs input-bordered flex-1 font-mono" placeholder="${action.params[k]}">
    </div>
  `).join('');
  els.params.classList.remove('hidden');
}

function hideParams() { els.params.classList.add('hidden'); }

function getParams() {
  const params = {};
  els.params.querySelectorAll('[data-param]').forEach(el => {
    if (el.value.trim()) {
      try { params[el.dataset.param] = JSON.parse(el.value); }
      catch { params[el.dataset.param] = el.value; }
    }
  });
  return params;
}

async function execute() {
  if (state.running) return;
  const input = els.input.value.trim();
  if (!input) return;

  const [actionName, ...rest] = input.split(' ');
  let params;
  if (rest.length) {
    try { params = JSON.parse(rest.join(' ')); }
    catch (e) { return showError(`Invalid JSON: ${e.message}`); }
  } else {
    params = getParams();
  }
  if (!params.tabId) params.tabId = state.tabId;

  const action = ACTIONS.find(a => a.name === actionName.toUpperCase());
  if (!action) return showError(`Unknown: ${actionName}`);

  state.running = true;
  els.runBtn.disabled = true;
  const run = { id: null, action: actionName.toUpperCase(), params, time: new Date(), status: 'running' };

  showRunning(run);

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'DEBUG_EXECUTE', actionName: actionName.toUpperCase(), params, tabId: state.tabId
    });
    run.id = res.traceId;
    run.status = res.error ? 'error' : 'success';
    run.trace = res.trace;
    run.error = res.error;
    run.duration = res.trace?.duration;
    renderTimeline(run);
    els.timing.textContent = formatDuration(run.duration);
  } catch (err) {
    run.status = 'error';
    run.error = err.message;
    showError(err.message);
  }

  state.history.unshift(run);
  state.selected = 0;
  renderHistory();
  state.running = false;
  els.runBtn.disabled = false;

  // Check for critique after delay
  setTimeout(() => refreshCritique(), 2000);
}

function showRunning(run) {
  els.timeline.innerHTML = `
    <div class="timeline-running">
      <div class="timeline-running-pulse"></div>
      <div class="timeline-running-text">Executing ${run.action}...</div>
    </div>
  `;
  els.badge.textContent = '';
}

function showError(msg) {
  els.timeline.innerHTML = `
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

  els.timeline.innerHTML = html;

  // Attach expand/collapse handlers for trace nodes
  els.timeline.querySelectorAll('.trace-node').forEach(el =>
    el.querySelector('.trace-header')?.addEventListener('click', () => el.classList.toggle('expanded'))
  );

  // Attach expand/collapse handlers for large data blocks
  els.timeline.querySelectorAll('.trace-collapsible').forEach(el => {
    el.querySelector('.trace-collapsible-header')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCollapsed = el.dataset.collapsed === 'true';
      el.dataset.collapsed = isCollapsed ? 'false' : 'true';
    });
  });

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
  if (node.input) details.push(detailRow('INPUT', `<pre>${escapeHtml(formatKeyValue(node.input))}</pre>`));
  if (node.prompt) details.push(detailRow('PROMPT', `<pre>${escapeHtml(node.prompt)}</pre>`));
  if (node.output) {
    const outputData = node.output?.result ?? node.output;
    // Filter out usage field
    const filtered = typeof outputData === 'object' && outputData !== null
      ? Object.fromEntries(Object.entries(outputData).filter(([k]) => k !== 'usage'))
      : outputData;
    const label = node.type === 'llm' ? 'RESPONSE' : 'RESULT';
    details.push(detailRow(label, `<pre>${escapeHtml(typeof filtered === 'string' ? filtered : formatKeyValue(filtered))}</pre>`));
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

function detailRow(label, value) {
  return `<div class="trace-detail-row"><span class="trace-detail-label">${label}</span><div class="trace-detail-value">${value}</div></div>`;
}

function renderHistory() {
  const getLabel = (run) => {
    if (run.params?.user_message) return run.params.user_message.slice(0, 30) + (run.params.user_message.length > 30 ? '…' : '');
    return run.action;
  };
  els.history.innerHTML = state.history.map((run, i) => `
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

  els.history.querySelectorAll('[data-idx]').forEach(el =>
    el.addEventListener('click', (e) => {
      if (!e.target.dataset.delete) selectHistory(parseInt(el.dataset.idx));
    })
  );
  els.history.querySelectorAll('[data-delete]').forEach(el =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(parseInt(el.dataset.delete));
    })
  );
}

function selectHistory(idx) {
  state.selected = idx;
  const run = state.history[idx];
  renderHistory();
  if (run.error && !run.trace) {
    showError(run.error);
  } else {
    renderTimeline(run);
  }
  els.timing.textContent = run.duration ? formatDuration(run.duration) : '';
}

function renderCritiqueBlock(run) {
  if (!run?.critique) {
    els.badge.textContent = '...';
    els.badge.className = 'badge badge-xs badge-ghost';
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
  els.badge.textContent = issues || '✓';
  els.badge.className = `badge badge-xs ${issues ? 'badge-warning' : 'badge-success'}`;

  const sections = [
    { key: 'prompts', label: 'PROMPTS', icon: '◇' },
    { key: 'efficiency', label: 'EFFICIENCY', icon: '◆' },
    { key: 'errors', label: 'ERRORS', icon: '◈' },
  ];

  const sectionsHtml = sections.map(s => {
    const items = c[s.key]?.issues || [];
    return items.length ? `
      <div class="critique-section">
        <div class="critique-section-header">
          <span class="critique-section-icon">${s.icon}</span>
          <span class="critique-section-title">${s.label}</span>
          <span class="critique-section-count">${items.length}</span>
        </div>
        <div class="critique-section-items">
          ${items.map(i => `
            <div class="critique-item critique-item-${i.severity || 'low'}">
              <div class="critique-item-header">
                <span class="critique-item-location">${escapeHtml(i.location)}</span>
                <span class="critique-item-severity critique-item-severity-${i.severity || 'low'}">${i.severity?.toUpperCase() || 'LOW'}</span>
              </div>
              <div class="critique-item-problem">${escapeHtml(i.problem)}</div>
              ${i.suggestion ? `<div class="critique-item-suggestion">${escapeHtml(i.suggestion)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';
  }).join('');

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
        ${sectionsHtml}
      </div>
    </div>
  `;
}

async function refreshCritique() {
  if (state.selected < 0) return;
  const run = state.history[state.selected];

  // Show loading state
  els.badge.textContent = '...';
  els.badge.className = 'badge badge-xs badge-ghost animate-pulse';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TRACE_BY_ID', traceId: run.id });
    if (res.trace?.trace) {
      run.trace = res.trace.trace;
      run.critique = findCritiqueResult(res.trace.trace);
    }
    renderTimeline(run);
  } catch (e) {
    els.badge.textContent = '!';
    els.badge.className = 'badge badge-xs badge-error';
    console.error('Refresh failed:', e);
  }
}

async function loadStoredTraces() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TRACES', limit: 50 });
    if (res.traces?.length) {
      state.history = res.traces.map(t => ({
        id: t.traceId, action: t.trace?.name, params: t.trace?.input, time: new Date(t.timestamp),
        status: t.status, duration: t.trace?.duration, trace: t.trace, error: t.error,
        critique: findCritiqueResult(t.trace)
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
    showEmptyState();
  }
}

function showEmptyState() {
  els.timeline.innerHTML = `
    <div class="debug-empty-state">
      <div class="debug-empty-icon">▷</div>
      <div class="debug-empty-text">Run an action to see trace</div>
    </div>
  `;
  els.timing.textContent = '';
  els.badge.textContent = '';
}

async function deleteHistoryItem(idx) {
  const run = state.history[idx];
  if (!run) return;

  try { await chrome.runtime.sendMessage({ type: 'DELETE_TRACE', traceId: run.id }); } catch {}

  state.history.splice(idx, 1);
  if (state.selected === idx) {
    state.selected = state.history.length > 0 ? 0 : -1;
    if (state.selected >= 0) {
      selectHistory(0);
    } else {
      showEmptyState();
    }
  } else if (state.selected > idx) {
    state.selected--;
  }
  renderHistory();
}

const formatDuration = ms => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;
const formatTime = d => d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
const escapeHtml = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
