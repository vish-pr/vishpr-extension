// Settings Management
import { elements } from './dom.js';
import * as storage from './storage.js';
import { addMessage } from './chat.js';
import { setApiKey } from './llm.js';

const STATUS = {
  VALID: { class: 'valid', icon: '✓', color: '#10b981' },
  INVALID: { class: 'invalid', icon: '✗', color: '#ef4444' },
  VERIFYING: { class: 'verifying', icon: '⏳', color: '#f59e0b' }
};

function updateApiKeyStatus(provider, status) {
  const input = provider === 'gemini' ? elements.geminiApiKey : elements.openrouterApiKey;
  const statusEl = provider === 'gemini' ? elements.geminiApiKeyStatus : elements.openrouterApiKeyStatus;

  input.classList.remove('valid', 'invalid', 'verifying');

  if (status === true) status = STATUS.VALID;
  else if (status === false) status = STATUS.INVALID;
  else if (status === 'verifying') status = STATUS.VERIFYING;
  else {
    statusEl.textContent = '';
    return;
  }

  input.classList.add(status.class);
  statusEl.textContent = status.icon;
  statusEl.style.color = status.color;
}

function updateHeaderTitle() {
  // Check if any provider is configured
  storage.get(['geminiApiKeyValid', 'openrouterApiKeyValid']).then(({ geminiApiKeyValid, openrouterApiKeyValid }) => {
    const isVerified = geminiApiKeyValid || openrouterApiKeyValid;
    elements.headerTitle.textContent = isVerified ? 'VishPro Agent ✓' : 'VishPro Agent';
    elements.headerTitle.style.color = isVerified ? '#10b981' : '#e0e0e0';
  });
}

function toggleSettings(show) {
  elements.settingsPanel.classList.toggle('hidden', !show);
  elements.settingsToggle.classList.toggle('active', show);
}

function toggleProviderSettings(provider) {
  if (provider === 'gemini') {
    elements.geminiSettings.style.display = 'block';
    elements.openrouterSettings.style.display = 'none';
  } else if (provider === 'openrouter') {
    elements.geminiSettings.style.display = 'none';
    elements.openrouterSettings.style.display = 'block';
  }
}

async function verifyApiKey(apiKey, provider) {
  updateApiKeyStatus(provider, 'verifying');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'verifyApiKey',
      apiKey,
      provider
    });

    const isValid = response.valid;

    // Store API key and validity
    const storageKey = provider === 'gemini' ? 'geminiApiKey' : 'openrouterApiKey';
    const validKey = provider === 'gemini' ? 'geminiApiKeyValid' : 'openrouterApiKeyValid';

    await storage.set({
      [storageKey]: apiKey,
      [validKey]: isValid
    });

    // Also update the LLM client
    await setApiKey(apiKey, provider);

    updateApiKeyStatus(provider, isValid);
    updateHeaderTitle();

    if (isValid) {
      addMessage('system', `✓ ${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} API Key verified and saved`);
      setTimeout(() => toggleSettings(false), 1000);
    } else {
      addMessage('system', `✗ Invalid ${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} API Key: ${response.error || 'Verification failed'}`);
    }
  } catch (error) {
    updateApiKeyStatus(provider, false);
    addMessage('system', `✗ Verification error: ${error.message}`);
  }
}

function setupProviderSelect() {
  elements.providerSelect.addEventListener('change', () => {
    const provider = elements.providerSelect.value;
    toggleProviderSettings(provider);
    storage.set({ selectedProvider: provider });
  });
}

function setupGeminiApiKeyInput() {
  elements.geminiApiKey.addEventListener('change', async () => {
    const apiKey = elements.geminiApiKey.value.trim();

    if (!apiKey) {
      await storage.remove(['geminiApiKey', 'geminiApiKeyValid']);
      updateApiKeyStatus('gemini', false);
      updateHeaderTitle();
      return;
    }

    await verifyApiKey(apiKey, 'gemini');
  });
}

function setupOpenRouterApiKeyInput() {
  elements.openrouterApiKey.addEventListener('change', async () => {
    const apiKey = elements.openrouterApiKey.value.trim();

    if (!apiKey) {
      await storage.remove(['openrouterApiKey', 'openrouterApiKeyValid']);
      updateApiKeyStatus('openrouter', false);
      updateHeaderTitle();
      return;
    }

    await verifyApiKey(apiKey, 'openrouter');
  });
}

function setupIntelligenceSelect() {
  elements.intelligenceSelect.addEventListener('change', async () => {
    await storage.set({ intelligenceLevel: elements.intelligenceSelect.value });
    const selectedLevel = elements.intelligenceSelect.options[elements.intelligenceSelect.selectedIndex].text;
    addMessage('system', `Intelligence level changed to ${selectedLevel}`);
  });
}

function setupSettingsToggle() {
  elements.settingsToggle.addEventListener('click', () => {
    const isHidden = elements.settingsPanel.classList.contains('hidden');
    toggleSettings(isHidden);
  });
}

export async function initSettings() {
  const {
    geminiApiKey,
    geminiApiKeyValid,
    openrouterApiKey,
    openrouterApiKeyValid,
    selectedProvider,
    intelligenceLevel
  } = await storage.get([
    'geminiApiKey',
    'geminiApiKeyValid',
    'openrouterApiKey',
    'openrouterApiKeyValid',
    'selectedProvider',
    'intelligenceLevel'
  ]);

  // Set up Gemini API key
  if (geminiApiKey) {
    elements.geminiApiKey.value = geminiApiKey;
    updateApiKeyStatus('gemini', geminiApiKeyValid);
    // Initialize LLM client with stored key
    await setApiKey(geminiApiKey, 'gemini');
  }

  // Set up OpenRouter API key
  if (openrouterApiKey) {
    elements.openrouterApiKey.value = openrouterApiKey;
    updateApiKeyStatus('openrouter', openrouterApiKeyValid);
    // Initialize LLM client with stored key
    await setApiKey(openrouterApiKey, 'openrouter');
  }

  // Set selected provider
  if (selectedProvider) {
    elements.providerSelect.value = selectedProvider;
    toggleProviderSettings(selectedProvider);
  } else {
    toggleProviderSettings('gemini');
  }

  // Set intelligence level
  if (intelligenceLevel) {
    elements.intelligenceSelect.value = intelligenceLevel;
  }

  // Show settings if no API keys are configured
  const hasValidKey = geminiApiKeyValid || openrouterApiKeyValid;
  if (!hasValidKey) {
    toggleSettings(true);
  }

  updateHeaderTitle();

  // Setup event listeners
  setupSettingsToggle();
  setupProviderSelect();
  setupGeminiApiKeyInput();
  setupOpenRouterApiKeyInput();
  setupIntelligenceSelect();

  return hasValidKey;
}
