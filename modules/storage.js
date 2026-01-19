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
