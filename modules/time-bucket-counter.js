/**
 * Time-Bucketed Counter with Multi-Tier Aggregation
 * Tiers: minute (60 buckets), hour (24 buckets), day (30 buckets)
 */

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const TIERS = { minute: { duration: MINUTE, retention: 60 }, hour: { duration: HOUR, retention: 24 }, day: { duration: DAY, retention: 30 } };

const getBucketTs = (time, duration) => Math.floor(time / duration) * duration;

export class TimeBucketCounter {
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

  async save() {
    if (this.storage) await this.storage.set({ [this.storageKey]: this.data });
  }

  async increment(key, counter = 'count', amount = 1) {
    await this.load();
    const now = Date.now();
    this.data[key] ??= {};
    this.data[key][counter] ??= { minute: [], hour: [], day: [] };

    const buckets = this.data[key][counter];
    const ts = getBucketTs(now, MINUTE);
    let bucket = buckets.minute.find(b => b.ts === ts);
    if (!bucket) buckets.minute.push(bucket = { ts, count: 0 });
    bucket.count += amount;

    this._aggregate(buckets, now);
    await this.save();
  }

  _aggregate(buckets, now) {
    const rollUp = (src, dest, srcTier, destTier) => {
      const cutoff = now - TIERS[srcTier].retention * TIERS[srcTier].duration;
      for (const b of buckets[src].filter(b => b.ts < cutoff)) {
        const ts = getBucketTs(b.ts, TIERS[destTier].duration);
        let target = buckets[dest].find(d => d.ts === ts);
        if (!target) buckets[dest].push(target = { ts, count: 0 });
        target.count += b.count;
      }
      buckets[src] = buckets[src].filter(b => b.ts >= cutoff).sort((a, b) => a.ts - b.ts);
    };

    rollUp('minute', 'hour', 'minute', 'hour');
    rollUp('hour', 'day', 'hour', 'day');
    const monthCutoff = now - TIERS.day.retention * DAY;
    buckets.day = buckets.day.filter(b => b.ts >= monthCutoff).sort((a, b) => a.ts - b.ts);
  }

  _sumBuckets(buckets, since) {
    return ['minute', 'hour', 'day'].reduce((sum, tier) =>
      sum + buckets[tier].filter(b => b.ts >= since).reduce((s, b) => s + b.count, 0), 0);
  }

  async getStats(key) {
    await this.load();
    if (!this.data[key]) return null;

    const now = Date.now();
    return Object.fromEntries(Object.entries(this.data[key]).map(([counter, buckets]) => [counter, {
      total: this._sumBuckets(buckets, 0),
      lastHour: this._sumBuckets(buckets, now - HOUR),
      lastDay: this._sumBuckets(buckets, now - DAY),
      buckets: { minute: buckets.minute.length, hour: buckets.hour.length, day: buckets.day.length }
    }]));
  }

  async getAllStats() {
    await this.load();
    return Object.fromEntries(await Promise.all(Object.keys(this.data).map(async key => [key, await this.getStats(key)])));
  }

  async reset(key = null, types = null) {
    await this.load();
    if (key && types?.length) {
      // Reset specific counter types for a key
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

let modelStatsCounter = null;

export function modelStatsKey(endpoint, model, openrouterProvider) {
  return `${endpoint}:${model}:${openrouterProvider || ''}`;
}

export function getModelStatsCounter() {
  return modelStatsCounter ??= new TimeBucketCounter('modelStatsV2', {
    get: keys => chrome.storage.local.get(keys),
    set: items => chrome.storage.local.set(items)
  });
}
