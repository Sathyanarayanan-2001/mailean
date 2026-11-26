// Staged commands: validation, grouping into payloads, and batch ids.
// Mirrors agent/commands.py so bad input is caught before it leaves the browser;
// the agent validates again because the browser is not trusted.

export const OPS = ['delete', 'archive', 'move_to_label', 'mark_read', 'star', 'bulk_trash_sender', 'unsubscribe'];
export const OP_LABELS = {
  delete: 'Trash', archive: 'Archive', move_to_label: 'Move to label', mark_read: 'Mark read',
  star: 'Star', bulk_trash_sender: 'Trash all from sender', unsubscribe: 'Unsubscribe',
};
export const DESTRUCTIVE = new Set(['delete', 'bulk_trash_sender', 'unsubscribe']);
export const ACCOUNT_RE = /^[a-z0-9_]{1,32}$/;
export const MESSAGE_ID_RE = /^[0-9A-Za-z]{6,64}$/;
const SYSTEM_LABELS = new Set(['inbox', 'spam', 'trash', 'unread', 'starred', 'important', 'sent', 'draft', 'chat']);
export const LIMITS = { payloadChars: 60000, commands: 200, ids: 5000, unsubscribe: 50 };

export function validateLabel(raw) {
  const label = String(raw ?? '').trim();
  if (!label) return { error: 'Type a label name, like Receipts or Finance/Receipts.' };
  if (label.length > 100) return { error: 'Label names can be at most 100 characters.' };
  if (/[\u0000-\u001f\u007f]/.test(label)) return { error: 'Label names cannot contain control characters.' };
  if (SYSTEM_LABELS.has(label.toLowerCase()) || /^category_/i.test(label)) {
    return { error: `"${label}" is a Gmail system label. Choose your own name.` };
  }
  if (label.includes('//') || label.startsWith('/') || label.endsWith('/')) {
    return { error: 'Nested labels use single slashes, like Finance/Receipts.' };
  }
  return { label };
}

/** Validate one staged item; returns an error message or null. */
export function itemError(item, accountIds) {
  if (!item || typeof item !== 'object') return 'Not a command.';
  if (!ACCOUNT_RE.test(item.account || '') || !accountIds.has(item.account)) return `Unknown account "${item.account}".`;
  if (!OPS.includes(item.op)) return `Unknown action "${item.op}".`;
  if (item.op === 'bulk_trash_sender') {
    return /^[^\s@"]+@[^\s@"]+\.[a-z]{2,24}$/i.test(item.sender || '') ? null : 'A valid sender address is needed.';
  }
  if (!Array.isArray(item.ids) || !item.ids.length) return 'No messages selected.';
  if (!item.ids.every((i) => MESSAGE_ID_RE.test(i))) return 'A message id is malformed.';
  if (item.op === 'move_to_label') return validateLabel(item.label).error || null;
  return null;
}

/** "b-20261126-031400-k3x9q2" from a UTC time and random suffix. */
export function newBatchId(now = new Date(), rand = Math.random) {
  const iso = now.toISOString();
  const stamp = iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '');
  let suffix = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(rand() * alphabet.length)];
  return `b-${stamp}-${suffix}`;
}

/**
 * Merge staged items that share (account, op, label|sender) and split the result
 * into payloads that respect the workflow input limit. O(m log m) for m ids.
 */
export function buildPayloads(items, makeBatchId = () => newBatchId()) {
  const groups = new Map();
  for (const it of items) {
    const key = [it.account, it.op, it.label || '', it.sender || ''].join('\u0000');
    let g = groups.get(key);
    if (!g) {
      g = { account: it.account, op: it.op, label: it.label, sender: it.sender, ids: new Set() };
      groups.set(key, g);
    }
    for (const id of it.ids || []) g.ids.add(id);
  }
  // Order so that non-destructive actions run first and trash runs last.
  const rank = (op) => ['star', 'mark_read', 'move_to_label', 'archive', 'unsubscribe', 'delete', 'bulk_trash_sender'].indexOf(op);
  const cmds = [];
  for (const g of [...groups.values()].sort((a, b) => rank(a.op) - rank(b.op) || a.account.localeCompare(b.account))) {
    if (g.op === 'bulk_trash_sender') {
      cmds.push({ account: g.account, op: g.op, sender: g.sender });
      continue;
    }
    const ids = [...g.ids].sort();
    const chunk = g.op === 'unsubscribe' ? LIMITS.unsubscribe : 1000;
    for (let i = 0; i < ids.length; i += chunk) {
      const c = { account: g.account, op: g.op, ids: ids.slice(i, i + chunk) };
      if (g.op === 'move_to_label') c.label = g.label;
      cmds.push(c);
    }
  }
  const payloads = [];
  let cur = [];
  let idCount = 0;
  const flush = () => {
    if (!cur.length) return;
    payloads.push({ v: 1, batch_id: makeBatchId(payloads.length), commands: cur });
    cur = [];
    idCount = 0;
  };
  const size = (list) => JSON.stringify({ v: 1, batch_id: 'b-00000000-000000-xxxxxxxxxxxx', commands: list }).length;
  for (const c of cmds) {
    const n = c.ids ? c.ids.length : 0;
    if (cur.length && (cur.length + 1 > LIMITS.commands || idCount + n > LIMITS.ids || size([...cur, c]) > LIMITS.payloadChars)) flush();
    // A single command that is itself too large is split by halving its ids.
    if (c.ids && size([c]) > LIMITS.payloadChars) {
      const half = Math.ceil(c.ids.length / 2);
      cmds.splice(cmds.indexOf(c) + 1, 0, { ...c, ids: c.ids.slice(half) });
      c.ids = c.ids.slice(0, half);
    }
    cur.push(c);
    idCount += c.ids ? c.ids.length : 0;
  }
  flush();
  return payloads;
}

/** Counts per op across staged items, for the confirmation summary. */
export function summarise(items) {
  const out = {};
  for (const it of items) {
    const n = it.op === 'bulk_trash_sender' ? 1 : (it.ids || []).length;
    out[it.op] = (out[it.op] || 0) + n;
  }
  return out;
}
