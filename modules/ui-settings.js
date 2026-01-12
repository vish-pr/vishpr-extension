// UI Settings Management
import { elements } from './dom.js';
import * as storage from './storage.js';

const THEMES = ['cupcake', 'retro', 'sunset', 'night'];
const DEFAULT_THEME = 'night';
const ZOOM = { min: 75, max: 150, default: 100, step: 5 };

let currentTheme = DEFAULT_THEME;
let currentZoom = 100;

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
  const modelsTab = elements.settingsModelsTab;
  const uiTab = elements.settingsUiTab;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');

      const target = tab.dataset.settingsTab;
      modelsTab.classList.toggle('hidden', target !== 'models');
      uiTab.classList.toggle('hidden', target !== 'ui');
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

export async function initUiSettings() {
  const { uiTheme, uiZoom } = await storage.get(['uiTheme', 'uiZoom']);

  // Apply saved or default settings
  applyTheme(uiTheme || DEFAULT_THEME);
  applyZoom(uiZoom ?? ZOOM.default);

  // Setup event listeners
  setupSettingsTabs();
  setupThemeSelector();
  setupZoomControls();
  setupResetButton();
}
