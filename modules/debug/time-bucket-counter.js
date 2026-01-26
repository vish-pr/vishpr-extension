/**
 * Simple Stats Counter - stores exact timestamps with limits:
 * - Maximum 10,000 entries per counter
 * - Maximum 30 days retention
 * Whichever limit is reached first triggers cleanup.
 */

const MAX_ENTRIES = 10000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class StatsCounter {
  constructor(storageKey, storage = null) {
    this.storageKey = storageKey;
    this.storage = storage;
    this.data = {};
    this.loaded = false;
  }

  async load(reload = false) {
    if (this.loaded && !reload) return;
    if (this.storage) this.data = (await this.storage.get([this.storageKey]))[this.storageKey] || {};
    this.loaded = true;
  }

  async increment(key, counter = 'count', amount = 1) {
    await this.load();
    const timestamp = Date.now();

    this.data[key] ??= {};
    this.data[key][counter] ??= [];
    this.data[key][counter].push([timestamp, amount]);

    // Prune when over limit: remove old entries, then cap at MAX_ENTRIES
    if (this.data[key][counter].length > MAX_ENTRIES) {
      const cutoff = Date.now() - RETENTION_MS;
      let pruned = this.data[key][counter].filter(e => e[0] >= cutoff);
      if (pruned.length > MAX_ENTRIES) {
        pruned.sort((a, b) => b[0] - a[0]);
        pruned = pruned.slice(0, MAX_ENTRIES);
      }
      this.data[key][counter] = pruned;
    }

    if (this.storage) await this.storage.set({ [this.storageKey]: this.data });
  }

  async getStats(key, since = 0) {
    await this.load();
    if (!this.data[key]) return null;

    const stats = {};
    for (const [type, entries] of Object.entries(this.data[key])) {
      if (!Array.isArray(entries)) continue;
      stats[type] = {
        total: entries.filter(([ts]) => ts >= since).reduce((sum, [, amount]) => sum + amount, 0)
      };
    }

    return stats;
  }

  /** Get raw entries for a key/counter, returns [[timestamp, amount], ...] sorted by timestamp desc */
  async getEntries(key, counter) {
    await this.load();
    const entries = this.data[key]?.[counter];
    if (!Array.isArray(entries)) return [];
    return [...entries].sort((a, b) => b[0] - a[0]);
  }

  async getAllStats(since = 0) {
    await this.load();
    const result = {};
    for (const key of Object.keys(this.data)) {
      result[key] = await this.getStats(key, since);
    }
    return result;
  }
}

let modelStatsCounter = null;

export function modelStatsKey(endpoint, model, openrouterProvider) {
  return `${endpoint}:${model}:${openrouterProvider || ''}`;
}

export function providerStatsKey(endpoint) {
  return `provider:${endpoint.split(':')[0]}`;
}

export function getModelStatsCounter() {
  // Use new storage key to start fresh with exact timestamp format
  return modelStatsCounter ??= new StatsCounter('modelStatsV4', {
    get: keys => chrome.storage.local.get(keys),
    set: items => chrome.storage.local.set(items)
  });
}

let actionStatsCounter = null;

export function getActionStatsCounter() {
  // Use new storage key to start fresh with exact timestamp format
  return actionStatsCounter ??= new StatsCounter('actionStatsV4', {
    get: keys => chrome.storage.local.get(keys),
    set: items => chrome.storage.local.set(items)
  });
}
