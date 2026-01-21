// Vishpr Agent - Side Panel Entry Point
import { initSettings } from './modules/settings.js';
import { initUiSettings } from './modules/ui-settings.js';
import { initChat } from './modules/chat.js';
import { initDebug } from './modules/debug/index.js';
import {
  showClarification,
  showClarificationLoading,
  updateClarificationOptions,
  getClarificationResponse
} from './modules/clarification-ui.js';

// Listen for clarification requests from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'showClarification') {
    showClarification(message.config).then(responses => {
      chrome.runtime.sendMessage({ action: 'clarificationResponse', responses });
    });
    return true;
  }

  if (message.action === 'showClarificationLoading') {
    showClarificationLoading(message.questions);
    getClarificationResponse().then(responses => {
      chrome.runtime.sendMessage({ action: 'clarificationResponse', responses });
    });
    return true;
  }

  if (message.action === 'updateClarificationOptions') {
    updateClarificationOptions(message.config);
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
