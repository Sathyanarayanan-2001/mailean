// State validation, indexing, filtering, sorting and dashboard figures.
// Complexity: n conversations. Indexing O(n); filtering O(n); sorting
// O(n log n); dashboard figures O(n) plus O(k log k) for k senders.
// Lookups by id use Maps, never list scans.

import {
  GROUPS, GROUP_BY_KEY, cwKey, cwLabel, fyLabelFromStart, fyStartYearOfYmd, isoWeekMonday, isoWeekOfYmd, localParts,
} from './format.js';
import { ACCOUNT_RE, MESSAGE_ID_RE } from './commands.js';

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Check a state file from the agent and coerce every field to a known shape. */
export function validateState(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'The state file is not a JSON object.' };
  if (raw.enc) return { error: 'The state file is encrypted. Enter the passphrase in Settings.' };
  if (raw.schema !== 1 || raw.app !== 'mailean') return { error: 'This file is not a Mailean state file (schema 1).' };
  if (!Array.isArray(raw.messages)) return { error: 'The state file has no message list.' };
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
    .filter((a) => a && ACCOUNT_RE.test(a.id || ''))
    .map((a) => ({
      id: a.id, label: str(a.label, 40) || a.id, email: str(a.email, 254), fetched: Number(a.fetched) || 0,
      error: a.error ? str(a.error, 400) : null, synced_at: str(a.synced_at, 30),
    }));
  const accountIds = new Set(accounts.map((a) => a.id));
  const messages = [];
  let dropped = 0;
  const seen = new Set();
  for (const m of raw.messages) {
    const ok = m && ACCOUNT_RE.test(m.account || '') && MESSAGE_ID_RE.test(m.id || '') && GROUP_BY_KEY.has(m.group)
      && Number.isInteger(m.priority) && m.priority >= 1 && m.priority <= 5 && !Number.isNaN(Date.parse(m.date));
    const key = ok ? `${m.account}:${m.id}` : '';
    if (!ok || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    if (!accountIds.has(m.account)) {
      accounts.push({ id: m.account, label: m.account, email: '', fetched: 0, error: null, synced_at: '' });
      accountIds.add(m.account);
    }
    const ids = Array.isArray(m.message_ids) ? m.message_ids.filter((x) => MESSAGE_ID_RE.test(x)) : [];
    const amount = Number.isSafeInteger(m.amount_paise) && m.amount_paise >= 0 ? m.amount_paise : null;
    const unsub = m.unsubscribe && typeof m.unsubscribe === 'object'
      ? { one_click: !!m.unsubscribe.one_click, url: str(m.unsubscribe.url, 2000) || null, mailto: str(m.unsubscribe.mailto, 500) || null }
      : null;
    messages.push({
      key, id: m.id, thread_id: str(m.thread_id, 64), account: m.account,
      message_ids: ids.length ? ids : [m.id],
      sender_name: str(m.sender_name, 80) || '(unknown sender)', sender_email: str(m.sender_email, 254),
      subject: str(m.subject, 200) || '(no subject)', snippet: str(m.snippet, 300),
      date: new Date(Date.parse(m.date)).toISOString(), ts: Date.parse(m.date),
      unread: !!m.unread, starred: !!m.starred, unsubscribe: unsub,
      group: m.group, priority: m.priority, summary: str(m.summary, 160),
      suggested_action: str(m.suggested_action, 20) || 'none', suggested_label: str(m.suggested_label, 100) || null,
      amount_paise: amount, currency: amount === null ? null : str(m.currency, 8) || 'INR',
      reference: str(m.reference, 60) || null, suspicious: !!m.suspicious, source: str(m.source, 10),
      stale: !!m.stale,
      message_id_header: /^<[^<>\s]{3,250}@[^<>\s]{1,250}>$/.test(m.message_id_header || '') ? m.message_id_header : null,
      attachments: Number.isInteger(m.attachments) && m.attachments >= 0 ? m.attachments : null,
      has_body: !!m.has_body,
    });
    // Lower-cased copies computed once here (O(n)) instead of inside every
    // comparison and every keystroke of the search box.
    const row = messages[messages.length - 1];
    row.nameLc = row.sender_name.toLowerCase();
    row.haystack = `${row.subject}\u0000${row.sender_name}\u0000${row.sender_email}\u0000${row.summary}`.toLowerCase();
  }
  const cleanup = (Array.isArray(raw.cleanup) ? raw.cleanup : [])
    .filter((c) => c && ACCOUNT_RE.test(c.account || '') && typeof c.sender_email === 'string' && c.sender_email.includes('@'))
    .map((c) => ({
      account: c.account, sender_email: str(c.sender_email, 254), sender_name: str(c.sender_name, 80),
      count: Number(c.count) || 0, oldest: str(c.oldest, 30), newest: str(c.newest, 30),
      max_age_days: Number(c.max_age_days) || 0, group: GROUP_BY_KEY.has(c.group) ? c.group : 'promotions_spam',
      message_ids: Array.isArray(c.message_ids) ? c.message_ids.filter((x) => MESSAGE_ID_RE.test(x)) : [],
      unsubscribe: c.unsubscribe && typeof c.unsubscribe === 'object'
        ? { message_id: MESSAGE_ID_RE.test(c.unsubscribe.message_id || '') ? c.unsubscribe.message_id : null,
            one_click: !!c.unsubscribe.one_click, url: str(c.unsubscribe.url, 2000) || null, mailto: str(c.unsubscribe.mailto, 500) || null }
        : null,
    }));
  const audit = (Array.isArray(raw.audit) ? raw.audit : []).filter((a) => a && typeof a.batch_id === 'string').slice(0, 100);
  return {
    state: {
      generated_at: str(raw.generated_at, 30), demo: !!raw.demo, classifier: raw.classifier || {},
      bodies: { stored: !!(raw.bodies && raw.bodies.stored), encrypted: !!(raw.bodies && raw.bodies.encrypted) },
      accounts, messages, cleanup, audit,
    },
    dropped,
  };
}

/** Hash-map index: key -> row, account -> rows. O(n). */
export function indexState(state) {
  const byKey = new Map();
  const byAccount = new Map();
  const byMessageId = new Map();
  for (const m of state.messages) {
    byKey.set(m.key, m);
    if (!byAccount.has(m.account)) byAccount.set(m.account, []);
    byAccount.get(m.account).push(m);
    for (const id of m.message_ids) byMessageId.set(`${m.account}:${id}`, m);
  }
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  return { byKey, byAccount, byMessageId, accounts };
}

/** Filter. hidden is a Set of keys already acted on and waiting for a refresh. O(n). */
export function filterMessages(rows, { account = 'all', group = 'all', query = '', sinceTs = null, unreadOnly = false, hidden = null } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((m) => (account === 'all' || m.account === account)
    && (group === 'all' || m.group === group)
    && (!unreadOnly || m.unread)
    && (sinceTs === null || m.ts >= sinceTs)
    && (!hidden || !hidden.has(m.key))
    && (!q || (m.haystack || `${m.subject}\u0000${m.sender_name}\u0000${m.sender_email}\u0000${m.summary}`.toLowerCase()).includes(q)));
}

const byName = (a, b) => {
  const x = a.nameLc ?? a.sender_name.toLowerCase();
  const y = b.nameLc ?? b.sender_name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};
const byKeyCmp = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Stable sorts with explicit tie-breaks (then date, then name, then key). O(n log n). */
export const SORTS = {
  priority: (a, b) => b.priority - a.priority || b.ts - a.ts || byName(a, b) || byKeyCmp(a, b),
  newest: (a, b) => b.ts - a.ts || b.priority - a.priority || byName(a, b) || byKeyCmp(a, b),
  oldest: (a, b) => a.ts - b.ts || b.priority - a.priority || byName(a, b) || byKeyCmp(a, b),
  sender: (a, b) => byName(a, b) || b.ts - a.ts || byKeyCmp(a, b),
};
export function sortMessages(rows, mode = 'priority') {
  return [...rows].sort(SORTS[mode] || SORTS.priority);
}

/** Figures for the dashboard. Each is also recomputed independently in the tests. */
export function dashboardStats(rows, { timeZone, now = new Date(), weeks = 8 } = {}) {
  const byGroup = new Map(GROUPS.map((g) => [g.key, 0]));
  const byAccount = new Map();
  const byPriority = new Map([1, 2, 3, 4, 5].map((p) => [p, 0]));
  const weekCounts = new Map();
  const senders = new Map();
  const nowParts = localParts(now, timeZone);
  const fyStart = fyStartYearOfYmd(nowParts.y, nowParts.m);
  const receiptsByMonth = new Map();
  let unread = 0;
  let receiptsTotal = 0;
  let receiptsCount = 0;
  let suspicious = 0;
  for (const m of rows) {
    byGroup.set(m.group, (byGroup.get(m.group) || 0) + 1);
    byAccount.set(m.account, (byAccount.get(m.account) || 0) + 1);
    byPriority.set(m.priority, (byPriority.get(m.priority) || 0) + 1);
    if (m.unread) unread++;
    if (m.suspicious) suspicious++;
    const p = localParts(m.ts, timeZone);
    const wk = cwKey(isoWeekOfYmd(p.y, p.m, p.d));
    weekCounts.set(wk, (weekCounts.get(wk) || 0) + 1);
    const s = senders.get(m.sender_email || m.sender_name) || { name: m.sender_name, email: m.sender_email, count: 0 };
    s.count++;
    senders.set(m.sender_email || m.sender_name, s);
    if (m.group === 'receipts_finance' && m.amount_paise !== null && (m.currency || 'INR') === 'INR'
        && fyStartYearOfYmd(p.y, p.m) === fyStart) {
      receiptsTotal += m.amount_paise;
      receiptsCount++;
      const mk = `${p.y}-${String(p.m).padStart(2, '0')}`;
      receiptsByMonth.set(mk, (receiptsByMonth.get(mk) || 0) + m.amount_paise);
    }
  }
  // The last `weeks` ISO weeks ending with the current one, oldest first, zero-filled.
  const cur = isoWeekOfYmd(nowParts.y, nowParts.m, nowParts.d);
  const monday = isoWeekMonday(cur);
  const weekSeries = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(monday - i * 7 * 86_400_000);
    const w = isoWeekOfYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    weekSeries.push({ key: cwKey(w), label: cwLabel(w), year: w.year, value: weekCounts.get(cwKey(w)) || 0 });
  }
  // Financial-year months April..March, zero-filled up to the current month.
  const months = [];
  for (let i = 0; i < 12; i++) {
    const mm = ((3 + i) % 12) + 1;
    const yy = mm >= 4 ? fyStart : fyStart + 1;
    if (yy > nowParts.y || (yy === nowParts.y && mm > nowParts.m)) break;
    const key = `${yy}-${String(mm).padStart(2, '0')}`;
    months.push({ key, label: new Date(Date.UTC(yy, mm - 1, 1)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), value: receiptsByMonth.get(key) || 0 });
  }
  const topSenders = [...senders.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.email.localeCompare(b.email)).slice(0, 10);
  return {
    total: rows.length, unread, suspicious,
    actionRequired: byGroup.get('action_required') || 0,
    byGroup: GROUPS.map((g) => ({ key: g.key, label: g.name, slot: g.slot, value: byGroup.get(g.key) || 0 })),
    byAccount: [...byAccount.entries()].map(([k, v]) => ({ key: k, value: v })).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key)),
    byPriority: [5, 4, 3, 2, 1].map((p) => ({ key: String(p), label: `P${p}`, value: byPriority.get(p) })),
    weeks: weekSeries,
    fyLabel: fyLabelFromStart(fyStart), receiptsTotal, receiptsCount, receiptsByMonth: months,
    topSenders,
  };
}

/** Turn Claude's suggestions into staged commands (reply/none need a human). */
export function suggestionItems(rows) {
  const items = [];
  for (const m of rows) {
    const op = { archive: 'archive', mark_read: 'mark_read', move_to_label: 'move_to_label', delete: 'delete', star: 'star', unsubscribe: 'unsubscribe' }[m.suggested_action];
    if (!op || m.suspicious) continue; // never auto-stage anything for a suspicious email
    if (op === 'move_to_label' && !m.suggested_label) continue;
    if (op === 'unsubscribe' && !(m.unsubscribe && m.unsubscribe.one_click)) continue;
    items.push({ account: m.account, op, ids: op === 'unsubscribe' ? [m.id] : m.message_ids, label: op === 'move_to_label' ? m.suggested_label : undefined, keys: [m.key] });
  }
  return items;
}
