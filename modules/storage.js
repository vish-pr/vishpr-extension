// Chrome Storage Operations

export function get(keys) {
  return new Promise(resolve => {
    chrome.storage.local.get(keys, resolve);
  });
}

export function set(items) {
  return new Promise(resolve => {
    chrome.storage.local.set(items, resolve);
  });
}

export function remove(keys) {
  return new Promise(resolve => {
    chrome.storage.local.remove(keys, resolve);
  });
}

export async function saveExtraction(extraction) {
  const { extractions = {} } = await get(['extractions']);

  if (!extractions[extraction.url]) {
    extractions[extraction.url] = [];
  }

  extractions[extraction.url].unshift(extraction);
  extractions[extraction.url] = extractions[extraction.url].slice(0, 10);

  await set({ extractions });
}

export async function getExtractions() {
  const { extractions = {} } = await get(['extractions']);
  return extractions;
}

export async function getAllExtractions() {
  const extractions = await getExtractions();
  const all = [];

  for (const url in extractions) {
    all.push(...extractions[url]);
  }

  return all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export async function logAction(type, description) {
  const { actionHistory = [] } = await get(['actionHistory']);

  actionHistory.unshift({
    type,
    description,
    timestamp: new Date().toISOString()
  });

  await set({ actionHistory: actionHistory.slice(0, 100) });
}

export async function getActionHistory() {
  const { actionHistory = [] } = await get(['actionHistory']);
  return actionHistory;
}
