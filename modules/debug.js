/**
 * Debug Mode - Action execution with trace/critique visualization
 */

// SVG icons for consistent rendering
const ICONS = {
  chevron: '<svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>',
  check: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
  x: '<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  dot: '<svg class="size-2.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
};

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
    trace: document.getElementById('debugTrace'),
    timing: document.getElementById('debugTiming'),
    critique: document.getElementById('debugCritique'),
    badge: document.getElementById('debugCritiqueBadge'),
    refreshBtn: document.getElementById('debugRefreshBtn'),
  };

  els.toggle.addEventListener('click', toggleMode);
  els.input.addEventListener('input', onInput);
  els.input.addEventListener('keydown', onKeydown);
  els.input.addEventListener('focus', () => showAutocomplete(ACTIONS));
  els.input.addEventListener('blur', () => setTimeout(hideAutocomplete, 150));
  els.runBtn.addEventListener('click', execute);
  els.clearBtn.addEventListener('click', reloadTraces);
  els.refreshBtn.addEventListener('click', refreshCritique);

  state.tabId = await getCurrentTabId();
  await loadStoredTraces();
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
  document.getElementById('statusText').textContent = isDebug ? 'Ready' : 'Debug Mode';
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
  const runId = Date.now().toString();
  const run = { id: runId, action: actionName.toUpperCase(), params, time: new Date(), status: 'running' };

  showRunning(run);

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'DEBUG_EXECUTE', actionName: actionName.toUpperCase(), params, tabId: state.tabId, runId
    });
    run.status = res.error ? 'error' : 'success';
    run.trace = res.trace;
    run.error = res.error;
    run.duration = res.trace?.duration;
    renderTrace(res.trace);
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
  els.trace.innerHTML = `<div class="animate-pulse">Running ${run.action}...</div>`;
  els.critique.innerHTML = `<div class="opacity-30 text-center">Waiting...</div>`;
  els.badge.textContent = '';
}

function showError(msg) {
  els.trace.innerHTML = `<div class="text-error">${escapeHtml(msg)}</div>`;
}

function renderTrace(trace) {
  if (!trace) return;
  els.trace.innerHTML = renderNode(trace);
  els.trace.querySelectorAll('.trace-node').forEach(el =>
    el.querySelector('.trace-header')?.addEventListener('click', () => el.classList.toggle('expanded'))
  );
}

function renderNode(node) {
  const hasChildren = node.children?.length > 0;
  const hasDetails = node.input || node.output || node.error || node.context || node.model || node.prompt;
  const icons = { action: 'A', step: 'S', function: 'F', llm: 'L', chrome: 'C', context: '{}', iteration: '?' };
  const icon = icons[node.type] || '?';
  const statusIcon = { success: ICONS.check, error: ICONS.x, running: ICONS.dot }[node.status] || '';
  const statusClass = `trace-status-${node.status || 'pending'}`;

  const details = [];
  if (node.model) details.push(detailRow('MODEL', node.model));
  if (node.tokens) details.push(detailRow('TOKENS', `${node.tokens.input || 0} in / ${node.tokens.output || 0} out`));
  if (node.input) details.push(detailRow('INPUT', `<pre>${escapeHtml(JSON.stringify(node.input, null, 2))}</pre>`));
  if (node.prompt) details.push(detailRow('PROMPT', `<pre>${escapeHtml(node.prompt)}</pre>`));
  if (node.output) details.push(detailRow('RESULT', `<pre>${escapeHtml(JSON.stringify(node.output, null, 2))}</pre>`));
  if (node.context) details.push(detailRow('CONTEXT', `<pre>${escapeHtml(JSON.stringify(node.context, null, 2))}</pre>`));
  if (node.error) details.push(detailRow('ERROR', `<span class="text-error">${escapeHtml(String(node.error))}</span>`));

  return `
    <div class="trace-node">
      <div class="trace-header">
        <span class="trace-toggle">${hasChildren || hasDetails ? ICONS.chevron : ''}</span>
        <span class="trace-icon trace-icon-${node.type || 'step'}">${icon}</span>
        <span class="trace-name">${escapeHtml(node.name)}</span>
        ${node.stepType ? `<span class="trace-type">${node.stepType}</span>` : ''}
        ${node.duration ? `<span class="trace-timing">${formatDuration(node.duration)}</span>` : ''}
        <span class="${statusClass}">${statusIcon}</span>
      </div>
      ${details.length ? `<div class="trace-details">${details.join('')}</div>` : ''}
      ${hasChildren ? `<div class="trace-children">${node.children.map(renderNode).join('')}</div>` : ''}
    </div>
  `;
}

function detailRow(label, value) {
  return `<div class="trace-detail-row"><span class="trace-detail-label">${label}</span><div class="trace-detail-value">${value}</div></div>`;
}

function renderHistory() {
  els.history.innerHTML = state.history.map((run, i) => `
    <div class="p-1.5 rounded text-xs cursor-pointer ${i === state.selected ? 'bg-primary/20' : 'hover:bg-base-300'} ${run.status === 'error' ? 'border-l-2 border-error' : ''}" data-idx="${i}">
      <div class="flex items-center gap-1">
        <span class="font-mono truncate flex-1">${run.action}</span>
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
  if (run.trace) renderTrace(run.trace);
  else if (run.error) showError(run.error);
  els.timing.textContent = run.duration ? formatDuration(run.duration) : '';
  renderCritique(run);
}

function renderCritique(run) {
  if (!run?.critique) {
    els.critique.innerHTML = '<div class="opacity-30 text-center">Generating...</div>';
    els.badge.textContent = '...';
    els.badge.className = 'badge badge-xs badge-ghost';
    return;
  }

  const c = run.critique;
  const issues = (c.prompts?.issues?.length || 0) + (c.efficiency?.issues?.length || 0) + (c.errors?.issues?.length || 0);
  els.badge.textContent = issues || '✓';
  els.badge.className = `badge badge-xs ${issues ? 'badge-warning' : 'badge-success'}`;

  const sections = [
    { key: 'prompts', label: 'PROMPTS' },
    { key: 'efficiency', label: 'EFFICIENCY' },
    { key: 'errors', label: 'ERRORS' },
  ];

  els.critique.innerHTML = `
    ${c.summary ? `<div class="critique-summary"><b>Summary:</b> ${escapeHtml(c.summary)}</div>` : ''}
    ${c.topRecommendations?.length ? `
      <div class="mb-4">
        <div class="critique-section-title">TOP RECOMMENDATIONS</div>
        <ol class="critique-recommendations">
          ${c.topRecommendations.map((r, i) => `<li>${escapeHtml(r)}</li>`).join('')}
        </ol>
      </div>
    ` : ''}
    ${sections.map(s => {
      const items = c[s.key]?.issues || [];
      return items.length ? `
        <div class="mb-4">
          <div class="critique-section-title">${s.label} (${items.length})</div>
          ${items.map(i => `
            <div class="critique-issue critique-issue-${i.severity || 'low'}">
              <div class="flex justify-between items-start mb-1">
                <span class="critique-issue-location">${escapeHtml(i.location)}</span>
                <span class="critique-issue-badge critique-issue-badge-${i.severity || 'low'}">${i.severity?.toUpperCase() || 'LOW'}</span>
              </div>
              <div class="critique-issue-problem">${escapeHtml(i.problem)}</div>
              ${i.suggestion ? `<div class="critique-issue-suggestion"><b>Suggestion:</b> ${escapeHtml(i.suggestion)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      ` : '';
    }).join('')}
  `;
}

async function refreshCritique() {
  if (state.selected < 0) return;
  const run = state.history[state.selected];

  // Show loading state
  els.badge.textContent = '...';
  els.badge.className = 'badge badge-xs badge-ghost animate-pulse';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TRACE_BY_RUN_ID', runId: run.id });
    if (res.trace?.critique) {
      run.critique = res.trace.critique;
    }
    renderCritique(run);
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
        id: t.runId, action: t.actionName, params: t.params, time: new Date(t.timestamp),
        status: t.status, duration: t.duration, trace: t.trace, error: t.error, critique: t.critique
      }));
      renderHistory();
    }
  } catch (e) { console.error('Load failed:', e); }
}

async function reloadTraces() {
  await loadStoredTraces();
  if (state.history.length > 0) {
    selectHistory(0);
  } else {
    els.trace.innerHTML = '<div class="opacity-30 text-center h-full flex items-center justify-center">Run an action to see trace</div>';
    els.critique.innerHTML = '<div class="opacity-30 text-center h-full flex items-center justify-center">Critique appears after execution</div>';
    els.timing.textContent = '';
    els.badge.textContent = '';
  }
}

async function deleteHistoryItem(idx) {
  const run = state.history[idx];
  if (!run) return;

  try { await chrome.runtime.sendMessage({ type: 'DELETE_TRACE', runId: run.id }); } catch {}

  state.history.splice(idx, 1);
  if (state.selected === idx) {
    state.selected = state.history.length > 0 ? 0 : -1;
    if (state.selected >= 0) {
      selectHistory(0);
    } else {
      els.trace.innerHTML = '<div class="opacity-30 text-center h-full flex items-center justify-center">Run an action to see trace</div>';
      els.critique.innerHTML = '<div class="opacity-30 text-center h-full flex items-center justify-center">Critique appears after execution</div>';
      els.timing.textContent = '';
      els.badge.textContent = '';
    }
  } else if (state.selected > idx) {
    state.selected--;
  }
  renderHistory();
}

const formatDuration = ms => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;
const formatTime = d => d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
const escapeHtml = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
