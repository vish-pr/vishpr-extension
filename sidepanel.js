// Vishpr Agent - Side Panel Entry Point
import { initSettings } from './modules/settings.js';
import { initUiSettings } from './modules/ui-settings.js';
import { initChat } from './modules/chat.js';
import { initExtraction } from './modules/extraction.js';
import { initHistory } from './modules/history.js';
import { initDebug } from './modules/debug.js';

async function init() {
  await initUiSettings();
  const apiKeyValid = await initSettings();
  initChat(apiKeyValid);
  initExtraction();
  initHistory();
  initDebug();
}

init();
