// VishPro Agent - Side Panel Entry Point
import { initSettings } from './modules/settings.js';
import { initChat } from './modules/chat.js';
import { initExtraction } from './modules/extraction.js';
import { initHistory } from './modules/history.js';

async function init() {
  const apiKeyValid = await initSettings();
  initChat(apiKeyValid);
  initExtraction();
  initHistory();
}

init();
