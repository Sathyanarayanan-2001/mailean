// Local storage on the device: IndexedDB for the cached state, the sync folder
// handle and the synced records; localStorage for tiny settings.
// Every key and database name carries the "mailean" prefix because all
// projects on one github.io account share a browser origin.

import { merge, tombstone, isTombstone } from './merge.js';

export const LS_PREFIX = 'mailean:';
const DB_NAME = 'mailean';
const DB_VERSION = 1;

export const ls = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false; // private mode or quota: the caller keeps working from memory
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(LS_PREFIX + key);
    } catch { /* nothing to do */ }
  },
};

export const session = {
  get(key) {
    try {
      return sessionStorage.getItem(LS_PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(LS_PREFIX + key, value);
    } catch { /* memory only */ }
  },
  remove(key) {
    try {
      sessionStorage.removeItem(LS_PREFIX + key);
    } catch { /* nothing */ }
  },
};

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const memory = new Map(); // fallback when IndexedDB is blocked

export async function kvGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return memory.get(key);
  }
}

export async function kvSet(key, value) {
  memory.set(key, value);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function kvDelete(key) {
  memory.delete(key);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* already gone */ }
}

/** Delete every key that starts with prefix, except those in keep (used for cached email texts). */
export async function kvDeletePrefix(prefix, keep = null) {
  const drop = (k) => String(k).startsWith(prefix) && !(keep && keep.has(k));
  for (const k of [...memory.keys()]) if (drop(k)) memory.delete(k);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req = store.openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (drop(c.key)) store.delete(c.key);
        c.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* nothing cached */ }
}

/**
 * Synced records: queue items (q:), saved labels (l:), handled marks (h:),
 * batch history (b:). Each record is {u, v} or a tombstone {d:1, u}.
 */
export class RecordStore {
  constructor() {
    this.records = Object.create(null);
    this.listeners = new Set();
  }

  async load() {
    this.records = merge({}, (await kvGet('records')) || {});
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async persist(source) {
    await kvSet('records', this.records);
    for (const fn of this.listeners) fn(source);
  }

  /** Update time that always moves forward, even if this device's clock is behind. */
  nextU(key) {
    const prev = this.records[key];
    return Math.max(Date.now(), prev ? prev.u + 1 : 0);
  }

  get(key) {
    const r = this.records[key];
    return r && !isTombstone(r) ? r.v : undefined;
  }

  entries(prefix) {
    return Object.entries(this.records).filter(([k, r]) => k.startsWith(prefix) && !isTombstone(r)).map(([k, r]) => [k, r.v]);
  }

  async put(key, value) {
    this.records[key] = { u: this.nextU(key), v: value };
    await this.persist('local');
  }

  async putMany(pairs) {
    for (const [key, value] of pairs) this.records[key] = { u: this.nextU(key), v: value };
    await this.persist('local');
  }

  async remove(keys) {
    for (const key of [].concat(keys)) if (this.records[key]) this.records[key] = tombstone(this.nextU(key));
    await this.persist('local');
  }

  /** Merge records from another device or a backup file. */
  async mergeIn(incoming, source = 'sync') {
    const before = JSON.stringify(this.records);
    this.records = merge(this.records, incoming);
    if (JSON.stringify(this.records) !== before) await this.persist(source);
  }

  snapshot() {
    return { ...this.records };
  }
}
