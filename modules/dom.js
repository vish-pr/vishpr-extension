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
  extractionTabs: document.querySelectorAll('.extraction-tab'),

  // Provider settings
  providerSelect: document.getElementById('providerSelect'),
  geminiSettings: document.getElementById('geminiSettings'),
  openrouterSettings: document.getElementById('openrouterSettings'),

  // Gemini settings
  geminiApiKey: document.getElementById('geminiApiKey'),
  geminiApiKeyStatus: document.getElementById('geminiApiKeyStatus'),

  // OpenRouter settings
  openrouterApiKey: document.getElementById('openrouterApiKey'),
  openrouterApiKeyStatus: document.getElementById('openrouterApiKeyStatus'),

  // Intelligence level
  intelligenceSelect: document.getElementById('intelligenceSelect')
};
