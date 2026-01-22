// DOM Element References (lazy getters - cached on first access)

function lazy(id) {
  let cached;
  return () => cached ??= document.getElementById(id);
}

function lazyQuery(selector) {
  let cached;
  return () => cached ??= document.querySelector(selector);
}

export const elements = {
  // Chat
  get chatContainer() { return lazy('chatContainer')(); },
  get messageInput() { return lazy('messageInput')(); },
  get sendButton() { return lazy('sendButton')(); },

  // Header
  get headerTitle() { return lazy('headerTitle')(); },
  get statusDot() { return lazy('statusDot')(); },
  get statusText() { return lazy('statusText')(); },

  // Settings panel
  get settingsPanel() { return lazy('settingsPanel')(); },
  get settingsToggle() { return lazy('settingsToggle')(); },
  get settingsModelsTab() { return lazy('settingsModelsTab')(); },
  get settingsUiTab() { return lazy('settingsUiTab')(); },

  // Endpoints
  get endpointsList() { return lazy('endpointsList')(); },
  get addEndpointBtn() { return lazy('addEndpointBtn')(); },

  // Model configuration
  get modelsBody() { return lazy('modelsBody')(); },
  get modelListHigh() { return lazy('modelListHigh')(); },
  get modelListMedium() { return lazy('modelListMedium')(); },
  get modelListLow() { return lazy('modelListLow')(); },
  get resetModelsBtn() { return lazy('resetModelsBtn')(); },

  // UI settings
  get themeSelector() { return lazy('themeSelector')(); },
  get openPositionSettings() { return lazy('openPositionSettings')(); },
  get zoomIn() { return lazy('zoomIn')(); },
  get zoomOut() { return lazy('zoomOut')(); },
  get zoomLevel() { return lazy('zoomLevel')(); },
  get zoomSlider() { return lazy('zoomSlider')(); },
  get resetUiBtn() { return lazy('resetUiBtn')(); },

  // Debug panel
  get debugToggle() { return lazy('debugToggle')(); },
  get debugContainer() { return lazy('debugContainer')(); },
  get debugHistory() { return lazy('debugHistory')(); },
  get debugClearBtn() { return lazy('debugClearBtn')(); },
  get debugTimeline() { return lazy('debugTimeline')(); },
  get debugTiming() { return lazy('debugTiming')(); },
  get debugCritiqueBadge() { return lazy('debugCritiqueBadge')(); },
  get debugRefreshBtn() { return lazy('debugRefreshBtn')(); },
  get debugTraceTab() { return lazy('debugTraceTab')(); },
  get debugStatsTab() { return lazy('debugStatsTab')(); },
  get debugStatsRefreshBtn() { return lazy('debugStatsRefreshBtn')(); },
  get debugStateTab() { return lazy('debugStateTab')(); },
  get debugStateContent() { return lazy('debugStateContent')(); },
  get debugStateRefreshBtn() { return lazy('debugStateRefreshBtn')(); },

  // Stats (in debug panel)
  get modelStatsContainer() { return lazy('modelStatsContainer')(); },
  get actionStatsContainer() { return lazy('actionStatsContainer')(); },

  // Clarification overlay
  get clarificationOverlay() { return lazy('clarificationOverlay')(); },

  // Input area (class selector)
  get inputArea() { return lazyQuery('.bg-base-200.border-t')(); },

  // Templates
  get tplEndpointItem() { return lazy('tpl-endpoint-item')(); },
  get tplEndpointEditing() { return lazy('tpl-endpoint-editing')(); },
  get tplModelItem() { return lazy('tpl-model-item')(); },
  get tplModelEditing() { return lazy('tpl-model-editing')(); },
  get tplStatsCard() { return lazy('tpl-stats-card')(); },
  get tplStatsSummary() { return lazy('tpl-stats-summary')(); },
  get tplActionCard() { return lazy('tpl-action-card')(); },
  get tplChoiceBar() { return lazy('tpl-choice-bar')(); },
  get tplAnomalyBadge() { return lazy('tpl-anomaly-badge')(); },
  get tplSkipRow() { return lazy('tpl-skip-row')(); },
  get tplClarificationOption() { return lazy('tpl-clarification-option')(); },
};
