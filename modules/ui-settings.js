// UI Settings Management
import { elements } from './dom.js';
import { getModelStatsCounter, getActionStatsCounter } from './debug/time-bucket-counter.js';

const THEMES = ['cupcake', 'retro', 'sunset', 'night'];
const DEFAULT_THEME = 'night';
const ZOOM = { min: 70, max: 150, default: 100, step: 10 };
const STATS_WINDOW = 100;

let currentTheme = DEFAULT_THEME;
let currentZoom = 100;

const tpl = id => document.getElementById(id).content.cloneNode(true).firstElementChild;

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

      const target = tab.dataset.settingsTab;
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

// Action Stats Rendering
const ACTION_COLORS = {
  BROWSER_ROUTER: 'var(--dbg-action)',
  BROWSER_ACTION: 'var(--dbg-chrome)',
  FINAL_RESPONSE: 'var(--dbg-success)',
  LLM_TOOL: 'var(--dbg-llm)',
  CLEAN_CONTENT: 'var(--dbg-context)',
  CRITIQUE: 'var(--dbg-function)',
  default: 'var(--dbg-action)'
};

const CHOICE_COLORS = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#6366f1',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#a855f7'
];

function getActionColor(actionName) {
  // Check for router-type actions
  if (actionName.includes('ROUTER')) return ACTION_COLORS.BROWSER_ROUTER;
  // Check for browser actions (lowercase patterns)
  if (actionName.startsWith('click_') || actionName.startsWith('scroll_') ||
      actionName.startsWith('type_') || actionName.startsWith('navigate_') ||
      actionName.startsWith('extract_') || actionName.startsWith('read_')) {
    return ACTION_COLORS.BROWSER_ACTION;
  }
  return ACTION_COLORS[actionName] || ACTION_COLORS.default;
}

function parseActionStats(stats) {
  const executions = stats.executions?.total || 0;
  const errors = stats.errors?.total || 0;
  const errorRate = executions + errors > 0 ? Math.round((errors / (executions + errors)) * 100) : 0;

  // Extract choices (keys starting with "choice:")
  const choices = {};
  for (const [key, value] of Object.entries(stats)) {
    if (key.startsWith('choice:')) {
      const choiceName = key.slice(7);
      choices[choiceName] = value.total || 0;
    }
  }

  // Get iterations
  const iterations = stats.iterations?.total || 0;
  const avgIterations = executions > 0 ? (iterations / executions).toFixed(1) : 0;

  // Anomalies
  const anomalies = [];
  if (stats.maxIterationsReached?.total > 0) {
    anomalies.push({ type: 'maxIter', count: stats.maxIterationsReached.total });
  }
  if (stats.textInsteadOfTool?.total > 0) {
    anomalies.push({ type: 'textNoTool', count: stats.textInsteadOfTool.total });
  }
  if (stats.invalidJsonArgs?.total > 0) {
    anomalies.push({ type: 'badJson', count: stats.invalidJsonArgs.total });
  }
  if (stats.unknownAction?.total > 0) {
    anomalies.push({ type: 'unknown', count: stats.unknownAction.total });
  }

  return { executions, errors, errorRate, choices, iterations, avgIterations, anomalies };
}

function createActionCard(actionName, stats, skipStats) {
  const el = tpl('tpl-action-card');
  const parsed = parseActionStats(stats);

  // Header
  el.querySelector('.action-type-dot').style.backgroundColor = getActionColor(actionName);
  el.querySelector('.action-name').textContent = actionName;
  el.querySelector('.action-name').title = actionName;
  el.querySelector('.action-executions').textContent = `${parsed.executions + parsed.errors} runs`;

  const errorEl = el.querySelector('.action-error-rate');
  if (parsed.errorRate > 0) {
    errorEl.textContent = `${parsed.errorRate}% err`;
    errorEl.classList.add(parsed.errorRate > 20 ? 'text-error' : 'text-warning');
  } else {
    errorEl.textContent = '';
  }

  // Click to expand
  const header = el.querySelector('.action-card-header');
  const details = el.querySelector('.action-card-details');
  const expandIcon = el.querySelector('.action-expand-icon');

  header.addEventListener('click', () => {
    const isExpanded = !details.classList.contains('hidden');
    details.classList.toggle('hidden');
    expandIcon.style.transform = isExpanded ? '' : 'rotate(180deg)';
  });

  // Choices
  const choiceEntries = Object.entries(parsed.choices);
  if (choiceEntries.length > 0) {
    const choicesSection = el.querySelector('.action-choices');
    const choiceBars = el.querySelector('.choice-bars');
    choicesSection.classList.remove('hidden');

    const totalChoices = choiceEntries.reduce((sum, [, count]) => sum + count, 0);
    choiceEntries.sort((a, b) => b[1] - a[1]);

    choiceEntries.forEach(([name, count], idx) => {
      const bar = tpl('tpl-choice-bar');
      bar.querySelector('.choice-name').textContent = name;
      bar.querySelector('.choice-name').title = name;
      const fill = bar.querySelector('.choice-bar-fill');
      fill.style.width = `${(count / totalChoices) * 100}%`;
      fill.style.backgroundColor = CHOICE_COLORS[idx % CHOICE_COLORS.length];
      bar.querySelector('.choice-count').textContent = count;
      choiceBars.appendChild(bar);
    });
  }

  // Iterations
  if (parsed.iterations > 0) {
    const iterSection = el.querySelector('.action-iterations');
    iterSection.classList.remove('hidden');
    el.querySelector('.iter-avg').textContent = `~${parsed.avgIterations} avg`;
    el.querySelector('.iter-max').textContent = `(${parsed.iterations} total)`;
  }

  // Anomalies
  if (parsed.anomalies.length > 0) {
    const anomSection = el.querySelector('.action-anomalies');
    const anomList = el.querySelector('.anomaly-list');
    anomSection.classList.remove('hidden');

    const labels = {
      maxIter: 'max iter',
      textNoTool: 'text→no tool',
      badJson: 'bad json',
      unknown: 'unknown act'
    };

    parsed.anomalies.forEach(({ type, count }) => {
      const badge = tpl('tpl-anomaly-badge');
      badge.textContent = `${labels[type]}: ${count}`;
      anomList.appendChild(badge);
    });
  }

  // Skip stats (for step-level actions like "ACTION:step0")
  if (skipStats.length > 0) {
    const skipSection = el.querySelector('.action-skips');
    const skipList = el.querySelector('.skip-list');
    skipSection.classList.remove('hidden');

    skipStats.forEach(({ step, skipped, notSkipped }) => {
      const total = skipped + notSkipped;
      if (total === 0) return;

      const row = tpl('tpl-skip-row');
      row.querySelector('.skip-step').textContent = step;
      row.querySelector('.skip-bar-skipped').style.width = `${(skipped / total) * 100}%`;
      row.querySelector('.skip-bar-run').style.width = `${(notSkipped / total) * 100}%`;
      row.querySelector('.skip-ratio').textContent = `${skipped}/${total}`;
      skipList.appendChild(row);
    });
  }

  return el;
}

async function renderActionStats() {
  const counter = getActionStatsCounter();
  const allStats = await counter.getAllStats();
  const container = elements.actionStatsContainer;
  container.innerHTML = '';

  // Separate action stats from step stats
  const actionStats = {};
  const stepStats = {};

  for (const [key, stats] of Object.entries(allStats)) {
    if (key.includes(':step')) {
      // Step-level stat like "BROWSER_ROUTER:step0"
      const [actionName, stepId] = key.split(':');
      stepStats[actionName] ??= [];
      stepStats[actionName].push({
        step: stepId,
        skipped: stats.skipped?.total || 0,
        notSkipped: stats.notSkipped?.total || 0
      });
    } else {
      actionStats[key] = stats;
    }
  }

  const actionNames = Object.keys(actionStats);
  if (!actionNames.length) {
    container.innerHTML = '<div class="text-center py-6 opacity-40"><p class="text-xs">No action stats yet</p></div>';
    return;
  }

  // Filter to actions used in the last week
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentActions = actionNames.filter(name => (allStats[name]._lastActivity || 0) >= oneWeekAgo);

  if (!recentActions.length) {
    container.innerHTML = '<div class="text-center py-6 opacity-40"><p class="text-xs">No recent action stats</p></div>';
    return;
  }

  // Sort by total runs
  recentActions.sort((a, b) => {
    const totalA = (actionStats[a].executions?.total || 0) + (actionStats[a].errors?.total || 0);
    const totalB = (actionStats[b].executions?.total || 0) + (actionStats[b].errors?.total || 0);
    return totalB - totalA;
  });

  // Render cards
  const grid = document.createElement('div');
  grid.className = 'space-y-2';

  recentActions.forEach(name => {
    const skipData = stepStats[name] || [];
    grid.appendChild(createActionCard(name, actionStats[name], skipData));
  });

  container.appendChild(grid);
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
