// Content Extraction
import { elements } from './dom.js';
import { isSpecialPage, sleep } from './utils.js';
import { saveExtraction, logAction } from './storage.js';
import { addMessage } from './chat.js';
import { switchToTab, loadTabContent } from './history.js';
import { ContentAction } from './content-actions.js';

const EXTRACT_ICONS = {
  DEFAULT: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"></path></svg> Extract',
  LOADING: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg> Extracting...'
};

function setExtractButtonState(isLoading) {
  elements.extractButton.disabled = isLoading;
  elements.extractButton.innerHTML = isLoading ? EXTRACT_ICONS.LOADING : EXTRACT_ICONS.DEFAULT;
}

async function extractFromTab(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { action: ContentAction.EXTRACT_CONTENT });
  } catch (error) {
    // Content script not found, injecting
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await sleep(100);
    return await chrome.tabs.sendMessage(tab.id, { action: ContentAction.EXTRACT_CONTENT });
  }
}

async function performExtraction() {
  setExtractButtonState(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (isSpecialPage(tab.url)) {
      throw new Error('Cannot extract content from browser system pages. Please navigate to a regular webpage.');
    }

    const extraction = await extractFromTab(tab);
    extraction.timestamp = new Date().toISOString();
    extraction.tabTitle = tab.title;

    await saveExtraction(extraction);
    await logAction('extraction', `Extracted content from ${extraction.title}`);

    addMessage('system', `✓ Content extracted from: ${extraction.title}`);

    elements.extractionPanel.classList.remove('hidden');
    elements.historyToggle.classList.add('active');
    switchToTab('current');
    await loadTabContent('current');

  } catch (error) {
    addMessage('system', `✗ Extraction failed: ${error.message}`);
  } finally {
    setExtractButtonState(false);
  }
}

export function initExtraction() {
  elements.extractButton.addEventListener('click', performExtraction);
}
