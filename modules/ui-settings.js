// UI Settings Management
import { elements } from './dom.js';
import { getModelStatsCounter, getActionStatsCounter } from './debug/time-bucket-counter.js';

const THEMES = ['cupcake', 'retro', 'sunset', 'night'];
const DEFAULT_THEME = 'night';
const ZOOM = { min: 70, max: 150, default: 100, step: 10 };
const STATS_WINDOW = 100;

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

async function renderModelStats() {
  const counter = getModelStatsCounter();
  const allStats = await counter.getAllStats();
  const container = elements.modelStatsContainer;
  container.innerHTML = '';

  // Filter to models used in the last week
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const models = Object.keys(allStats).filter(m => (allStats[m]._lastActivity || 0) >= oneWeekAgo);

  if (!models.length) {
    container.innerHTML = '<div class="text-center py-8 opacity-50"><svg class="w-10 h-10 mx-auto mb-2 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg><p class="text-xs">No model stats yet</p><p class="text-[10px] opacity-60 mt-1">Stats appear after models are used</p></div>';
    return;
  }

  // Sort by total usage (descending)
  models.sort((a, b) => {
    const totalA = (allStats[a].success?.total || 0) + (allStats[a].error?.total || 0);
    const totalB = (allStats[b].success?.total || 0) + (allStats[b].error?.total || 0);
    return totalB - totalA;
  });

  // Calculate totals
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

  // Render cards
  const grid = document.createElement('div');
  grid.className = 'grid gap-2';
  models.forEach(m => grid.appendChild(createStatsCard(m, allStats[m])));
  container.appendChild(grid);
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
          <span class="text-[10px] font-mono w-28 truncate opacity-70" title="${name}">${name}</span>
          <div class="flex-1 h-1.5 bg-base-content/10 rounded-full overflow-hidden">
            <div class="h-full rounded-full" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="text-[10px] font-mono tabular-nums opacity-50 w-8 text-right">${count}</span>
        </div>`;
    }).join('');

  return `
    <div class="stat-group mb-2">
      <div class="text-[10px] uppercase tracking-wider opacity-40 mb-1">${groupName} <span class="opacity-50">(${total})</span></div>
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

async function renderActionStats() {
  const counter = getActionStatsCounter();
  const allStats = await counter.getAllStats();
  const container = elements.actionStatsContainer;
  container.innerHTML = '';

  const actionNames = Object.keys(allStats);
  if (!actionNames.length) {
    container.innerHTML = '<div class="text-center py-6 opacity-40"><p class="text-xs">No action stats yet</p></div>';
    return;
  }

  // Filter to actions updated in the last 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentActions = actionNames.filter(name => (allStats[name]._lastActivity || 0) >= sevenDaysAgo);

  if (!recentActions.length) {
    container.innerHTML = '<div class="text-center py-6 opacity-40"><p class="text-xs">No stats in last 7 days</p></div>';
    return;
  }

  // Sort by last activity (most recent first)
  recentActions.sort((a, b) => (allStats[b]._lastActivity || 0) - (allStats[a]._lastActivity || 0));

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

export { renderModelStats, renderActionStats };
