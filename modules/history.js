// History Management
import { elements } from './dom.js';
import { getExtractions, getAllExtractions, getActionHistory } from './storage.js';
import { renderExtractionItem, renderExtractionDetail, renderActionHistoryItem, renderNoData } from './renderer.js';

const TABS = {
  CURRENT: 'current',
  HISTORY: 'history',
  ACTIONS: 'actions'
};

export function switchToTab(tabName) {
  elements.extractionTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
}

function showTabContent(tabName) {
  elements.currentTabContent.style.display = tabName === TABS.CURRENT ? 'block' : 'none';
  elements.historyTabContent.style.display = tabName === TABS.HISTORY ? 'block' : 'none';
  elements.actionsTabContent.style.display = tabName === TABS.ACTIONS ? 'block' : 'none';
}

async function loadCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const extractions = await getExtractions();
  const pageExtractions = extractions[tab.url] || [];

  if (pageExtractions.length === 0) {
    elements.currentTabExtractionContent.innerHTML = renderNoData('No extractions yet for this page.<br>Click "Extract Content" to get started.');
    return;
  }

  elements.currentTabExtractionContent.innerHTML = renderExtractionDetail(pageExtractions[0]);
}

async function loadHistory() {
  const allExtractions = await getAllExtractions();

  if (allExtractions.length === 0) {
    elements.historyTabContent.innerHTML = renderNoData('No extraction history yet.');
    return;
  }

  elements.historyTabContent.innerHTML = allExtractions.map(renderExtractionItem).join('');
  attachHistoryItemListeners();
}

async function loadActions() {
  const history = await getActionHistory();

  if (history.length === 0) {
    elements.actionsTabContent.innerHTML = renderNoData('No actions logged yet.');
    return;
  }

  elements.actionsTabContent.innerHTML = history.map(renderActionHistoryItem).join('');
}

export async function loadTabContent(tabName) {
  showTabContent(tabName);

  switch (tabName) {
    case TABS.CURRENT:
      await loadCurrentPage();
      break;
    case TABS.HISTORY:
      await loadHistory();
      break;
    case TABS.ACTIONS:
      await loadActions();
      break;
  }
}

async function showExtractionDetail(url, timestamp) {
  const extractions = await getExtractions();
  const extraction = extractions[url]?.find(e => e.timestamp === timestamp);

  if (extraction) {
    switchToTab(TABS.CURRENT);
    elements.currentTabExtractionContent.innerHTML = renderExtractionDetail(extraction);
    showTabContent(TABS.CURRENT);
  }
}

function attachHistoryItemListeners() {
  elements.historyTabContent.querySelectorAll('.extraction-item').forEach(item => {
    item.addEventListener('click', () => {
      showExtractionDetail(item.dataset.url, item.dataset.timestamp);
    });
  });
}

function setupHistoryToggle() {
  elements.historyToggle.addEventListener('click', async () => {
    const isHidden = elements.extractionPanel.classList.contains('hidden');
    elements.extractionPanel.classList.toggle('hidden');
    elements.historyToggle.classList.toggle('active');

    if (isHidden) {
      const activeTab = document.querySelector('.extraction-tab.active').dataset.tab;
      await loadTabContent(activeTab);
    }
  });
}

function setupTabSwitching() {
  elements.extractionTabs.forEach(tab => {
    tab.addEventListener('click', async () => {
      switchToTab(tab.dataset.tab);
      await loadTabContent(tab.dataset.tab);
    });
  });
}

export function initHistory() {
  setupHistoryToggle();
  setupTabSwitching();
}
