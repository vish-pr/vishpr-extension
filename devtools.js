// Create Vishpr Debug panel in Chrome DevTools
chrome.devtools.panels.create(
  'Vishpr Debug',
  'icons/icon16.png',
  'devtools-panel.html',
  (panel) => {
    console.log('Vishpr Debug panel created');
  }
);
