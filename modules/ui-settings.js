// UI Settings Management
import { elements } from './dom.js';
import * as storage from './storage.js';
import { getModelStatsCounter } from './time-bucket-counter.js';

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
  await storage.set({ uiTheme: currentTheme, uiZoom: currentZoom });
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

  const models = Object.keys(allStats);
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

export async function initUiSettings() {
  const { uiTheme, uiZoom } = await storage.get(['uiTheme', 'uiZoom']);

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

export { renderModelStats };
