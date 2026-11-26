// Folder sync between devices through a OneDrive (or any synced) folder.
// Each browser session writes one gzip JSON save file and keeps its device's
// newest 3. Every other save file is read and merged per record (see merge.js).
// A file that cannot be read yet (OneDrive still downloading it) is skipped and
// retried on the next pull; it never stops sync.

export const SAVE_RE = /^mailean-save-([a-z0-9]{6,16})-(\d{8}T\d{6})-([a-z0-9]{4})\.json(\.gz)?$/;
export const KEEP_OWN = 3;
export const WRITE_DELAY_MS = 3000;
export const PULL_EVERY_MS = 60000;

export const STATUS_TEXT = {
  saved: 'Saved',
  saving: 'Saving…',
  waiting: 'Changes waiting',
  access: 'Folder access needed',
  error: 'Sync problem',
  local: 'Saved on this device',
};

export async function gzip(text) {
  if (typeof CompressionStream === 'undefined') return { bytes: new TextEncoder().encode(text), gz: false };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), gz: true };
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Adapter over a FileSystemDirectoryHandle so the engine can be tested with a fake folder. */
export function directoryAdapter(handle) {
  return {
    async list() {
      const names = [];
      for await (const [name, entry] of handle.entries()) if (entry.kind === 'file') names.push(name);
      return names;
    },
    async read(name) {
      const file = await (await handle.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async write(name, bytes) {
      const fh = await handle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
    },
    async remove(name) {
      await handle.removeEntry(name);
    },
  };
}

function stamp(d) {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '');
}

export class FolderSync {
  /**
   * store: RecordStore. deviceId: [a-z0-9]{6,16}. Options let tests control time.
   */
  constructor(store, deviceId, { now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, rand = Math.random } = {}) {
    this.store = store;
    this.deviceId = deviceId;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    const suffix = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)]).join('');
    this.sessionFile = `mailean-save-${deviceId}-${stamp(now())}-${suffix}.json.gz`;
    this.dir = null;
    this.status = 'local';
    this.detail = '';
    this.listeners = new Set();
    this.chain = Promise.resolve(); // serialises pulls and writes
    this.timer = null;
    this.dirty = false;
    this.skipped = new Set();
    this.lastSaved = null;
  }

  onStatus(fn) {
    this.listeners.add(fn);
    fn(this.status, this.detail);
    return () => this.listeners.delete(fn);
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    for (const fn of this.listeners) fn(status, detail);
  }

  /** Queue work so a pull always waits for a write that is still running, and vice versa. */
  enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  attach(adapter) {
    this.dir = adapter;
    return this.syncNow();
  }

  detach(status = 'access', detail = '') {
    this.dir = null;
    this.setStatus(status, detail);
  }

  /** Called after every local change: write about 3 s later, coalescing bursts. */
  changed() {
    this.dirty = true;
    if (!this.dir) return;
    this.setStatus('waiting');
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.write();
    }, WRITE_DELAY_MS);
  }

  /** On page hide: write now. Never rely on the page's last moments for this. */
  flush() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    return this.dirty ? this.write() : Promise.resolve();
  }

  syncNow() {
    return this.pull().then(() => this.write(true));
  }

  pull() {
    return this.enqueue(async () => {
      if (!this.dir) return { merged: 0, skipped: 0 };
      let names;
      try {
        names = await this.dir.list();
      } catch (err) {
        this.handleError(err);
        return { merged: 0, skipped: 0 };
      }
      let merged = 0;
      const skipped = new Set();
      for (const name of names.sort()) {
        if (name === this.sessionFile || !SAVE_RE.test(name)) continue;
        try {
          const bytes = await this.dir.read(name);
          const text = name.endsWith('.gz') ? await gunzip(bytes) : new TextDecoder().decode(bytes);
          const data = JSON.parse(text);
          if (data.app !== 'mailean' || typeof data.records !== 'object') throw new Error('not a Mailean save file');
          await this.store.mergeIn(data.records, 'sync');
          merged++;
        } catch {
          skipped.add(name); // probably still downloading; try again next time
        }
      }
      this.skipped = skipped;
      if (this.status === 'error' || this.status === 'access') this.setStatus(this.dirty ? 'waiting' : 'saved');
      return { merged, skipped: skipped.size };
    });
  }

  write(force = false) {
    return this.enqueue(async () => {
      if (!this.dir || (!this.dirty && !force)) return false;
      this.setStatus('saving');
      this.dirty = false;
      try {
        const payload = JSON.stringify({ app: 'mailean', schema: 1, device: this.deviceId, saved_at: this.now().toISOString(), records: this.store.snapshot() });
        const { bytes, gz } = await gzip(payload);
        const name = gz ? this.sessionFile : this.sessionFile.replace(/\.gz$/, '');
        await this.dir.write(name, bytes);
        await this.prune();
        this.lastSaved = this.now();
        this.setStatus(this.dirty ? 'waiting' : 'saved', this.skipped.size ? `${this.skipped.size} file(s) not ready yet` : '');
        return true;
      } catch (err) {
        this.dirty = true;
        this.handleError(err);
        return false;
      }
    });
  }

  /** Keep this device's newest 3 save files; other devices prune their own. */
  async prune() {
    const names = (await this.dir.list()).filter((n) => {
      const m = SAVE_RE.exec(n);
      return m && m[1] === this.deviceId;
    });
    names.sort((a, b) => (SAVE_RE.exec(b)[2] + b).localeCompare(SAVE_RE.exec(a)[2] + a));
    for (const old of names.slice(KEEP_OWN)) {
      try {
        await this.dir.remove(old);
      } catch { /* another app may hold it open; next prune retries */ }
    }
  }

  handleError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      this.setStatus('access', 'Allow access to the sync folder again.');
    } else {
      this.setStatus('error', `${err && err.message ? err.message : err}`.slice(0, 160));
    }
  }
}
