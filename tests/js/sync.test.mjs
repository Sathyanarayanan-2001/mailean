// Folder sync with a fake folder: two devices, deletions, late files, pruning, write ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FolderSync, KEEP_OWN, SAVE_RE, gzip } from '../../docs/js/sync.js';
import { merge, isTombstone } from '../../docs/js/merge.js';

class MemStore {
  constructor() {
    this.records = {};
  }
  async mergeIn(r) {
    this.records = merge(this.records, r);
  }
  snapshot() {
    return { ...this.records };
  }
  live() {
    return Object.keys(this.records).filter((k) => !isTombstone(this.records[k])).sort();
  }
}

function folder() {
  const files = new Map();
  const notReady = new Set();
  return {
    files, notReady,
    async list() { return [...files.keys()]; },
    async read(n) {
      if (notReady.has(n)) throw new Error('file is still downloading');
      return files.get(n);
    },
    async write(n, b) { files.set(n, b); },
    async remove(n) { files.delete(n); },
  };
}

const noTimer = { setTimer: () => 1, clearTimer: () => {} };
let clock = Date.parse('2026-11-26T03:00:00Z');
const tick = () => new Date((clock += 1000));

test('two devices add at the same time and both end with both; deletion reaches the other', async () => {
  const dir = folder();
  const a = new MemStore();
  const b = new MemStore();
  const phone = new FolderSync(a, 'phone01', { now: tick, ...noTimer });
  const laptop = new FolderSync(b, 'laptop01', { now: tick, ...noTimer });
  a.records['q:1'] = { u: 100, v: 'archive' };
  b.records['q:2'] = { u: 100, v: 'delete' };
  await phone.attach(dir);
  await laptop.attach(dir);
  await phone.pull();
  assert.deepEqual(a.live(), ['q:1', 'q:2']);
  assert.deepEqual(b.live(), ['q:1', 'q:2']);
  b.records['q:1'] = { d: 1, u: 200 };
  laptop.changed();
  await laptop.flush();
  await phone.pull();
  assert.deepEqual(a.live(), ['q:2']);
  assert.equal(phone.status, 'saved');
});

test('a save file that is not ready is skipped, retried, and does not stop sync', async () => {
  const dir = folder();
  const other = new MemStore();
  other.records['l:News'] = { u: 5, v: 1 };
  const otherSync = new FolderSync(other, 'tablet01', { now: tick, ...noTimer });
  await otherSync.attach(dir);
  const name = [...dir.files.keys()][0];
  dir.notReady.add(name);
  const me = new MemStore();
  const sync = new FolderSync(me, 'phone02', { now: tick, ...noTimer });
  await sync.attach(dir);
  assert.equal(sync.skipped.size, 1);
  assert.notEqual(sync.status, 'error');
  assert.deepEqual(me.live(), []);
  dir.notReady.clear();
  await sync.pull();
  assert.deepEqual(me.live(), ['l:News']);
  assert.equal(sync.skipped.size, 0);
});

test('keeps the newest 3 save files per device and leaves other devices alone', async () => {
  const dir = folder();
  dir.files.set('mailean-save-otherdev1-20250101T000000-aaaa.json.gz', (await gzip('{"app":"mailean","records":{}}')).bytes);
  for (let i = 0; i < 5; i++) {
    const s = new FolderSync(new MemStore(), 'phone03', { now: tick, ...noTimer, rand: () => i / 10 });
    await s.attach(dir);
  }
  const mine = [...dir.files.keys()].filter((n) => SAVE_RE.exec(n)[1] === 'phone03');
  assert.equal(mine.length, KEEP_OWN);
  assert.ok(dir.files.has('mailean-save-otherdev1-20250101T000000-aaaa.json.gz'));
});

test('a pull waits for a write that is still running', async () => {
  const dir = folder();
  const order = [];
  const slow = { ...dir, async write(n, b) { order.push('write-start'); await new Promise((r) => setTimeout(r, 30)); dir.files.set(n, b); order.push('write-end'); }, async list() { order.push('list'); return [...dir.files.keys()]; } };
  const s = new FolderSync(new MemStore(), 'phone04', { now: tick, ...noTimer });
  s.dir = slow;
  s.dirty = true;
  const w = s.write();
  const p = s.pull();
  await Promise.all([w, p]);
  assert.ok(order.indexOf('write-end') < order.lastIndexOf('list'), order.join(','));
});

test('permission loss shows "Folder access needed"; other failures show "Sync problem"', async () => {
  const s = new FolderSync(new MemStore(), 'phone05', { now: tick, ...noTimer });
  const denied = { ...folder(), async list() { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; } };
  await s.attach(denied);
  assert.equal(s.status, 'access');
  const broken = { ...folder(), async write() { throw new Error('disk full'); } };
  await s.attach(broken);
  assert.equal(s.status, 'error');
  assert.match(s.detail, /disk full/);
});
