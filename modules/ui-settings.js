// UI Settings Management
import { elements } from './dom.js';
import { getModelStatsCounter, getActionStatsCounter } from './debug/time-bucket-counter.js';

const THEMES = ['cupcake', 'retro', 'sunset', 'night'];
const DEFAULT_THEME = 'night';
const ZOOM = { min: 70, max: 150, default: 100, step: 10 };
const STATS_WINDOW = 100;
const DEFAULT_STATS_TIME_FILTER = 604800000; // 1 week in ms

let currentTheme = DEFAULT_THEME;
let currentZoom = 100;

const tpl = id => /** @type {Element} */ (/** @type {HTMLTemplateElement} */ (document.getElementById(id)).content.cloneNode(true)).firstElementChild;

function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = DEFAULT_THEME;
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  // Update button states
  elements.themeSelector.querySelectorAll('.theme-btn').forEach(btn => {
    const isActive = btn.dataset.theme === theme;
    btn.classList.toggle('border-primary', isActive);
    btn.classList.toggle('bg-base-content/5', isActive);
  });
}

function applyZoom(level) {
  currentZoom = Math.max(ZOOM.min, Math.min(ZOOM.max, level));
  document.documentElement.style.fontSize = `${currentZoom}%`;
  elements.zoomLevel.textContent = `${currentZoom}%`;
  elements.zoomSlider.value = currentZoom;

  // Update button states
  elements.zoomOut.disabled = currentZoom <= ZOOM.min;
  elements.zoomIn.disabled = currentZoom >= ZOOM.max;
  elements.zoomOut.classList.toggle('btn-disabled', currentZoom <= ZOOM.min);
  elements.zoomIn.classList.toggle('btn-disabled', currentZoom >= ZOOM.max);
}

async function saveSettings() {
  await chrome.storage.local.set({ uiTheme: currentTheme, uiZoom: currentZoom });
}

function setupSettingsTabs() {
  const tabs = document.querySelectorAll('[data-settings-tab]');
  const tabPanels = {
    models: elements.settingsModelsTab,
    ui: elements.settingsUiTab
  };

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');

      const target = /** @type {HTMLElement} */ (tab).dataset.settingsTab;
      Object.entries(tabPanels).forEach(([key, panel]) => {
        panel.classList.toggle('hidden', key !== target);
      });
    });
  });
}

function setupThemeSelector() {
  elements.themeSelector.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-btn');
    if (!btn) return;
    const theme = btn.dataset.theme;
    if (theme && THEMES.includes(theme)) {
      applyTheme(theme);
      saveSettings();
    }
  });
}

function setupPositionSelector() {
  // Open Chrome appearance settings where users can change side panel position
  elements.openPositionSettings.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/appearance' });
  });
}

function setupZoomControls() {
  elements.zoomIn.addEventListener('click', () => {
    applyZoom(currentZoom + ZOOM.step);
    saveSettings();
  });

  elements.zoomOut.addEventListener('click', () => {
    applyZoom(currentZoom - ZOOM.step);
    saveSettings();
  });

  elements.zoomSlider.addEventListener('input', () => {
    applyZoom(parseInt(elements.zoomSlider.value, 10));
  });

  elements.zoomSlider.addEventListener('change', () => {
    saveSettings();
  });
}

function setupResetButton() {
  elements.resetUiBtn.addEventListener('click', async () => {
    applyTheme(DEFAULT_THEME);
    applyZoom(ZOOM.default);
    await saveSettings();
  });
}

// Model Stats Rendering
function getSuccessRate(stats) {
  if (!stats) return { rate: 0, total: 0, success: 0, error: 0 };
  const success = stats.success?.total || 0;
  const error = stats.error?.total || 0;
  const total = success + error;
  // Cap at last STATS_WINDOW events for rate calculation
  const cappedTotal = Math.min(total, STATS_WINDOW);
  const cappedSuccess = total > STATS_WINDOW ? Math.round(success * (STATS_WINDOW / total)) : success;
  const rate = cappedTotal > 0 ? Math.round((cappedSuccess / cappedTotal) * 100) : 0;
  return { rate, total, success, error };
}

function getColorClass(rate) {
  if (rate >= 90) return 'text-success';
  if (rate >= 70) return 'text-warning';
  return 'text-error';
}

function getProgressColor(rate) {
  if (rate >= 90) return 'var(--color-status-success)';
  if (rate >= 70) return 'oklch(0.7 0.15 85)';
  return 'var(--color-status-error)';
}

function formatModelName(modelId) {
  const base = modelId.split('@')[0];
  const parts = base.split('/');
  return parts.length > 1 ? parts[1] : base;
}

function formatProvider(modelId) {
  const [base, providers] = modelId.split('@');
  const parts = base.split('/');
  const vendor = parts.length > 1 ? parts[0] : '';
  return providers ? `${vendor} via ${providers}` : vendor;
}

function createStatsCard(modelId, stats) {
  const { rate, total, success, error } = getSuccessRate(stats);
  const el = tpl('tpl-stats-card');
  const progress = el.querySelector('.radial-progress');
  progress.style.setProperty('--value', rate);
  progress.style.color = getProgressColor(rate);
  progress.classList.add(getColorClass(rate));
  progress.setAttribute('aria-valuenow', rate);
  el.querySelector('.stat-rate').textContent = `${rate}%`;
  el.querySelector('.stat-model').textContent = formatModelName(modelId);
  el.querySelector('.stat-model').title = modelId;
  el.querySelector('.stat-provider').textContent = formatProvider(modelId);
  el.querySelector('.stat-success').textContent = success;
  el.querySelector('.stat-error').textContent = error;
  el.querySelector('.stat-total').textContent = `${total} total`;
  return el;
}

function isProviderKey(key) {
  return key.startsWith('provider:');
}

function getProviderName(providerKey) {
  return providerKey.replace('provider:', '');
}

function createProviderStatsCard(provider, stats) {
  const { rate, total, success, error } = getSuccessRate(stats);
  const el = document.createElement('div');
  el.className = 'provider-stat-card bg-base-300/60 rounded-lg p-2.5 border border-base-content/10';
  el.innerHTML = `
    <div class="flex items-center gap-2">
      <div class="radial-progress text-xs font-mono shrink-0 ${getColorClass(rate)}" style="--size:2.5rem; --thickness:3px; --value:${rate};" role="progressbar">
        <span class="text-xs font-semibold">${rate}%</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-mono text-xs truncate font-medium">${provider}</div>
        <div class="flex gap-2 mt-0.5">
          <span class="text-xs text-success">${success} ok</span>
          <span class="text-xs text-error">${error} err</span>
          <span class="text-xs opacity-50">${total} total</span>
        </div>
      </div>
    </div>
  `;
  el.querySelector('.radial-progress').style.color = getProgressColor(rate);
  return el;
}

/** Get the current stats time filter value from the dropdown */
function getStatsTimeFilter() {
  const select = document.getElementById('statsTimeFilter');
  return select ? parseInt(select.value, 10) : DEFAULT_STATS_TIME_FILTER;
}

async function renderModelStats(timeFilterMs = getStatsTimeFilter()) {
  const counter = getModelStatsCounter();
  const cutoffTime = Date.now() - timeFilterMs;
  const allStats = await counter.getAllStats(cutoffTime);
  const container = elements.modelStatsContainer;
  container.innerHTML = '';

  // Filter to entries with data in the time window
  const allKeys = Object.keys(allStats).filter(k => {
    const stats = allStats[k];
    // Check if there's any actual data (success or error > 0)
    return (stats.success?.total || 0) + (stats.error?.total || 0) > 0;
  });
  const providers = allKeys.filter(isProviderKey);
  const models = allKeys.filter(k => !isProviderKey(k));

  if (!models.length && !providers.length) {
    container.innerHTML = '<div class="text-center py-8 opacity-50"><svg class="w-10 h-10 mx-auto mb-2 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg><p class="text-xs">No model stats in selected time range</p><p class="text-xs opacity-60 mt-1">Try selecting a longer time period</p></div>';
    return;
  }

  // Sort providers by total usage
  providers.sort((a, b) => {
    const totalA = (allStats[a].success?.total || 0) + (allStats[a].error?.total || 0);
    const totalB = (allStats[b].success?.total || 0) + (allStats[b].error?.total || 0);
    return totalB - totalA;
  });

  // Sort models by total usage (descending)
  models.sort((a, b) => {
    const totalA = (allStats[a].success?.total || 0) + (allStats[a].error?.total || 0);
    const totalB = (allStats[b].success?.total || 0) + (allStats[b].error?.total || 0);
    return totalB - totalA;
  });

  // Calculate totals from models (not providers to avoid double counting)
  let totalSuccess = 0, totalError = 0;
  models.forEach(m => {
    totalSuccess += allStats[m].success?.total || 0;
    totalError += allStats[m].error?.total || 0;
  });
  const totalAll = totalSuccess + totalError;
  const overallRate = totalAll > 0 ? Math.round((totalSuccess / totalAll) * 100) : 0;

  // Render summary
  const summary = tpl('tpl-stats-summary');
  const rateEl = summary.querySelector('.summary-rate');
  rateEl.textContent = `${overallRate}%`;
  rateEl.classList.add(getColorClass(overallRate));
  summary.querySelector('.summary-calls').textContent = `${totalAll} calls`;
  summary.querySelector('.summary-ok').textContent = `${totalSuccess} ok`;
  summary.querySelector('.summary-err').textContent = `${totalError} err`;
  container.appendChild(summary);

  // Render provider stats section
  if (providers.length) {
    const providerSection = document.createElement('div');
    providerSection.className = 'mb-3';
    providerSection.innerHTML = '<div class="text-xs uppercase tracking-wide opacity-40 mb-1.5 font-medium">By Provider</div>';
    const providerGrid = document.createElement('div');
    providerGrid.className = 'grid gap-1.5';
    providers.forEach(p => providerGrid.appendChild(createProviderStatsCard(getProviderName(p), allStats[p])));
    providerSection.appendChild(providerGrid);
    container.appendChild(providerSection);
  }

  // Render model stats section
  if (models.length) {
    const modelSection = document.createElement('div');
    modelSection.innerHTML = '<div class="text-xs uppercase tracking-wide opacity-40 mb-1.5 font-medium">By Model</div>';
    const modelGrid = document.createElement('div');
    modelGrid.className = 'grid gap-2';
    models.forEach(m => modelGrid.appendChild(createStatsCard(m, allStats[m])));
    modelSection.appendChild(modelGrid);
    container.appendChild(modelSection);
  }
}

// Action Stats Rendering - Generic hierarchical display
const GROUP_COLORS = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#6366f1',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#a855f7'
];

/**
 * Group stats by prefix hierarchy (using : as delimiter)
 * e.g., { 'executions': 5, 'choice:CLICK': 3, 'choice:FILL': 2 }
 * becomes { _root: { executions: 5 }, choice: { CLICK: 3, FILL: 2 } }
 */
function groupStatsByPrefix(stats) {
  const groups = { _root: {} };

  for (const [key, value] of Object.entries(stats)) {
    // Skip internal keys
    if (key === '_lastActivity') continue;
    const total = value?.total ?? value;
    if (typeof total !== 'number') continue;

    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) {
      // No prefix - goes to root
      groups._root[key] = total;
    } else {
      // Has prefix - group by it
      const prefix = key.slice(0, colonIdx);
      const suffix = key.slice(colonIdx + 1);
      groups[prefix] ??= {};
      groups[prefix][suffix] = total;
    }
  }

  return groups;
}

/**
 * Create a stat group section with bar visualization
 */
function createStatGroup(groupName, entries, colorIdx = 0) {
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return '';

  const barsHtml = entries
    .sort((a, b) => b[1] - a[1])
    .map(([name, count], idx) => {
      const pct = (count / total) * 100;
      const color = GROUP_COLORS[(colorIdx + idx) % GROUP_COLORS.length];
      return `
        <div class="flex items-center gap-2">
          <span class="text-xs font-mono w-28 truncate opacity-70" title="${name}">${name}</span>
          <div class="flex-1 h-1.5 bg-base-content/10 rounded-full overflow-hidden">
            <div class="h-full rounded-full" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="text-xs font-mono tabular-nums opacity-50 w-8 text-right">${count}</span>
        </div>`;
    }).join('');

  return `
    <div class="stat-group mb-2">
      <div class="text-xs uppercase tracking-wider opacity-40 mb-1">${groupName} <span class="opacity-50">(${total})</span></div>
      <div class="space-y-1">${barsHtml}</div>
    </div>`;
}

/**
 * Create action card with all stats grouped by hierarchy
 */
function createActionCard(actionName, stats) {
  const groups = groupStatsByPrefix(stats);
  const prefixGroups = Object.entries(groups).filter(([k]) => k !== '_root');

  // Calculate total runs from executions + errors (if present)
  const executions = groups._root.executions || 0;
  const errors = groups._root.errors || 0;
  const totalRuns = executions + errors;
  const errorRate = totalRuns > 0 ? Math.round((errors / totalRuns) * 100) : 0;

  // Handle iterations specially - show average instead of total
  const iterations = groups._root.iterations || 0;
  const avgIterations = totalRuns > 0 ? (iterations / totalRuns).toFixed(1) : 0;

  // Filter and transform root entries
  const rootEntries = Object.entries(groups._root)
    .filter(([name]) => name !== 'iterations') // Remove raw iterations, we show avg instead
    .map(([name, count]) => {
      // Add avg iterations as a derived stat
      if (name === 'executions' && iterations > 0) {
        return [name, count, `~${avgIterations} iter/run`];
      }
      return [name, count, null];
    });

  // Build details HTML
  let detailsHtml = '';

  // Root stats as simple badges
  if (rootEntries.length > 0) {
    const badges = rootEntries
      .sort((a, b) => b[1] - a[1])
      .map(([name, count, extra]) => {
        let badgeClass = 'badge-ghost';
        if (name === 'errors' && count > 0) badgeClass = 'badge-error';
        else if (name === 'executions') badgeClass = 'badge-success';
        const extraHtml = extra ? ` <span class="opacity-60">${extra}</span>` : '';
        return `<span class="badge badge-xs ${badgeClass}">${name}: ${count}${extraHtml}</span>`;
      }).join('');
    detailsHtml += `<div class="flex flex-wrap gap-1 mb-2">${badges}</div>`;
  }

  // Grouped stats with bars
  prefixGroups.forEach(([prefix, items], idx) => {
    const entries = Object.entries(items);
    if (entries.length > 0) {
      detailsHtml += createStatGroup(prefix, entries, idx * 3);
    }
  });

  return `
    <div class="action-stat-card bg-base-300/80 rounded-lg border border-base-content/8 overflow-hidden">
      <div class="action-card-header flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-base-content/5 transition-colors">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:var(--dbg-action)"></span>
        <span class="font-mono text-xs font-medium flex-1 truncate" title="${actionName}">${actionName}</span>
        <span class="text-xs opacity-60 tabular-nums">${totalRuns} runs</span>
        ${errorRate > 0 ? `<span class="text-xs font-mono ${errorRate > 20 ? 'text-error' : 'text-warning'}">${errorRate}% err</span>` : ''}
        <svg class="action-expand-icon w-3 h-3 opacity-40 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="action-card-details hidden border-t border-base-content/5 px-3 py-2">
        ${detailsHtml || '<span class="text-xs opacity-40">No detailed stats</span>'}
      </div>
    </div>`;
}

async function renderActionStats(timeFilterMs = getStatsTimeFilter()) {
  const counter = getActionStatsCounter();
  const cutoffTime = Date.now() - timeFilterMs;
  const allStats = await counter.getAllStats(cutoffTime);
  const container = elements.actionStatsContainer;
  container.innerHTML = '';

  // Filter to actions with data in the time window
  const recentActions = Object.keys(allStats).filter(name => {
    const stats = allStats[name];
    // Check for any counter with data
    return Object.values(stats).some(v => v?.total > 0);
  });

  if (!recentActions.length) {
    container.innerHTML = '<div class="text-center py-6 opacity-40"><p class="text-xs">No action stats in selected time range</p></div>';
    return;
  }

  // Sort by total runs (descending)
  recentActions.sort((a, b) => {
    const runsA = (allStats[a].executions?.total ?? allStats[a].executions ?? 0) + (allStats[a].errors?.total ?? allStats[a].errors ?? 0);
    const runsB = (allStats[b].executions?.total ?? allStats[b].executions ?? 0) + (allStats[b].errors?.total ?? allStats[b].errors ?? 0);
    return runsB - runsA;
  });

  // Render cards as HTML
  const cardsHtml = recentActions.map(name => createActionCard(name, allStats[name])).join('');
  container.innerHTML = `<div class="space-y-2">${cardsHtml}</div>`;

  // Event delegation for expanding/collapsing cards (only add once)
  if (!container.dataset.hasClickHandler) {
    container.dataset.hasClickHandler = 'true';
    container.addEventListener('click', (e) => {
      const header = e.target.closest('.action-card-header');
      if (!header) return;
      const details = header.nextElementSibling;
      const icon = header.querySelector('.action-expand-icon');
      if (details) {
        details.classList.toggle('hidden');
        if (icon) icon.style.transform = details.classList.contains('hidden') ? '' : 'rotate(180deg)';
      }
    });
  }
}

export async function initUiSettings() {
  const { uiTheme, uiZoom } = await chrome.storage.local.get(['uiTheme', 'uiZoom']);

  // Apply saved or default settings
  applyTheme(uiTheme || DEFAULT_THEME);
  applyZoom(uiZoom ?? ZOOM.default);

  // Setup event listeners
  setupSettingsTabs();
  setupThemeSelector();
  setupPositionSelector();
  setupZoomControls();
  setupResetButton();
}

/** Refresh both model and action stats with current time filter */
async function refreshStats() {
  const timeFilter = getStatsTimeFilter();
  await Promise.all([
    renderModelStats(timeFilter),
    renderActionStats(timeFilter)
  ]);
}

/** Setup the stats time filter dropdown listener */
function setupStatsTimeFilter() {
  const select = document.getElementById('statsTimeFilter');
  if (select) {
    select.addEventListener('change', refreshStats);
  }
}

export { renderModelStats, renderActionStats, refreshStats, setupStatsTimeFilter, getStatsTimeFilter };
