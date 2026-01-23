import { initSettings } from './modules/settings.js';
import { initUiSettings } from './modules/ui-settings.js';
import { initChat } from './modules/chat.js';
import { initDebug } from './modules/debug/index.js';
import {
  showClarificationLoading,
  updateClarificationOptions,
  getClarificationResponse
} from './modules/clarification-ui.js';

// Notify background that panel is open
chrome.runtime.sendMessage({ action: 'panelOpened' });

// Notify background when panel is closing
window.addEventListener('unload', () => {
  chrome.runtime.sendMessage({ action: 'panelClosed' });
});

// Listen for clarification requests from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'showClarificationLoading') {
    showClarificationLoading(message.questions);
    getClarificationResponse().then(responses => {
      chrome.runtime.sendMessage({ action: 'clarificationResponse', responses });
    });
    return false; // Don't keep channel open - we send separate message for response
  }

  if (message.action === 'updateClarificationOptions') {
    updateClarificationOptions(message.config);
    return false;
  }

  if (message.action === 'closePanel') {
    // Request background to close panel via chrome.sidePanel.close() API
    chrome.runtime.sendMessage({ action: 'requestPanelClose' });
    return false;
  }
});

async function init() {
  await initUiSettings();
  const apiKeyValid = await initSettings();
  initChat(apiKeyValid);
  initDebug();
}

init();
