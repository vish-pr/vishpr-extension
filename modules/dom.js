// DOM Element References
export const elements = {
  chatContainer: document.getElementById('chatContainer'),
  messageInput: document.getElementById('messageInput'),
  sendButton: document.getElementById('sendButton'),
  settingsPanel: document.getElementById('settingsPanel'),
  settingsToggle: document.getElementById('settingsToggle'),
  headerTitle: document.getElementById('headerTitle'),
  extractButton: document.getElementById('extractButton'),
  historyToggle: document.getElementById('historyToggle'),
  extractionPanel: document.getElementById('extractionPanel'),
  currentTabContent: document.getElementById('currentTabContent'),
  currentTabExtractionContent: document.getElementById('currentTabExtractionContent'),
  historyTabContent: document.getElementById('historyTabContent'),
  actionsTabContent: document.getElementById('actionsTabContent'),
  extractionTabs: document.querySelectorAll('#extractionPanel [role="tablist"] .tab'),

  // Endpoints
  endpointsList: document.getElementById('endpointsList'),
  addEndpointBtn: document.getElementById('addEndpointBtn'),

  // Model configuration
  modelsBody: document.getElementById('modelsBody'),
  modelListHigh: document.getElementById('modelListHigh'),
  modelListMedium: document.getElementById('modelListMedium'),
  modelListLow: document.getElementById('modelListLow'),
  resetModelsBtn: document.getElementById('resetModelsBtn'),

  // Settings tabs
  settingsModelsTab: document.getElementById('settingsModelsTab'),
  settingsUiTab: document.getElementById('settingsUiTab'),

  // Model stats (in extraction panel)
  statsTabContent: document.getElementById('statsTabContent'),
  modelStatsContainer: document.getElementById('modelStatsContainer'),

  // UI settings
  themeSelector: document.getElementById('themeSelector'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  zoomLevel: document.getElementById('zoomLevel'),
  zoomSlider: document.getElementById('zoomSlider'),
  resetUiBtn: document.getElementById('resetUiBtn')
};
