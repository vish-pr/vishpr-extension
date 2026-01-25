/**
 * Simple Stats Counter - stores daily counts for last 30 days
 * Much simpler than the previous tiered bucket approach
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

/** Get date key like "2024-01-25" from timestamp */
const getDateKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

export class StatsCounter {
  constructor(storageKey, storage = null) {
    this.storageKey = storageKey;
    this.storage = storage;
    this.data = {};
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    if (this.storage) this.data = (await this.storage.get([this.storageKey]))[this.storageKey] || {};
    this.loaded = true;
  }

  async reload() {
    this.loaded = false;
    await this.load();
  }

  async save() {
    if (this.storage) await this.storage.set({ [this.storageKey]: this.data });
  }

  /** Prune entries older than 30 days */
  _prune(counters) {
    const cutoffDate = getDateKey(Date.now() - RETENTION_DAYS * DAY_MS);
    for (const [type, daily] of Object.entries(counters)) {
      if (typeof daily !== 'object') continue;
      for (const date of Object.keys(daily)) {
        if (date < cutoffDate) delete daily[date];
      }
    }
  }

  async increment(key, counter = 'count', amount = 1) {
    await this.load();
    const dateKey = getDateKey();

    this.data[key] ??= {};
    this.data[key][counter] ??= {};
    this.data[key][counter][dateKey] = (this.data[key][counter][dateKey] || 0) + amount;

    // Prune old data periodically (when we have > 35 days)
    if (Object.keys(this.data[key][counter]).length > 35) {
      this._prune(this.data[key]);
    }

    await this.save();
  }

  /** Sum counts from a counter object, optionally filtered by time */
  _sumCounts(daily, since = 0) {
    if (!daily || typeof daily !== 'object') return 0;
    const sinceDate = since > 0 ? getDateKey(since) : '';
    return Object.entries(daily)
      .filter(([date]) => date >= sinceDate)
      .reduce((sum, [, count]) => sum + count, 0);
  }

  /** Get the most recent date with activity */
  _getLastActivity(counters) {
    let latest = '';
    for (const [type, daily] of Object.entries(counters)) {
      if (typeof daily !== 'object') continue;
      for (const date of Object.keys(daily)) {
        if (date > latest) latest = date;
      }
    }
    // Convert date string back to timestamp (end of that day for safety)
    return latest ? new Date(latest + 'T23:59:59Z').getTime() : 0;
  }

  async getStats(key, since = 0) {
    await this.load();
    if (!this.data[key]) return null;

    const counters = this.data[key];
    const stats = {};

    for (const [type, daily] of Object.entries(counters)) {
      if (typeof daily !== 'object') continue;
      stats[type] = { total: this._sumCounts(daily, since) };
    }

    stats._lastActivity = this._getLastActivity(counters);
    return stats;
  }

  async getAllStats(since = 0) {
    await this.load();
    const result = {};
    for (const key of Object.keys(this.data)) {
      result[key] = await this.getStats(key, since);
    }
    return result;
  }

  async reset(key = null, types = null) {
    await this.load();
    if (key && types?.length) {
      if (this.data[key]) {
        for (const type of types) delete this.data[key][type];
        if (!Object.keys(this.data[key]).length) delete this.data[key];
      }
    } else if (key) {
      delete this.data[key];
    } else {
      this.data = {};
    }
    await this.save();
  }
}

// Keep the old class name as alias for compatibility
export { StatsCounter as TimeBucketCounter };

let modelStatsCounter = null;

export function modelStatsKey(endpoint, model, openrouterProvider) {
  return `${endpoint}:${model}:${openrouterProvider || ''}`;
}

export function providerStatsKey(endpoint) {
  return `provider:${endpoint.split(':')[0]}`;
}

export function getModelStatsCounter() {
  // Use new storage key to start fresh with simplified format
  return modelStatsCounter ??= new StatsCounter('modelStatsV3', {
    get: keys => chrome.storage.local.get(keys),
    set: items => chrome.storage.local.set(items)
  });
}

let actionStatsCounter = null;

export function getActionStatsCounter() {
  // Use new storage key to start fresh with simplified format
  return actionStatsCounter ??= new StatsCounter('actionStatsV3', {
    get: keys => chrome.storage.local.get(keys),
    set: items => chrome.storage.local.set(items)
  });
}
