// Mailean dashboard. Static page: reads the private state file through the
// GitHub API with the owner's token, and sends queued actions to the agent
// by starting a GitHub Actions workflow. No other servers, no analytics.

import { h, clear, append, $, icon, ICONS, dataTable } from './js/dom.js';
import {
  GROUPS, GROUP_BY_KEY, formatRupees, formatRupeesCompact, formatCount, formatDate, formatDateTime, formatWhen, formatInr, fyLabel,
  isoWeek, cwLabel, deviceTimeZone, localParts, parseDayFirst, zonedMidnight, plural, safeUrl,
} from './js/format.js';
import { validateState, indexState, filterMessages, sortMessages, dashboardStats, suggestionItems } from './js/model.js';
import { OP_LABELS, DESTRUCTIVE, buildPayloads, itemError, summarise, validateLabel, newBatchId } from './js/commands.js';
import { ls, session, kvGet, kvSet, kvDelete, kvDeletePrefix, RecordStore } from './js/store.js';
import { FolderSync, directoryAdapter, STATUS_TEXT } from './js/sync.js';
import { GitHub, GitHubError, validateConnection, COMMANDS_WORKFLOW } from './js/github.js';
import { decryptState, decryptBytes, isEncrypted, forgetKeys } from './js/crypto.js';
import { chartCard } from './js/charts.js';
import { exportInboxCsv } from './js/exporter.js';
import { buildImportPreview } from './js/csv.js';
import { liveEntries } from './js/merge.js';

export const VERSION = '1.1.0';
export const RELEASE_DATE = '28/11/2026';
const PAGE = 100; // rows rendered at a time keeps the DOM light on phones
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = {
  conn: null, demo: false, gh: null,
  state: null, index: null, etag: null, fetchedAt: null, loading: false, loadError: null, dropped: 0,
  tz: ls.get('tz') || deviceTimeZone(),
  f: { account: 'all', group: 'all', query: '', sort: 'priority', unreadOnly: false, since: '', sinceTs: null, sinceError: '' },
  selected: new Set(), limit: PAGE,
  records: new RecordStore(), sync: null,
  exec: { running: false, steps: [], error: '' },
  importPreview: null, cleanupDays: 0,
  route: 'home',
};

// ------------------------------------------------------------------ helpers

const groupName = (k) => (GROUP_BY_KEY.get(k) || { name: k }).name;
const accountLabel = (id) => (S.index && S.index.accounts.get(id) ? S.index.accounts.get(id).label : id);
const when = (iso) => formatWhen(new Date(iso), new Date(), S.tz);

function toast(message, kind = 'info', ms = 5000) {
  const region = $('#toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? ICONS.alert : ICONS.check), h('span', { text: message }),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon(ICONS.close)));
  region.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
}

/** Modal dialog. Returns a promise resolving to the clicked button's value. */
function dialog({ title, body, actions = [{ label: 'Close', value: null }], wide = false }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    clear(dlg);
    dlg.className = wide ? 'wide' : '';
    const close = (v) => {
      dlg.close();
      resolve(v);
    };
    const form = h('form', { method: 'dialog', class: 'dlg-inner', onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title', text: title }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(null) }, icon(ICONS.close))),
      h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-actions' }, actions.map((a) => h('button', {
        type: a.submit ? 'submit' : 'button', class: `btn ${a.kind || ''}`, text: a.label,
        onclick: async () => {
          if (a.validate && !(await a.validate())) return;
          close(a.value);
        },
      }))));
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.append(form);
    dlg.onclose = () => resolve(null);
    dlg.showModal();
    const first = dlg.querySelector('input, select, textarea') || dlg.querySelector('.dlg-actions .btn:last-child');
    if (first) first.focus();
  });
}

function field(label, input, { hint = '', error = '', id } = {}) {
  const fid = id || input.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  input.id = fid;
  const hintId = `${fid}-hint`;
  const errId = `${fid}-err`;
  input.setAttribute('aria-describedby', [hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || null);
  if (error) input.setAttribute('aria-invalid', 'true');
  return h('div', { class: 'field' }, h('label', { for: fid, text: label }), input,
    hint ? h('p', { class: 'hint', id: hintId, text: hint }) : null,
    h('p', { class: 'error-text', id: errId, role: 'alert', text: error, hidden: !error }));
}

function setFieldError(input, message) {
  const err = document.getElementById(`${input.id}-err`);
  if (err) {
    err.textContent = message;
    err.hidden = !message;
  }
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function groupBadge(key) {
  const g = GROUP_BY_KEY.get(key);
  return h('span', { class: 'badge' }, h('span', { class: `key series-${g ? g.slot : 'single'}`, 'aria-hidden': 'true' }), g ? g.short : key);
}

function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', { text: title }), h('p', { class: 'muted', text }), action || null);
}

// ------------------------------------------------------------------ records (queue, handled, batches, labels)

const queueEntries = () => S.records.entries('q:');
const handledKeys = () => new Set(S.records.entries('h:').map(([k]) => k.slice(2)));
const queuedOpFor = (key) => S.records.get(`q:${key}`);

async function stage(items) {
  // One pending action per conversation: a newer choice replaces the older one.
  const pairs = [];
  for (const it of items) {
    const recKey = it.op === 'bulk_trash_sender' ? `q:sender:${it.account}:${it.sender}` : `q:${it.keys[0]}`;
    pairs.push([recKey, { account: it.account, op: it.op, ids: it.ids || [], label: it.label || null, sender: it.sender || null, keys: it.keys || [], at: Date.now() }]);
  }
  await S.records.putMany(pairs);
  if (items.some((i) => i.op === 'move_to_label' && i.label)) {
    await S.records.putMany(items.filter((i) => i.label).map((i) => [`l:${i.label}`, { used: Date.now() }]));
  }
}

function stageRows(rows, op, label) {
  return stage(rows.map((m) => ({ account: m.account, op, ids: op === 'unsubscribe' ? [m.id] : m.message_ids, label, keys: [m.key] })))
    .then(() => toast(`${OP_LABELS[op]}: ${plural(rows.length, 'conversation')} added to the queue.`));
}

function savedLabels() {
  const fromRecords = S.records.entries('l:').map(([k]) => k.slice(2));
  const fromState = S.state ? S.state.messages.map((m) => m.suggested_label).filter(Boolean) : [];
  return [...new Set([...fromRecords, ...fromState, 'Receipts', 'Newsletters'])].sort((a, b) => a.localeCompare(b));
}

async function pruneHandled() {
  // Once a fresh state from the agent arrives, it is the truth: drop old "handled" marks.
  if (!S.state || !S.state.generated_at) return;
  const gen = Date.parse(S.state.generated_at);
  const stale = S.records.entries('h:').filter(([, v]) => v.at < gen).map(([k]) => k);
  if (stale.length) await S.records.remove(stale);
}

// ------------------------------------------------------------------ connection and state

function loadConnection() {
  const remembered = ls.get('conn');
  const sess = session.get('conn');
  const conn = remembered || (sess ? JSON.parse(sess) : null);
  if (conn && conn.repo && conn.token) {
    S.conn = conn;
    S.gh = new GitHub(conn.repo, conn.token);
  }
  S.demo = !S.conn && ls.get('demo') === true;
}

async function setState(raw, { fromCache = false } = {}) {
  let data = raw;
  if (isEncrypted(raw)) {
    const pass = session.get('passphrase');
    if (!pass) {
      S.loadError = 'Your state file is encrypted. Enter the passphrase in Settings to read it.';
      S.state = null;
      return false;
    }
    try {
      data = await decryptState(raw, pass);
    } catch (err) {
      S.loadError = err.message;
      return false;
    }
  }
  const res = validateState(data);
  if (res.error) {
    S.loadError = res.error;
    return false;
  }
  S.state = res.state;
  S.dropped = res.dropped;
  S.index = indexState(S.state);
  S.loadError = null;
  if (!fromCache) {
    await pruneHandled();
    // Keep cached email texts only for emails still in the inbox.
    if (!S.demo) await forgetBodies(new Set(S.state.messages.flatMap((m) => m.message_ids.map((id) => `body:${m.account}:${id}`))));
  }
  return true;
}

async function loadCached() {
  const cached = await kvGet('state');
  if (!cached || !cached.text) return;
  const owner = S.demo ? 'demo' : S.conn && S.conn.repo;
  if (cached.owner !== owner) return;
  S.etag = cached.etag || null;
  S.fetchedAt = cached.fetchedAt || null;
  try {
    await setState(JSON.parse(cached.text), { fromCache: true });
  } catch {
    S.loadError = 'The saved copy of your inbox could not be read. Refresh to fetch it again.';
  }
}

async function refresh({ quiet = false } = {}) {
  if (S.loading) return;
  if (!S.conn && !S.demo) return;
  S.loading = true;
  renderChrome();
  try {
    let text;
    if (S.demo) {
      const res = await fetch('demo-state.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`The demo data could not be loaded (HTTP ${res.status}).`);
      text = await res.text();
    } else {
      const res = await S.gh.getStateFile('inbox.json', S.state ? S.etag : null);
      if (res.status === 304) {
        S.fetchedAt = new Date().toISOString();
        if (!quiet) toast('Already up to date.');
        return;
      }
      text = res.text;
      S.etag = res.etag;
    }
    S.fetchedAt = new Date().toISOString();
    const ok = await setState(JSON.parse(text));
    if (ok) await kvSet('state', { owner: S.demo ? 'demo' : S.conn.repo, text, etag: S.etag, fetchedAt: S.fetchedAt });
    if (!quiet && ok) toast('Inbox refreshed.');
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404 && !S.state) {
      S.loadError = 'No inbox data yet. The first sync has not finished. Open Activity and press "Run sync now", then wait about two minutes.';
    } else {
      S.loadError = err.message || String(err);
      if (!quiet) toast(S.loadError, 'error', 9000);
    }
  } finally {
    S.loading = false;
    render();
  }
}

// ------------------------------------------------------------------ routing and chrome

const ROUTES = [
  { id: 'home', label: 'Home', icon: ICONS.home },
  { id: 'inbox', label: 'Inbox', icon: ICONS.inbox },
  { id: 'dashboard', label: 'Dashboard', icon: ICONS.chart },
  { id: 'cleanup', label: 'Cleanup', icon: ICONS.broom },
  { id: 'activity', label: 'Activity', icon: ICONS.activity },
  { id: 'data', label: 'Import & export', icon: ICONS.data },
  { id: 'settings', label: 'Settings', icon: ICONS.settings },
  { id: 'guide', label: 'Guide', icon: ICONS.guide },
];
const PHONE_TABS = ['home', 'inbox', 'dashboard'];

function routeFromHash() {
  const id = location.hash.replace(/^#\/?/, '').split('?')[0] || 'home';
  return ROUTES.some((r) => r.id === id) || id === 'connect' ? id : 'home';
}

function go(id) {
  if (location.hash !== `#/${id}`) location.hash = `#/${id}`;
  else render();
}

function renderNav() {
  const side = $('#sidenav-list');
  clear(side);
  for (const r of ROUTES) {
    side.append(h('li', {}, h('a', { href: `#/${r.id}`, class: 'nav-link', 'aria-current': S.route === r.id ? 'page' : null }, icon(r.icon), h('span', { text: r.label }))));
  }
  const bottom = $('#bottomnav-list');
  clear(bottom);
  for (const id of PHONE_TABS) {
    const r = ROUTES.find((x) => x.id === id);
    bottom.append(h('li', {}, h('a', { href: `#/${id}`, class: 'tab', 'aria-current': S.route === id ? 'page' : null }, icon(r.icon), h('span', { text: r.label }))));
  }
  const qn = queueEntries().length;
  bottom.append(h('li', {}, h('button', { type: 'button', class: 'tab', onclick: openQueue, 'aria-label': `Queue, ${qn} item${qn === 1 ? '' : 's'}` },
    h('span', { class: 'tab-icon' }, icon(ICONS.queue), qn ? h('span', { class: 'count', text: qn > 99 ? '99+' : String(qn) }) : null), h('span', { text: 'Queue' }))));
  const moreActive = !PHONE_TABS.includes(S.route);
  bottom.append(h('li', {}, h('button', { type: 'button', class: 'tab', 'aria-current': moreActive ? 'page' : null, onclick: openMore }, icon(ICONS.more), h('span', { text: 'More' }))));
}

function openMore() {
  const list = h('ul', { class: 'more-list' }, ROUTES.filter((r) => !PHONE_TABS.includes(r.id)).map((r) => h('li', {},
    h('a', { href: `#/${r.id}`, class: 'more-link', onclick: () => $('#dlg').close() }, icon(r.icon), h('span', { text: r.label })))));
  dialog({ title: 'More', body: list });
}

function renderChrome() {
  const qn = queueEntries().length;
  const qb = $('#queue-btn');
  clear(qb);
  append(qb, [icon(ICONS.queue), h('span', { text: 'Queue' }), h('span', { class: 'count', text: String(qn), hidden: !qn })]);
  qb.setAttribute('aria-label', `Command queue, ${qn} item${qn === 1 ? '' : 's'}`);
  const pill = $('#sync-pill');
  const st = S.sync ? S.sync.status : 'local';
  pill.dataset.status = st;
  pill.textContent = S.loading ? 'Loading…' : STATUS_TEXT[st] || st;
  pill.title = S.sync && S.sync.detail ? S.sync.detail : 'Sync state of your queue and labels across devices';
  const mode = $('#mode-chip');
  mode.hidden = !S.demo;
  const theme = ls.get('theme') || 'system';
  const tb = $('#theme-btn');
  clear(tb);
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  tb.append(icon(dark ? ICONS.sun : ICONS.moon));
  tb.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  renderNav();
}

function render() {
  S.route = routeFromHash();
  const needsConnect = !S.conn && !S.demo && !['guide', 'settings'].includes(S.route);
  const view = $('#view');
  clear(view);
  renderChrome();
  if (needsConnect || S.route === 'connect') {
    view.append(viewConnect());
    document.title = 'Connect · Mailean';
    return;
  }
  const fn = { home: viewHome, inbox: viewInbox, dashboard: viewDashboard, cleanup: viewCleanup, activity: viewActivity, data: viewData, settings: viewSettings, guide: viewGuide }[S.route];
  view.append(fn());
  const r = ROUTES.find((x) => x.id === S.route);
  document.title = `${r ? r.label : 'Mailean'} · Mailean`;
}

function stateBanner() {
  const parts = [];
  if (S.loadError) parts.push(h('div', { class: 'banner warn', role: 'alert' }, icon(ICONS.alert), h('p', { text: S.loadError })));
  if (S.state) {
    for (const a of S.state.accounts.filter((x) => x.error)) {
      parts.push(h('div', { class: 'banner warn', role: 'alert' }, icon(ICONS.alert),
        h('p', {}, h('strong', { text: `${a.label}: ` }), a.error, ' Rows from this account may be out of date.')));
    }
    if (S.dropped) parts.push(h('div', { class: 'banner', role: 'status' }, icon(ICONS.alert), h('p', { text: `${S.dropped} row(s) in the state file were malformed and were skipped.` })));
  }
  return parts;
}

// ------------------------------------------------------------------ connect view

function viewConnect() {
  const repo = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'owner/gmail-command-center', value: S.conn ? S.conn.repo : '' });
  const token = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…' });
  const remember = h('input', { type: 'checkbox', checked: true, id: 'remember' });
  const status = h('p', { class: 'muted small', role: 'status' });
  const submit = h('button', { type: 'submit', class: 'btn primary', text: 'Connect' });
  const form = h('form', {
    class: 'card stack', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const v = validateConnection(repo.value, token.value);
      setFieldError(repo, v.errors.repo || '');
      setFieldError(token, v.errors.token || '');
      if (v.errors.repo || v.errors.token) return;
      submit.disabled = true;
      status.textContent = 'Checking the repository…';
      try {
        const gh = new GitHub(v.repo, v.token);
        await gh.verifyRepo();
        S.conn = { repo: v.repo, token: v.token };
        S.gh = gh;
        S.demo = false;
        ls.set('demo', false);
        if (remember.checked) ls.set('conn', S.conn);
        else {
          ls.remove('conn');
          session.set('conn', JSON.stringify(S.conn));
        }
        S.state = null;
        S.etag = null;
        await forgetBodies();
        toast('Connected. Loading your inbox…');
        go('home');
        refresh({ quiet: true });
      } catch (err) {
        status.textContent = '';
        setFieldError(err.status === 401 || err.status === 403 ? token : repo, err.message);
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('h2', { text: 'Connect your private repository' }),
  h('p', { class: 'muted', text: 'Mailean reads your triaged inbox from your own private GitHub repository. Your token stays in this browser and is sent only to api.github.com.' }),
  field('Repository', repo, { hint: 'The private data repository, as owner/name.' }),
  field('Fine-grained token', token, { hint: 'Repository access: only this repository. Permissions: Contents read; Actions read and write.' }),
  h('div', { class: 'check' }, remember, h('label', { for: 'remember', text: 'Remember on this device' })),
  h('p', { class: 'hint', text: 'Untick on a shared computer: the token is then forgotten when you close the tab.' }),
  h('div', { class: 'row' }, submit, h('a', { href: '#/guide', class: 'btn ghost', text: 'How to set this up' })),
  status);
  const demo = h('div', { class: 'card stack' },
    h('h2', { text: 'Just looking?' }),
    h('p', { class: 'muted', text: 'Try Mailean with a made-up inbox of 128 conversations. Nothing leaves this browser.' }),
    h('div', {}, h('button', {
      type: 'button', class: 'btn', text: 'Try the demo',
      onclick: async () => {
        S.demo = true;
        ls.set('demo', true);
        S.state = null;
        go('home');
        await refresh({ quiet: true });
      },
    })));
  return h('div', { class: 'page narrow' },
    h('header', { class: 'page-head' }, h('h1', { text: 'Inbox zero, minus the busywork.' }),
      h('p', { class: 'lead', text: 'Mailean sorts every Gmail account you own into six clear groups and lets you act on hundreds of emails at once.' })),
    form, demo);
}

// ------------------------------------------------------------------ home view

function viewHome() {
  const page = h('div', { class: 'page' });
  page.append(h('header', { class: 'page-head' },
    h('h1', { text: 'Inbox zero, minus the busywork.' }),
    h('p', { class: 'lead', text: 'Mailean groups your Gmail accounts into six buckets with Claude, then applies your choices back to Gmail through a GitHub Actions agent.' })));
  append(page, stateBanner());
  if (!S.state) {
    page.append(emptyState(S.loading ? 'Loading your inbox…' : 'No inbox data yet',
      S.loading ? 'This takes a few seconds.' : 'Press Refresh to fetch the latest triage, or open the Guide to finish setup.',
      h('button', { type: 'button', class: 'btn primary', text: 'Refresh', onclick: () => refresh() })));
    page.append(linkGrid());
    return page;
  }
  const hidden = handledKeys();
  const rows = S.state.messages.filter((m) => !hidden.has(m.key));
  const queued = new Set(queueEntries().flatMap(([, v]) => v.keys));
  const suggestions = suggestionItems(rows.filter((m) => !queued.has(m.key)));
  const counts = summarise(suggestions);
  const stats = dashboardStats(rows, { timeZone: S.tz });
  const gen = S.state.generated_at ? formatDateTime(new Date(S.state.generated_at), S.tz) : 'unknown';
  page.append(h('p', { class: 'muted small' }, `Last triage ${gen} · ${plural(S.state.accounts.length, 'account')} · `,
    h('span', { text: S.demo ? 'Demo data' : (S.fetchedAt ? `checked ${when(S.fetchedAt)}` : 'not checked yet') })));
  const primary = h('section', { class: 'card hero', 'aria-labelledby': 'hero-title' },
    h('div', {},
      h('h2', { id: 'hero-title', text: suggestions.length ? `${plural(suggestions.length, 'suggested action')} ready` : 'Nothing to suggest right now' }),
      h('p', { class: 'muted', text: suggestions.length
        ? Object.entries(counts).map(([op, n]) => `${OP_LABELS[op]} ${formatCount(n)}`).join(' · ') + '. Review them in the queue, then execute.'
        : 'Claude found no safe bulk actions. Open the Inbox to act on emails one by one.' })),
    h('div', { class: 'row' },
      h('button', {
        type: 'button', class: 'btn primary lg', disabled: !suggestions.length,
        onclick: async () => {
          await stage(suggestions);
          openQueue();
        },
      }, icon(ICONS.queue), `Stage ${formatCount(suggestions.length)} suggestions`),
      h('a', { href: '#/inbox', class: 'btn ghost', text: 'Review inbox' })));
  page.append(primary);
  page.append(h('div', { class: 'tiles' },
    tile('Unread', formatCount(stats.unread), `of ${formatCount(stats.total)} conversations`, () => { S.f.unreadOnly = true; go('inbox'); }),
    tile('Action required', formatCount(stats.actionRequired), 'need a reply or decision', () => { S.f.group = 'action_required'; go('inbox'); }),
    tile('In the queue', formatCount(queueEntries().length), 'waiting to execute', openQueue),
    tile(`Receipts ${stats.fyLabel}`, formatRupees(stats.receiptsTotal), plural(stats.receiptsCount, 'receipt'), () => { S.f.group = 'receipts_finance'; go('inbox'); })));
  page.append(linkGrid());
  return page;
}

function tile(label, value, sub, onclick) {
  return h('button', { type: 'button', class: 'tile', onclick },
    h('span', { class: 'tile-label', text: label }), h('span', { class: 'tile-value', text: value }), h('span', { class: 'tile-sub', text: sub }));
}

function linkGrid() {
  const notes = {
    inbox: 'Filter by account and group; act on one or many.', dashboard: 'Charts and tables of what is in your inbox.',
    cleanup: 'Senders worth unsubscribing from or clearing out.', activity: 'What the agent did, run by run.',
    data: 'CSV export for Excel; import actions back.', settings: 'Connection, theme, folder sync, privacy.', guide: 'How it works, step by step.',
  };
  return h('nav', { class: 'link-grid', 'aria-label': 'All sections' }, ROUTES.filter((r) => r.id !== 'home').map((r) =>
    h('a', { href: `#/${r.id}`, class: 'link-card' }, icon(r.icon), h('span', { class: 'link-title', text: r.label }), h('span', { class: 'muted small', text: notes[r.id] }))));
}

// ------------------------------------------------------------------ inbox view

function currentRows() {
  if (!S.state) return [];
  const hidden = handledKeys();
  return sortMessages(filterMessages(S.state.messages, { ...S.f, hidden }), S.f.sort);
}

function viewInbox() {
  const page = h('div', { class: 'page' });
  page.append(h('header', { class: 'page-head row-between' }, h('h1', { text: 'Inbox' }),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => refresh(), disabled: S.loading }, icon(ICONS.refresh), 'Refresh')));
  append(page, stateBanner());
  if (!S.state) {
    page.append(emptyState('No inbox data yet', 'Press Refresh to fetch the latest triage.'));
    return page;
  }
  const accounts = S.state.accounts;
  const acct = h('select', { onchange: (e) => { S.f.account = e.target.value; S.selected.clear(); S.limit = PAGE; render(); } },
    h('option', { value: 'all', text: 'All accounts', selected: S.f.account === 'all' }),
    accounts.map((a) => h('option', { value: a.id, text: a.label, selected: S.f.account === a.id })));
  const search = h('input', { type: 'search', placeholder: 'Sender, subject or summary', value: S.f.query, enterkeyhint: 'search' });
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.f.query = search.value; S.limit = PAGE; renderList(); }, 200);
  });
  const sort = h('select', { onchange: (e) => { S.f.sort = e.target.value; renderList(); } },
    [['priority', 'Priority'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['sender', 'Sender A to Z']]
      .map(([v, t]) => h('option', { value: v, text: t, selected: S.f.sort === v })));
  const since = h('input', { type: 'text', inputmode: 'numeric', placeholder: '28/10', value: S.f.since, autocomplete: 'off', maxlength: '10' });
  since.addEventListener('change', () => {
    const v = since.value.trim();
    S.f.since = v;
    if (!v) {
      S.f.sinceTs = null;
      setFieldError(since, '');
    } else {
      const digits = /^\d{4}$/.test(v) ? `${v.slice(0, 2)}/${v.slice(2)}` : /^\d{8}$/.test(v) ? `${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4)}` : v;
      const p = parseDayFirst(digits, localParts(new Date(), S.tz));
      if (p.error) {
        setFieldError(since, p.error);
        return;
      }
      setFieldError(since, '');
      S.f.sinceTs = zonedMidnight(p, S.tz);
    }
    S.limit = PAGE;
    renderList();
  });
  const unread = h('input', { type: 'checkbox', id: 'f-unread', checked: S.f.unreadOnly, onchange: (e) => { S.f.unreadOnly = e.target.checked; renderList(); } });
  // On phones the less-used filters fold away so the list starts near the top.
  const groupSel = h('select', { class: 'group-select', onchange: (e) => { S.f.group = e.target.value; S.selected.clear(); S.limit = PAGE; renderList(); } });
  const activeExtra = S.f.sort !== 'priority' || S.f.since || S.f.unreadOnly;
  page.append(h('div', { class: 'filters' },
    field('Account', acct), field('Search', search),
    h('div', { class: 'field group-field' }, h('label', { for: 'f-group', text: 'Group' }), Object.assign(groupSel, { id: 'f-group' })),
    h('details', { class: 'filter-more', open: window.innerWidth > 600 || activeExtra },
      h('summary', { text: 'More filters' }),
      h('div', { class: 'filter-more-body' }, field('Sort by', sort),
        field('Received since', since, { hint: 'Day first, like 28/10' }),
        h('div', { class: 'check filter-check' }, unread, h('label', { for: 'f-unread', text: 'Unread only' }))))));
  const chips = h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Groups' });
  page.append(chips);
  const bulk = h('div', { class: 'bulkbar', role: 'region', 'aria-label': 'Selected conversations' });
  page.append(bulk);
  const list = h('ul', { class: 'mail-list', 'aria-label': 'Conversations' });
  page.append(h('div', { class: 'list-head', 'aria-hidden': 'true' }, h('span', {}), h('span', { text: 'From' }), h('span', { text: 'Subject and summary' }), h('span', { text: 'Group' }), h('span', { text: 'Date' }), h('span', { text: 'Actions' })));
  page.append(list);
  const more = h('div', { class: 'more-row' });
  page.append(more);

  function renderChips(allRows) {
    clear(chips);
    const counts = new Map(GROUPS.map((g) => [g.key, 0]));
    for (const m of allRows) counts.set(m.group, counts.get(m.group) + 1);
    const mk = (key, label, n, slot) => h('button', {
      type: 'button', role: 'tab', class: 'chip', 'aria-selected': String(S.f.group === key),
      onclick: () => { S.f.group = key; S.selected.clear(); S.limit = PAGE; renderList(); },
    }, slot ? h('span', { class: `key series-${slot}`, 'aria-hidden': 'true' }) : null, `${label} `, h('span', { class: 'chip-n num', text: formatCount(n) }));
    chips.append(mk('all', 'All', allRows.length));
    for (const g of GROUPS) chips.append(mk(g.key, g.name, counts.get(g.key), g.slot));
    clear(groupSel);
    groupSel.append(h('option', { value: 'all', text: `All groups (${formatCount(allRows.length)})`, selected: S.f.group === 'all' }),
      GROUPS.map((g) => h('option', { value: g.key, text: `${g.name} (${formatCount(counts.get(g.key))})`, selected: S.f.group === g.key })));
  }

  function renderBulk(rows) {
    clear(bulk);
    const sel = rows.filter((m) => S.selected.has(m.key));
    const all = h('input', { type: 'checkbox', id: 'sel-all', 'aria-label': 'Select all shown', checked: sel.length > 0 && sel.length === Math.min(rows.length, S.limit) });
    all.indeterminate = sel.length > 0 && !all.checked;
    all.addEventListener('change', () => {
      if (all.checked) rows.slice(0, S.limit).forEach((m) => S.selected.add(m.key));
      else S.selected.clear();
      renderList();
    });
    const act = (op, ic, label) => h('button', { type: 'button', class: 'btn sm', disabled: !sel.length, onclick: () => bulkAction(op, sel) }, icon(ic), label);
    bulk.classList.toggle('has-selection', sel.length > 0);
    bulk.append(h('div', { class: 'check' }, all, h('label', { for: 'sel-all', text: sel.length ? `${sel.length} selected` : `Select all ${Math.min(rows.length, S.limit)} shown` })),
      h('div', { class: 'bulk-actions', hidden: !sel.length },
        act('archive', ICONS.archive, 'Archive'), act('delete', ICONS.trash, 'Trash'), act('move_to_label', ICONS.label, 'Move'),
        act('mark_read', ICONS.read, 'Read'), act('star', ICONS.star, 'Star'),
        h('button', { type: 'button', class: 'btn sm ghost', disabled: !sel.length, onclick: () => {
          const items = suggestionItems(sel);
          if (!items.length) return toast('No safe suggestions for the selected conversations.');
          stage(items).then(() => { toast(`${plural(items.length, 'suggestion')} added to the queue.`); S.selected.clear(); renderList(); });
        } }, 'Use suggestions')));
  }

  function renderList() {
    const hidden = handledKeys();
    const base = filterMessages(S.state.messages, { ...S.f, group: 'all', hidden });
    renderChips(base);
    const rows = sortMessages(S.f.group === 'all' ? base : base.filter((m) => m.group === S.f.group), S.f.sort);
    renderBulk(rows);
    clear(list);
    clear(more);
    if (!rows.length) {
      list.append(h('li', { class: 'empty-row' }, emptyState(
        S.f.query || S.f.unreadOnly || S.f.sinceTs ? 'No matches' : 'This group is empty',
        S.f.query || S.f.unreadOnly || S.f.sinceTs ? 'Clear the search or filters to see more conversations.' : 'Nothing waiting here. Pick another group above.')));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const m of rows.slice(0, S.limit)) frag.append(mailRow(m));
    list.append(frag);
    if (rows.length > S.limit) {
      more.append(h('button', { type: 'button', class: 'btn', onclick: () => { S.limit += PAGE; renderList(); } }, `Show ${Math.min(PAGE, rows.length - S.limit)} more of ${formatCount(rows.length - S.limit)}`));
    }
  }

  // One listener for the whole list instead of one per button: cheaper on phones.
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    const m = S.index.byKey.get(btn.closest('li').dataset.key);
    if (m && btn.dataset.op === 'read') openReader(m, currentRows());
    else if (m) rowAction(btn.dataset.op, m, btn.dataset.label);
  });
  list.addEventListener('change', (e) => {
    if (!e.target.matches('input.row-check')) return;
    const key = e.target.closest('li').dataset.key;
    if (e.target.checked) S.selected.add(key);
    else S.selected.delete(key);
    renderBulk(currentRows());
  });
  renderList();
  return page;
}

function mailRow(m) {
  const queued = queuedOpFor(m.key);
  const sug = m.suggested_action;
  const sugOp = { archive: 'archive', mark_read: 'mark_read', move_to_label: 'move_to_label', delete: 'delete', star: 'star', unsubscribe: 'unsubscribe' }[sug];
  const qa = (op, ic, label) => h('button', { type: 'button', class: 'icon-btn', 'data-op': op, 'aria-label': `${label}: ${m.subject}`, title: label }, icon(ic));
  const cb = h('input', { type: 'checkbox', class: 'row-check', 'aria-label': `Select ${m.subject}`, checked: S.selected.has(m.key) });
  return h('li', { class: `mail${m.unread ? ' unread' : ''}`, dataset: { key: m.key } },
    h('div', { class: 'cell-check' }, cb),
    h('div', { class: 'cell-from' },
      h('span', { class: 'from-name', text: m.sender_name }),
      h('span', { class: 'from-addr muted small', text: m.sender_email }),
      S.state.accounts.length > 1 ? h('span', { class: 'acct-tag small', text: accountLabel(m.account) }) : null),
    h('div', { class: 'cell-subject' },
      h('button', { type: 'button', class: 'subject', 'data-op': 'read', title: 'Read this email' }, m.subject || '(no subject)'),
      m.message_ids.length > 1 ? h('span', { class: 'muted small', text: ` (${m.message_ids.length})` }) : null,
      // Rule-based summaries just repeat the subject; show a summary only when it adds something.
      m.summary && m.summary !== m.subject && m.summary !== `${m.sender_name}: ${m.subject}` ? h('p', { class: 'summary muted', text: m.summary }) : null,
      h('div', { class: 'tags' },
        m.suspicious ? h('span', { class: 'tag danger', title: 'This email contains text that tries to instruct an AI, or looks like phishing. Review it in Gmail before acting.' }, icon(ICONS.alert), 'Suspicious') : null,
        m.stale ? h('span', { class: 'tag warn', text: 'Out of date' }) : null,
        m.amount_paise !== null ? h('span', { class: 'tag num', text: formatRupees(m.amount_paise) }) : null,
        m.attachments ? h('span', { class: 'tag', title: `${plural(m.attachments, 'attachment')}. Open the email to see and fetch them.` }, icon(ICONS.clip), h('span', { class: 'num', text: formatCount(m.attachments) }), h('span', { class: 'sr-only', text: m.attachments === 1 ? ' attachment' : ' attachments' })) : null,
        h('span', { class: `tag pri p${m.priority}`, text: `P${m.priority}`, title: `Priority ${m.priority} of 5` }),
        queued ? h('span', { class: 'tag queued', text: `Queued: ${OP_LABELS[queued.op]}` }) : null,
        sugOp && !m.suspicious && !queued ? h('button', { type: 'button', class: 'btn sm suggest', 'data-op': sugOp, 'data-label': m.suggested_label || '', 'aria-label': `Suggested: ${OP_LABELS[sugOp]}${m.suggested_label ? ' to ' + m.suggested_label : ''}, for ${m.subject}` },
          `Suggested: ${OP_LABELS[sugOp]}${m.suggested_label ? ` → ${m.suggested_label}` : ''}`) : null)),
    h('div', { class: 'cell-group' }, groupBadge(m.group)),
    h('div', { class: 'cell-date' }, h('time', { datetime: m.date, text: when(m.date), title: formatDateTime(new Date(m.date), S.tz) })),
    h('div', { class: 'cell-actions' },
      qa('archive', ICONS.archive, 'Archive'), qa('delete', ICONS.trash, 'Trash'), qa('move_to_label', ICONS.label, 'Move to label'), qa('mark_read', ICONS.read, 'Mark read')));
}

async function askLabel(n) {
  const input = h('input', { type: 'text', list: 'label-list', autocomplete: 'off', placeholder: 'Receipts', maxlength: '100' });
  const dl = h('datalist', { id: 'label-list' }, savedLabels().map((l) => h('option', { value: l })));
  let result = null;
  const v = await dialog({
    title: `Move ${plural(n, 'conversation')} to a label`,
    body: h('div', { class: 'stack' }, field('Label name', input, { hint: 'Gmail creates the label if it does not exist. Use a slash for nesting, like Finance/Receipts.' }), dl),
    actions: [{ label: 'Cancel', value: null, kind: 'ghost' }, {
      label: 'Add to queue', value: 'ok', kind: 'primary', submit: true,
      validate: () => {
        const check = validateLabel(input.value);
        setFieldError(input, check.error || '');
        result = check.label;
        return !check.error;
      },
    }],
  });
  return v === 'ok' ? result : null;
}

async function rowAction(op, m, label) {
  if (op === 'move_to_label') {
    const l = label || (await askLabel(1));
    if (!l) return;
    await stageRows([m], op, l);
  } else if (op === 'unsubscribe') {
    await unsubscribeRow(m);
  } else await stageRows([m], op);
  render();
}

async function bulkAction(op, rows) {
  if (!rows.length) return;
  if (op === 'move_to_label') {
    const l = await askLabel(rows.length);
    if (!l) return;
    await stageRows(rows, op, l);
  } else await stageRows(rows, op);
  S.selected.clear();
  render();
}

async function unsubscribeRow(m) {
  const u = m.unsubscribe;
  if (u && u.one_click) return stageRows([m], 'unsubscribe');
  const link = u && (safeUrl(u.url) || safeUrl(u.mailto));
  if (!link) return toast('This sender offers no unsubscribe link. Use "Trash all from sender" in Cleanup instead.', 'error');
  await dialog({
    title: 'Unsubscribe manually',
    body: h('p', {}, 'This sender does not support one-click unsubscribe, so the agent cannot do it for you. Open the sender’s own page: ',
      h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: new URL(link).host || 'email link' }), '.'),
  });
}

// ------------------------------------------------------------------ email reader

const bodyMemo = new Map(); // "account:id" -> checked text (decrypted), kept for this tab only
// The reader's helpers load on first use, which keeps them off the first page load.
let MT = null;
const readerHelpers = async () => (MT ||= await import('./js/mailtext.js'));

async function demoBodies() {
  if (!S.demoBodies) {
    const res = await fetch('demo-bodies.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`The demo emails could not be loaded (HTTP ${res.status}).`);
    S.demoBodies = await res.json();
  }
  return S.demoBodies;
}

/**
 * Saved text of one message: from memory, then this device, then GitHub.
 * An encrypted text is cached on the device still encrypted and decrypted in memory only.
 */
async function loadBody(account, id) {
  await readerHelpers();
  const key = `${account}:${id}`;
  if (bodyMemo.has(key)) return bodyMemo.get(key);
  let raw;
  if (S.demo) raw = (await demoBodies())[key] || null;
  else {
    raw = await kvGet(`body:${key}`);
    if (!raw) {
      raw = await S.gh.getBody(account, id);
      if (raw) await kvSet(`body:${key}`, raw);
    }
    if (raw && isEncrypted(raw)) raw = JSON.parse(new TextDecoder().decode(await decryptBytes(raw, session.get('passphrase'))));
  }
  const body = MT.validateBody(raw);
  if (body) bodyMemo.set(key, body); // a missing text can arrive with the next sync, so a miss is not remembered
  return body;
}

async function forgetBodies(keep = null) {
  bodyMemo.clear();
  S.demoBodies = null;
  await kvDeletePrefix('body:', keep);
}

const downloadName = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'attachment';

function saveBytes(name, bytes) {
  // application/octet-stream makes every browser save the file instead of opening it.
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: downloadName(name) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function mailText(text, linksLive) {
  const box = h('div', { class: 'mail-text', tabindex: '0', role: 'region', 'aria-label': 'Email text' });
  for (const seg of MT.linkSegments(text)) {
    if (seg.type === 'link' && linksLive) box.append(h('a', { href: seg.href, target: '_blank', rel: 'noopener noreferrer', text: seg.value }));
    else box.append(seg.value);
  }
  return box;
}

function readableDate(raw) {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? raw : formatDateTime(new Date(t), S.tz);
}

async function fileBytes(m, id, f) {
  if (S.demo) return new TextEncoder().encode(`Made-up demo file "${f.name}". In real use this is the attachment itself.\n`);
  const buf = await S.gh.getFileBytes(m.account, id, f.file);
  if (!f.encrypted) return new Uint8Array(buf);
  return decryptBytes(JSON.parse(new TextDecoder().decode(buf)), session.get('passphrase'));
}

function renderDownloads(area, m, id, manifest) {
  clear(area);
  const files = manifest.files;
  append(area, [h('p', { class: 'muted small', text: manifest.fetched_at ? `Fetched ${readableDate(manifest.fetched_at)}. Files are kept in your private repository for 7 days.` : 'Ready to download.' }),
    h('ul', { class: 'download-list' }, files.map((f) => h('li', {},
      f.skipped || (!f.file && !S.demo)
        ? h('p', { class: 'small' }, h('strong', { text: f.name }), `: not fetched. ${f.skipped || 'The file name was not valid.'} Open the email in Gmail to get it.`)
        : h('button', { type: 'button', class: 'btn sm', onclick: async (e) => {
          const b = e.currentTarget;
          if (m.suspicious) {
            const ok = await dialog({
              title: 'Download from a suspicious email?',
              body: h('p', { text: `This email was flagged as suspicious. "${f.name}" may be harmful. Download it only if you trust the sender, and scan it before opening.` }),
              actions: [{ label: 'Cancel', value: null, kind: 'ghost' }, { label: 'Download anyway', value: 'ok', kind: 'danger' }],
            });
            if (ok !== 'ok') return;
          }
          b.disabled = true;
          try {
            saveBytes(f.name, await fileBytes(m, id, f));
          } catch (err) {
            toast(`"${f.name}" could not be downloaded: ${err.message || err}`, 'error', 9000);
          } finally {
            b.disabled = false;
          }
        } }, icon(ICONS.download), `Download ${f.name}`, h('span', { class: 'muted', text: ` (${MT.formatBytes(f.size)})` })))))]);
}

async function fetchAttachments(m, id, area, body) {
  const status = h('p', { class: 'small', role: 'status' });
  clear(area);
  area.append(status);
  const say = (t, url) => {
    clear(status);
    append(status, [t, url ? ' ' : null, url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'See the run on GitHub' }) : null]);
  };
  try {
    let manifest;
    if (S.demo) {
      say('Asking the agent to fetch the files (demo)…');
      await wait(900);
      manifest = { fetched_at: new Date().toISOString(), files: body.attachments.map((a) => ({ ...a, file: null, encrypted: false, skipped: null })) };
    } else {
      if (!navigator.onLine) throw new Error('You are offline. Try again when you are back online.');
      const batch = newBatchId();
      const since = new Date(Date.now() - 60_000).toISOString().slice(0, 19) + 'Z';
      say('Sending the request to GitHub…');
      await S.gh.dispatch({ v: 1, batch_id: batch, commands: [{ account: m.account, op: 'fetch_attachments', ids: [id] }] });
      await S.records.put(`b:${batch}`, { id: batch, status: 'queued', at: Date.now(), summary: 'Fetch attachments of 1 email' });
      say('Waiting for GitHub to start the run…');
      let run = null;
      for (let t = 0; t < 40 && !run; t++) {
        await wait(Math.min(3000 + t * 500, 8000));
        run = await S.gh.findRun(batch, since).catch(() => null);
      }
      if (!run) throw new Error('GitHub did not start the run within a few minutes. Check the Actions tab in your repository, then try again.');
      say('The agent is copying the files. This usually takes about a minute…', run.html_url);
      const deadline = Date.now() + 10 * 60_000;
      while (run.status !== 'completed' && Date.now() < deadline) {
        await wait(5000);
        run = await S.gh.getRun(run.id).catch(() => run);
      }
      if (run.status !== 'completed') throw new Error('The run is taking longer than 10 minutes. Open this email again later to download the files.');
      await S.records.put(`b:${batch}`, { id: batch, status: run.conclusion === 'success' ? 'ok' : 'failed', at: Date.now(), summary: 'Fetch attachments of 1 email', runUrl: run.html_url });
      if (run.conclusion !== 'success') throw new Error(`The run ended with "${run.conclusion}". Open Activity, then the run on GitHub, for the reason.`);
      for (let t = 0; t < 3 && !manifest; t++) {
        manifest = MT.validateManifest(await S.gh.getManifest(m.account, id).catch(() => null));
        if (!manifest) await wait(3000);
      }
      if (!manifest) throw new Error('The run finished but no files were found. Open Activity for the run, then try again.');
    }
    renderDownloads(area, m, id, manifest);
  } catch (err) {
    say(err.message || String(err));
    status.classList.add('error-text');
    area.append(h('button', { type: 'button', class: 'btn sm', onclick: () => fetchAttachments(m, id, area, body) }, 'Try again'));
  }
}

function attachmentBlock(m, id, body) {
  const area = h('div', { class: 'attach-actions' });
  const offer = () => {
    clear(area);
    append(area, [
      h('button', { type: 'button', class: 'btn sm', disabled: !S.demo && !S.gh, onclick: () => fetchAttachments(m, id, area, body) }, icon(ICONS.download), 'Fetch attachments'),
      h('p', { class: 'hint', text: 'The agent copies the files into your private repository, then you download them here. Files are deleted after 7 days. Files over 15 MB stay in Gmail.' })]);
  };
  if (S.demo) offer();
  else {
    area.append(h('p', { class: 'muted small', role: 'status', text: 'Checking for files fetched earlier…' }));
    S.gh.getManifest(m.account, id).then((raw) => {
      const man = MT.validateManifest(raw);
      if (man) renderDownloads(area, m, id, man);
      else offer();
    }).catch(offer);
  }
  return h('section', { class: 'attach', 'aria-label': 'Attachments' },
    h('h3', { class: 'h-small', text: `Attachments (${body.attachments.length})` }),
    h('ul', { class: 'attach-list' }, body.attachments.map((a) => h('li', {}, icon(ICONS.clip),
      h('span', { class: 'attach-name', text: a.name }), h('span', { class: 'muted small', text: `${a.mime || 'file'}, ${MT.formatBytes(a.size)}` })))),
    area);
}

function bodyView(m, id, body, { newest }) {
  if (!body) {
    const off = S.state && S.state.bodies && !S.state.bodies.stored && !S.demo;
    return h('div', { class: 'notice' }, h('p', { text: off
      ? 'Saving email text is turned off for this repository (the MAILEAN_STORE_BODIES variable is 0). Open the email in Gmail to read it.'
      : 'The full text of this email is not saved yet. The agent saves the text of new emails at each sync, so it appears after the next one. Until then, open it in Gmail.' }));
  }
  const facts = [['From', body.from], ['To', body.to], ['Cc', body.cc], ['Date', body.date ? readableDate(body.date) : '']].filter(([, v]) => v);
  return h('div', { class: 'msg' },
    newest ? null : h('dl', { class: 'mail-meta' }, facts.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v })))),
    m.suspicious ? h('p', { class: 'notice warn small' }, icon(ICONS.alert), 'Links in this email are shown as plain text because it was flagged as suspicious.') : null,
    body.text.trim() ? mailText(body.text, !m.suspicious) : h('p', { class: 'muted', text: 'This email has no text, only attachments or images.' }),
    body.truncated ? h('p', { class: 'muted small', text: 'This email is long; the saved copy stops part-way. Open it in Gmail for the rest.' }) : null,
    body.attachments.length ? attachmentBlock(m, id, body) : null);
}

function loadInto(holder, m, id, opts) {
  const status = h('p', { class: 'muted', role: 'status', text: 'Loading the email text…' });
  clear(holder);
  holder.append(status);
  return loadBody(m.account, id).then((b) => {
    if (!holder.isConnected) return null;
    clear(holder);
    holder.append(bodyView(m, id, b, opts));
    return b;
  }).catch((err) => {
    status.textContent = `The email text could not be loaded. ${err.message || err}`;
    status.className = 'error-text';
    return null;
  });
}

async function openReader(start, rows) {
  if (!rows.length) return;
  try {
    await readerHelpers();
  } catch {
    toast('The reader could not be loaded. Check your connection and try again.', 'error');
    return;
  }
  const dlg = $('#reader');
  let pos = Math.max(0, rows.findIndex((r) => r.key === start.key));
  let changed = false;
  const title = h('h2', { id: 'reader-title', class: 'reader-title', tabindex: '-1' });
  const counter = h('span', { class: 'muted small num' });
  const prev = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => move(-1) }, '‹ Previous');
  const next = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => move(1) }, 'Next ›');
  const content = h('div', { class: 'dlg-body reader-body' });
  const foot = h('div', { class: 'dlg-actions reader-actions' });
  clear(dlg);
  dlg.append(h('div', { class: 'dlg-inner' },
    h('div', { class: 'dlg-head' }, title, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the email', onclick: () => dlg.close() }, icon(ICONS.close))),
    h('nav', { class: 'reader-nav', 'aria-label': 'Move between emails' }, prev, counter, next),
    content, foot));
  dlg.setAttribute('aria-labelledby', 'reader-title');
  dlg.onclose = () => {
    dlg.onkeydown = null;
    clear(dlg);
    if (changed) render();
  };
  dlg.onkeydown = (e) => {
    if (e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight' || e.key === 'j') move(1);
    else if (e.key === 'ArrowLeft' || e.key === 'k') move(-1);
  };

  function move(d) {
    const to = pos + d;
    if (to < 0 || to >= rows.length) return;
    pos = to;
    show();
    if (document.activeElement && document.activeElement.disabled) title.focus();
  }

  async function act(op) {
    const m = rows[pos];
    let label = null;
    if (op === 'move_to_label') {
      label = await askLabel(1);
      if (!label) return;
    }
    await stageRows([m], op, label);
    changed = true;
    renderChrome(); // queue count; the list itself refreshes when the reader closes
    if (pos < rows.length - 1) move(1);
    else dlg.close();
  }

  function show() {
    const m = rows[pos];
    const acct = (S.index && S.index.accounts.get(m.account)) || { email: '' };
    title.textContent = m.subject || '(no subject)';
    counter.textContent = `${formatCount(pos + 1)} of ${formatCount(rows.length)}`;
    prev.disabled = pos === 0;
    next.disabled = pos >= rows.length - 1;
    const queued = queuedOpFor(m.key);
    const ids = MT.conversationOrder(m);
    clear(content);
    content.scrollTop = 0;
    const fromRow = h('div', {}, h('dt', { text: 'From' }), h('dd', { text: m.sender_email ? `${m.sender_name} <${m.sender_email}>` : m.sender_name }));
    append(content, [
      h('dl', { class: 'mail-meta' }, fromRow,
        h('div', {}, h('dt', { text: 'Date' }), h('dd', {}, h('time', { datetime: m.date, text: formatDateTime(new Date(m.date), S.tz) }))),
        S.state.accounts.length > 1 ? h('div', {}, h('dt', { text: 'Account' }), h('dd', { text: accountLabel(m.account) })) : null),
      h('div', { class: 'tags' }, groupBadge(m.group),
        h('span', { class: `tag pri p${m.priority}`, text: `P${m.priority}`, title: `Priority ${m.priority} of 5` }),
        m.amount_paise !== null ? h('span', { class: 'tag num', text: formatRupees(m.amount_paise) }) : null,
        m.suspicious ? h('span', { class: 'tag danger' }, icon(ICONS.alert), 'Suspicious') : null,
        queued ? h('span', { class: 'tag queued', text: `Queued: ${OP_LABELS[queued.op]}` }) : null),
      m.summary && m.summary !== m.subject && m.summary !== `${m.sender_name}: ${m.subject}` ? h('p', { class: 'summary muted', text: `Summary: ${m.summary}` }) : null]);
    const newest = h('div', { class: 'msg-holder' });
    content.append(newest);
    loadInto(newest, m, ids[0], { newest: true }).then((b) => {
      // Recipients sit with the sender once the saved text has arrived.
      if (b && fromRow.isConnected) fromRow.after(...[['To', b.to], ['Cc', b.cc]].filter(([, v]) => v).map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }))));
    });
    const older = ids.slice(1);
    if (older.length) {
      append(content, [h('h3', { class: 'h-small', text: `Earlier in this conversation (${older.length}${m.message_ids.length > ids.length ? ` of ${m.message_ids.length - 1}` : ''})` }),
        older.map((id, i) => {
          const holder = h('div', { class: 'msg-holder' });
          const label = h('span', { text: `Earlier message ${i + 1}` });
          const d = h('details', { class: 'earlier' }, h('summary', {}, label), holder);
          d.addEventListener('toggle', () => {
            if (!d.open || holder.dataset.loaded) return;
            holder.dataset.loaded = '1';
            loadInto(holder, m, id, { newest: false }).then((b) => {
              if (b) label.textContent = `${b.from || 'Unknown sender'}${b.date ? ` · ${readableDate(b.date)}` : ''}`;
            });
          });
          return d;
        })]);
    }
    const search = MT.gmailSearch(m.message_id_header);
    const act1 = (op, ic, text) => h('button', { type: 'button', class: 'btn sm', onclick: () => act(op) }, icon(ic), text);
    clear(foot);
    append(foot, [
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn sm', href: MT.gmailLink({ email: acct.email, messageIdHeader: m.message_id_header, id: m.id }), target: '_blank', rel: 'noopener noreferrer' }, icon(ICONS.external), 'Open in Gmail'),
        search ? h('button', { type: 'button', class: 'btn sm ghost', onclick: async () => {
          try {
            await navigator.clipboard.writeText(search);
            toast('Copied. Paste it into the Gmail search box, including in the Gmail app.');
          } catch {
            toast(`Copy did not work here. Search Gmail for: ${search}`, 'info', 12000);
          }
        } }, 'Copy Gmail search') : null),
      h('div', { class: 'row wrap reader-stage' },
        act1('archive', ICONS.archive, 'Archive'), act1('delete', ICONS.trash, 'Trash'), act1('move_to_label', ICONS.label, 'Move'),
        act1('mark_read', ICONS.read, 'Read'), act1('star', ICONS.star, 'Star'))]);
  }

  show();
  dlg.showModal();
  title.focus();
}

// ------------------------------------------------------------------ dashboard view

function viewDashboard() {
  const page = h('div', { class: 'page' });
  page.append(h('header', { class: 'page-head' }, h('h1', { text: 'Dashboard' }), h('p', { class: 'muted', text: 'What is in your inboxes right now. Every chart can be read as a table.' })));
  append(page, stateBanner());
  if (!S.state) {
    page.append(emptyState('No data to chart yet', 'Connect your repository or try the demo from Home.'));
    return page;
  }
  const rows = S.state.messages.filter((m) => !handledKeys().has(m.key));
  const s = dashboardStats(rows, { timeZone: S.tz });
  const now = new Date();
  page.append(h('div', { class: 'tiles' },
    tile('Conversations', formatCount(s.total), `${plural(S.state.accounts.length, 'account')}`, () => go('inbox')),
    tile('Unread', formatCount(s.unread), s.total ? `${Math.round((s.unread / s.total) * 100)}% of all` : '', () => { S.f.unreadOnly = true; go('inbox'); }),
    tile('Action required', formatCount(s.actionRequired), 'reply or decide', () => { S.f.group = 'action_required'; go('inbox'); }),
    tile(`Receipts ${s.fyLabel}`, formatRupees(s.receiptsTotal), `${plural(s.receiptsCount, 'receipt')} in INR`, () => { S.f.group = 'receipts_finance'; go('inbox'); }),
    tile('Suspicious', formatCount(s.suspicious), 'possible injection or phishing', () => go('inbox'))));
  const grid = h('div', { class: 'chart-grid' });
  grid.append(chartCard({ id: 'c-groups', title: 'Conversations by group', subtitle: 'Colour stays with the group on every screen.', data: s.byGroup, format: formatCount, labelHeader: 'Group', valueHeader: 'Conversations' }));
  grid.append(chartCard({ id: 'c-weeks', title: 'Received per ISO week', subtitle: `Last 8 weeks, Monday to Sunday, ending ${cwLabel(isoWeek(now, S.tz))}.`, kind: 'columns',
    data: s.weeks.map((w) => ({ ...w, tableLabel: `${w.label} ${w.year}` })), format: formatCount, labelHeader: 'Week', valueHeader: 'Conversations' }));
  grid.append(chartCard({ id: 'c-receipts', title: `Receipts by month, ${s.fyLabel}`, subtitle: 'Indian rupee amounts found in receipts, exact to the paisa.', kind: 'columns',
    data: s.receiptsByMonth.map((m) => ({ ...m, tableLabel: m.key })), format: (v) => formatRupees(v), axisFormat: (v) => formatRupeesCompact(Math.round(v)), labelHeader: 'Month', valueHeader: 'Amount (₹)', empty: 'No rupee receipts this financial year yet.' }));
  grid.append(chartCard({ id: 'c-accounts', title: 'Conversations by account', data: s.byAccount.map((a) => ({ ...a, label: accountLabel(a.key) })), format: formatCount, labelHeader: 'Account', valueHeader: 'Conversations' }));
  grid.append(chartCard({ id: 'c-priority', title: 'Priority', subtitle: '5 is most urgent.', data: s.byPriority, format: formatCount, labelHeader: 'Priority', valueHeader: 'Conversations' }));
  page.append(grid);
  const top = h('section', { class: 'card', 'aria-labelledby': 'top-title' }, h('h3', { id: 'top-title', text: 'Top senders' }),
    dataTable(['Sender', 'Address', 'Conversations'], s.topSenders.map((t) => [t.name, t.email, formatCount(t.count)]), { numeric: new Set([2]) }));
  page.append(top);
  const c = S.state.classifier || {};
  page.append(h('p', { class: 'muted small', text: `Triage by ${c.model || 'unknown'}: ${formatCount(c.llm || 0)} by Claude, ${formatCount(c.rules || 0)} by built-in rules, ${formatCount(c.cached || 0)} reused. Dates shown in ${S.tz}.` }));
  return page;
}

// ------------------------------------------------------------------ cleanup view

function viewCleanup() {
  const page = h('div', { class: 'page' });
  page.append(h('header', { class: 'page-head' }, h('h1', { text: 'Cleanup' }),
    h('p', { class: 'muted', text: 'Senders with many messages, or old ones, in promotions, newsletters and low-priority mail. Starred mail is never trashed.' })));
  append(page, stateBanner());
  if (!S.state) {
    page.append(emptyState('Nothing to clean yet', 'Refresh to load the latest triage.'));
    return page;
  }
  const days = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: '3650', step: '1', value: String(S.cleanupDays || 0) });
  days.addEventListener('change', () => {
    const n = Number(days.value);
    if (!Number.isInteger(n) || n < 0 || n > 3650) {
      setFieldError(days, 'Enter a whole number of days from 0 to 3650.');
      return;
    }
    setFieldError(days, '');
    S.cleanupDays = n;
    render();
  });
  page.append(h('div', { class: 'filters' }, field('Oldest message at least (days)', days, { hint: '0 shows every candidate.' })));
  const hidden = handledKeys();
  const list = S.state.cleanup.filter((c) => c.max_age_days >= S.cleanupDays && (S.f.account === 'all' || c.account === S.f.account));
  if (!list.length) {
    page.append(emptyState('No cleanup candidates', S.cleanupDays ? 'Lower the number of days to see more senders.' : 'Your low-value mail is already under control.'));
    return page;
  }
  const ul = h('ul', { class: 'cards' });
  for (const c of list) {
    const convs = [...new Set(c.message_ids.map((id) => S.index.byMessageId.get(`${c.account}:${id}`)).filter(Boolean))].filter((m) => !hidden.has(m.key));
    const queuedSender = S.records.get(`q:sender:${c.account}:${c.sender_email}`);
    const unsub = c.unsubscribe;
    ul.append(h('li', { class: 'card cleanup' },
      h('div', { class: 'cleanup-head' },
        h('div', {}, h('h3', { text: c.sender_name || c.sender_email }), h('p', { class: 'muted small', text: c.sender_email })),
        groupBadge(c.group)),
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', { text: 'Messages' }), h('dd', { class: 'num', text: formatCount(c.count) })),
        h('div', {}, h('dt', { text: 'Oldest' }), h('dd', { text: c.oldest ? formatDate(new Date(c.oldest), S.tz) : '–' })),
        h('div', {}, h('dt', { text: 'Account' }), h('dd', { text: accountLabel(c.account) }))),
      queuedSender ? h('p', { class: 'tag queued', text: 'Queued: Trash all from sender' }) : null,
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn sm', disabled: !convs.length, onclick: () => stageRows(convs, 'archive').then(render) }, icon(ICONS.archive), `Archive ${plural(convs.length, 'conversation')}`),
        unsub ? h('button', { type: 'button', class: 'btn sm', onclick: () => {
          const m = unsub.message_id && S.index.byMessageId.get(`${c.account}:${unsub.message_id}`);
          if (m) unsubscribeRow(m).then(render);
        } }, icon(ICONS.unsub), 'Unsubscribe') : null,
        h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
          const ok = await dialog({
            title: 'Trash all mail from this sender?',
            body: h('p', {}, 'The agent moves every message from ', h('strong', { text: c.sender_email }), ` in ${accountLabel(c.account)} to Gmail Trash (up to 1,000), except starred ones. Gmail keeps Trash for 30 days, so you can still restore them.`),
            actions: [{ label: 'Cancel', value: null, kind: 'ghost' }, { label: 'Add to queue', value: 'ok', kind: 'danger' }],
          });
          if (ok) {
            await stage([{ account: c.account, op: 'bulk_trash_sender', sender: c.sender_email, keys: convs.map((m) => m.key) }]);
            toast('Trash all from sender added to the queue.');
            render();
          }
        } }, icon(ICONS.trash), 'Trash all from sender'))));
  }
  page.append(ul);
  return page;
}

// ------------------------------------------------------------------ activity view

function viewActivity() {
  const page = h('div', { class: 'page' });
  page.append(h('header', { class: 'page-head row-between' }, h('h1', { text: 'Activity' }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => refresh(), disabled: S.loading }, icon(ICONS.refresh), 'Refresh'),
      h('button', { type: 'button', class: 'btn', disabled: S.demo || !S.gh, onclick: async () => {
        try {
          await S.gh.runSync();
          toast('Sync started. New triage usually appears in two to four minutes; press Refresh then.');
        } catch (err) {
          toast(err.message, 'error', 9000);
        }
      } }, icon(ICONS.play), 'Run sync now'))));
  append(page, stateBanner());
  const local = S.records.entries('b:').map(([, v]) => v).sort((a, b) => (b.at || 0) - (a.at || 0) || String(b.id).localeCompare(String(a.id)));
  page.append(h('section', { class: 'card', 'aria-labelledby': 'act-local' }, h('h2', { id: 'act-local', text: 'Your recent executions' }),
    local.length ? h('ul', { class: 'activity' }, local.slice(0, 30).map((b) => h('li', {},
      h('span', { class: `status-dot ${b.status}`, 'aria-hidden': 'true' }),
      h('div', {}, h('strong', { text: statusText(b.status) }), ' · ', h('span', { class: 'muted', text: `${b.summary || ''}` }),
        h('p', { class: 'muted small' }, `${b.at ? formatDateTime(new Date(b.at), S.tz) : ''} · ${b.id}`,
          b.runUrl && safeUrl(b.runUrl) ? h('span', {}, ' · ', h('a', { href: safeUrl(b.runUrl), target: '_blank', rel: 'noopener noreferrer', text: 'View run on GitHub' })) : null)))))
      : emptyState('No executions yet', 'Stage actions in the Inbox, then press "Execute via agent" in the queue.')));
  const audit = S.state ? S.state.audit : [];
  page.append(h('section', { class: 'card', 'aria-labelledby': 'act-agent' }, h('h2', { id: 'act-agent', text: 'Agent audit log' }),
    h('p', { class: 'muted small', text: 'Written by the agent for every command run. Counts only; no email content.' }),
    audit.length ? dataTable(['Started', 'Status', 'Done', 'Failed', 'Manual'], audit.map((a) => [
      a.started_at ? formatDateTime(new Date(a.started_at), S.tz) : '–', statusText(a.status),
      formatCount((a.summary || {}).succeeded || 0), formatCount((a.summary || {}).failed || 0), formatCount((a.summary || {}).manual || 0)]),
    { numeric: new Set([2, 3, 4]) }) : emptyState('No audit records yet', 'They appear after the first command run and the next sync.')));
  return page;
}

function statusText(s) {
  return { ok: 'Done', partial: 'Partly done', failed: 'Failed', rejected: 'Rejected', running: 'Running', queued: 'Waiting to start', error: 'Problem' }[s] || s || 'Unknown';
}

// ------------------------------------------------------------------ import and export view

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stampName = () => {
  const p = localParts(new Date(), S.tz);
  return `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
};

let worker = null;
function parseInBackground(text, accounts) {
  // Parsing a large CSV on the main thread would freeze scrolling; use a worker when possible.
  return new Promise((resolve) => {
    try {
      if (!worker) worker = new Worker(new URL('./js/worker.js', import.meta.url), { type: 'module' });
      const id = Math.random();
      const onMsg = (e) => {
        if (e.data.id !== id) return;
        worker.removeEventListener('message', onMsg);
        resolve(e.data.error ? { error: e.data.error } : e.data.result);
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id, text, accounts });
    } catch {
      resolve(buildImportPreview(text, accounts)); // fallback: same code on the main thread
    }
  });
}

function viewData() {
  const page = h('div', { class: 'page' });
  page.append(h('header', { class: 'page-head' }, h('h1', { text: 'Import & export' }),
    h('p', { class: 'muted', text: 'CSV files open in Excel with every digit kept. Fill the Action column and import the file to queue actions in bulk.' })));
  const has = !!S.state;
  const rows = has ? sortMessages(S.state.messages, 'newest') : [];
  page.append(h('section', { class: 'card stack', 'aria-labelledby': 'exp-title' }, h('h2', { id: 'exp-title', text: 'Export' }),
    h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn', disabled: !has, onclick: () => download(`mailean-inbox-${stampName()}.csv`, exportInboxCsv(rows, S.state.accounts, { timeZone: S.tz }), 'text/csv;charset=utf-8') }, icon(ICONS.data), `Inbox CSV (${formatCount(rows.length)})`),
      h('button', { type: 'button', class: 'btn', disabled: !has, onclick: () => {
        const r = rows.filter((m) => m.group === 'receipts_finance');
        download(`mailean-receipts-${stampName()}.csv`, exportInboxCsv(r, S.state.accounts, { timeZone: S.tz, title: 'Mailean receipts export' }), 'text/csv;charset=utf-8');
      } }, icon(ICONS.data), 'Receipts CSV'),
      h('button', { type: 'button', class: 'btn', onclick: () => download(`mailean-backup-${stampName()}.json`, JSON.stringify({ app: 'mailean', kind: 'backup', schema: 1, saved_at: new Date().toISOString(), records: S.records.snapshot() }, null, 1), 'application/json') }, icon(ICONS.data), 'Backup of queue and labels')),
    h('p', { class: 'hint', text: 'Exports contain email subjects. Keep them out of any git repository; the project .gitignore already blocks mailean-* files.' })));

  const fileIn = h('input', { type: 'file', accept: '.csv,text/csv' });
  const previewBox = h('div', { class: 'stack' });
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files && fileIn.files[0];
    clear(previewBox);
    S.importPreview = null;
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setFieldError(fileIn, 'That file is over 5 MB. Export fewer rows or split it.');
      return;
    }
    setFieldError(fileIn, '');
    previewBox.append(h('p', { class: 'muted', role: 'status', text: 'Reading the file…' }));
    const text = await file.text();
    const accounts = S.state ? S.state.accounts.map((a) => ({ id: a.id, label: a.label })) : [];
    const p = await parseInBackground(text, accounts);
    clear(previewBox);
    if (p.error) {
      setFieldError(fileIn, p.error);
      return;
    }
    S.importPreview = p;
    previewBox.append(importPreview(p, () => { clear(previewBox); fileIn.value = ''; }));
  });
  page.append(h('section', { class: 'card stack', 'aria-labelledby': 'imp-title' }, h('h2', { id: 'imp-title', text: 'Import actions from CSV' }),
    h('p', { class: 'muted', text: 'Use a Mailean export, or any CSV with Account, Message ID and Action columns. Lines before the header are skipped. Nothing is queued until you press Import.' }),
    field('CSV file', fileIn), previewBox));

  const backupIn = h('input', { type: 'file', accept: '.json,application/json' });
  backupIn.addEventListener('change', async () => {
    const file = backupIn.files && backupIn.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'mailean' || typeof data.records !== 'object') throw new Error('This is not a Mailean backup file.');
      const n = liveEntries(data.records).length;
      const ok = await dialog({ title: 'Restore backup?', body: h('p', { text: `The file has ${plural(n, 'record')} (queue items, labels and history). They are merged with what is here; newer changes win.` }),
        actions: [{ label: 'Cancel', value: null, kind: 'ghost' }, { label: 'Restore', value: 'ok', kind: 'primary' }] });
      if (ok) {
        await S.records.mergeIn(data.records, 'local');
        toast(`Restored ${plural(n, 'record')}.`);
        render();
      }
    } catch (err) {
      setFieldError(backupIn, `${err.message} Choose a file made with "Backup of queue and labels".`);
    }
  });
  page.append(h('section', { class: 'card stack', 'aria-labelledby': 'bak-title' }, h('h2', { id: 'bak-title', text: 'Restore a backup' }), field('Backup file', backupIn)));
  return page;
}

function importPreview(p, done) {
  const ready = p.rows.filter((r) => r.status === 'ready');
  const statusLabel = { ready: 'Ready', skip: 'Skipped', error: 'Error' };
  const shown = p.rows.slice(0, 500);
  const table = dataTable(['Line', 'Status', 'Details'], shown.map((r) => [`Line ${r.line}`,
    h('span', { class: `tag ${r.status === 'error' ? 'danger' : r.status === 'skip' ? '' : 'ok'}`, text: statusLabel[r.status] }), r.message]),
  { caption: 'Import preview, one status per row', rowClass: (i) => shown[i].status });
  return h('div', { class: 'stack' },
    h('p', { role: 'status' }, h('strong', { text: `Header found on line ${p.headerRow + 1}. ` }),
      `${formatCount(p.counts.ready)} ready, ${formatCount(p.counts.skip)} skipped, ${formatCount(p.counts.error)} with errors.`,
      p.amountTotal ? ` Amount column total: ${formatRupees(p.amountTotal)}.` : ''),
    table,
    p.rows.length > 500 ? h('p', { class: 'hint', text: `Showing the first 500 of ${formatCount(p.rows.length)} rows.` }) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', disabled: !ready.length, onclick: async () => {
        const items = ready.map((r) => {
          const it = r.item;
          if (it.op === 'bulk_trash_sender') return { ...it, keys: [] };
          const conv = S.index ? S.index.byMessageId.get(`${it.account}:${it.ids[0]}`) : null;
          return { ...it, keys: [conv ? conv.key : `${it.account}:${it.ids[0]}`] };
        });
        await stage(items);
        toast(`Imported ${plural(items.length, 'action')} into the queue.`);
        done();
        render();
      } }, `Import ${formatCount(ready.length)} ready rows`),
      h('button', { type: 'button', class: 'btn ghost', onclick: done, text: 'Cancel' })));
}

// ------------------------------------------------------------------ settings view

function viewSettings() {
  const page = h('div', { class: 'page narrow' });
  page.append(h('header', { class: 'page-head' }, h('h1', { text: 'Settings' })));
  const masked = S.conn ? `${S.conn.token.slice(0, 11)}…${S.conn.token.slice(-4)}` : '';
  page.append(h('section', { class: 'card stack', 'aria-labelledby': 's-conn' }, h('h2', { id: 's-conn', text: 'Connection' }),
    S.conn ? h('dl', { class: 'facts' },
      h('div', {}, h('dt', { text: 'Repository' }), h('dd', { text: S.conn.repo })),
      h('div', {}, h('dt', { text: 'Token' }), h('dd', { class: 'mono', text: masked })),
      h('div', {}, h('dt', { text: 'Stored' }), h('dd', { text: ls.get('conn') ? 'On this device' : 'This tab only' })))
      : h('p', { class: 'muted', text: S.demo ? 'You are using demo data.' : 'Not connected.' }),
    h('div', { class: 'row wrap' },
      h('a', { href: '#/connect', class: 'btn', text: S.conn ? 'Change connection' : 'Connect' }),
      S.conn || S.demo ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        ls.remove('conn');
        session.remove('conn');
        ls.set('demo', false);
        S.conn = null;
        S.gh = null;
        S.demo = false;
        S.state = null;
        await kvDelete('state');
        await forgetBodies();
        toast('Disconnected. The token, cached inbox and cached email texts were removed from this device.');
        go('connect');
      } }, S.demo ? 'Leave demo' : 'Forget token and cached inbox') : null)));

  const pass = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Only if you set MAILEAN_STATE_PASSPHRASE' });
  page.append(h('section', { class: 'card stack', 'aria-labelledby': 's-pass' }, h('h2', { id: 's-pass', text: 'Encrypted state' }),
    h('p', { class: 'muted', text: 'If the agent encrypts your state file, enter the same passphrase here. It is kept for this tab only.' }),
    field('Passphrase', pass),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        if (pass.value.length < 12) return setFieldError(pass, 'The passphrase is at least 12 characters long.');
        setFieldError(pass, '');
        session.set('passphrase', pass.value);
        pass.value = '';
        S.etag = null;
        await refresh();
      } }, 'Use passphrase'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { session.remove('passphrase'); forgetKeys(); toast('Passphrase forgotten.'); } }, 'Forget passphrase'))));

  const theme = ls.get('theme') || 'system';
  const themeGroup = h('fieldset', { class: 'radios' }, h('legend', { text: 'Theme' }),
    [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => h('label', { class: 'radio' },
      h('input', { type: 'radio', name: 'theme', value: v, checked: theme === v, onchange: () => setTheme(v) }), t)));
  const tzSel = h('select', { onchange: (e) => { S.tz = e.target.value; ls.set('tz', S.tz); toast(`Dates now shown in ${S.tz}.`); } },
    [...new Set([deviceTimeZone(), 'Asia/Kolkata', 'UTC'])].map((z) => h('option', { value: z, text: z === deviceTimeZone() ? `${z} (this device)` : z, selected: S.tz === z })));
  page.append(h('section', { class: 'card stack', 'aria-labelledby': 's-look' }, h('h2', { id: 's-look', text: 'Appearance and dates' }), themeGroup,
    field('Time zone for dates, weeks and financial years', tzSel, { hint: 'Weeks are ISO weeks (Monday to Sunday). Financial years run 1 April to 31 March.' })));

  const supported = 'showDirectoryPicker' in window;
  const st = S.sync ? S.sync.status : 'local';
  page.append(h('section', { class: 'card stack', 'aria-labelledby': 's-sync' }, h('h2', { id: 's-sync', text: 'Folder sync between devices' }),
    h('p', { class: 'muted', text: 'Optional. Keeps your queue, labels and history in step across computers through a OneDrive folder. Your inbox itself always comes from GitHub.' }),
    h('p', {}, h('strong', { text: 'Status: ' }), h('span', { class: 'pill', dataset: { status: st }, text: STATUS_TEXT[st] }), S.sync && S.sync.detail ? h('span', { class: 'muted small', text: ` ${S.sync.detail}` }) : null),
    supported ? h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn', onclick: chooseFolder }, icon(ICONS.folder), S.sync && S.sync.dir ? 'Choose another folder' : 'Choose sync folder'),
      st === 'access' ? h('button', { type: 'button', class: 'btn primary', onclick: regrantFolder, text: 'Allow folder access' }) : null,
      S.sync && S.sync.dir ? h('button', { type: 'button', class: 'btn ghost', onclick: () => S.sync.syncNow().then(render), text: 'Sync now' }) : null,
      S.sync && S.sync.dir ? h('button', { type: 'button', class: 'btn ghost', onclick: stopFolderSync, text: 'Stop syncing' }) : null)
      : h('p', { class: 'hint', text: 'This browser cannot open folders (phones and Firefox cannot). Your data is saved on this device. Use Chrome or Edge on a computer for folder sync.' })));

  page.append(h('section', { class: 'card stack', 'aria-labelledby': 's-data' }, h('h2', { id: 's-data', text: 'Data on this device' }),
    h('p', { class: 'muted', text: 'The last inbox you loaded, and the email texts you opened, are kept here so the app opens offline. Encrypted texts stay encrypted. Clearing them does not touch Gmail or GitHub.' }),
    h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn', onclick: async () => { await kvDelete('state'); await forgetBodies(); S.state = null; toast('Cached inbox and email texts cleared.'); render(); } }, 'Clear cached inbox'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { ls.set('quickstart', false); quickStart(); } }, 'Show quick start again'))));

  page.append(h('section', { class: 'card stack', 'aria-labelledby': 's-about' }, h('h2', { id: 's-about', text: 'About' }),
    h('p', { text: `Mailean ${VERSION}, released ${RELEASE_DATE}. MIT licence. Font: IBM Plex Sans (SIL Open Font Licence).` }),
    h('p', { class: 'muted small' }, 'Revision history: see CHANGELOG.md in the repository. ', h('a', { href: 'privacy.html', text: 'Privacy policy' }), '.')));
  return page;
}

function setTheme(v) {
  ls.set('theme', v);
  if (v === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  renderChrome();
}

// ------------------------------------------------------------------ guide view

function viewGuide() {
  const sec = (id, title, ...kids) => h('section', { class: 'card stack guide', 'aria-labelledby': id }, h('h2', { id, text: title }), ...kids);
  const ol = (...items) => h('ol', { class: 'steps' }, items.map((t) => h('li', {}, t)));
  const ul = (...items) => h('ul', { class: 'bullets' }, items.map((t) => h('li', {}, t)));
  return h('div', { class: 'page narrow' },
    h('header', { class: 'page-head' }, h('h1', { text: 'Guide' }), h('p', { class: 'lead', text: 'Everything Mailean does, in plain steps.' })),
    h('nav', { class: 'toc', 'aria-label': 'On this page' }, h('ul', {}, [['g-quick', 'Quick start'], ['g-setup', 'One-time setup'], ['g-daily', 'Daily use'], ['g-groups', 'The six groups'], ['g-example', 'Worked example'], ['g-privacy', 'Privacy and safety'], ['g-trouble', 'Troubleshooting']]
      .map(([id, t]) => h('li', {}, h('a', { href: `#${id}`, text: t, onclick: (e) => { e.preventDefault(); document.getElementById(id).scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); } }))))),
    sec('g-quick', 'Quick start',
      ol('Open Home. Read the number of suggested actions.', 'Tap "Stage suggestions". The queue opens and lists what will happen.', 'Tap "Execute via agent". GitHub runs the agent; it takes one to three minutes.', 'Watch the queue: it shows each step and the result.', 'Tap Refresh later to see the cleaned inbox.')),
    sec('g-setup', 'One-time setup (about 30 minutes)',
      h('p', { text: 'The full, numbered instructions are in docs/SETUP.md in the repository. In short:' }),
      ol('In Google Cloud Console, turn on the Gmail API and create an OAuth client of type "Desktop app". Set the consent screen to "In production" so sign-ins do not expire after 7 days.',
        'On your computer, run python scripts/setup_oauth.py. Sign in to each Gmail account. Copy the one line it prints.',
        'Create a private GitHub repository named gmail-command-center. Push the Mailean code to it with git (the web uploader skips the .github folder). Add the secrets MAILEAN_ACCOUNTS and ANTHROPIC_API_KEY, and the variable MAILEAN_ROLE = data.',
        'Create a fine-grained token: only that repository; Contents read; Actions read and write.',
        'Open this page, enter owner/gmail-command-center and the token, and press Connect.')),
    sec('g-daily', 'Daily use',
      ul(h('span', {}, h('strong', { text: 'Inbox: ' }), 'pick an account and a group. Tick conversations and choose Archive, Trash, Move, Read or Star. Or press the suggested action on a row.'),
        h('span', {}, h('strong', { text: 'Read an email: ' }), 'click its subject. You see the full text, the earlier messages and the attachments. Previous and Next (or the arrow keys) move through the list; the action buttons queue and move on. "Fetch attachments" has the agent copy the files (about a minute), then you download them. "Open in Gmail" opens the same email in Gmail.'),
        h('span', {}, h('strong', { text: 'Queue: ' }), 'nothing changes in Gmail until you press "Execute via agent". You can remove items first.'),
        h('span', {}, h('strong', { text: 'Cleanup: ' }), 'clear out a noisy sender in one go, or unsubscribe.'),
        h('span', {}, h('strong', { text: 'Dashboard: ' }), 'see counts by group, week, account and priority, and receipts per month. Press Table on any chart to read the numbers.'),
        h('span', {}, h('strong', { text: 'Import & export: ' }), 'export to Excel, fill the Action column (archive, trash, move, read, star, unsubscribe), and import it back.'),
        h('span', {}, h('strong', { text: 'Keyboard: ' }), 'every control is reachable with Tab; Escape closes dialogs and the queue.'))),
    sec('g-groups', 'The six groups', h('dl', { class: 'groups' }, GROUPS.map((g) => h('div', {}, h('dt', {}, groupBadge(g.key), ` ${g.name}`), h('dd', { text: {
      action_required: 'Someone needs you to reply, approve, pay or attend.', awaiting_reply: 'You are waiting on someone else.',
      receipts_finance: 'Receipts, bank alerts, bills and statements. Amounts are totalled per financial year.', newsletters_reading: 'Subscriptions worth reading later.',
      promotions_spam: 'Offers and likely spam. Good candidates for unsubscribe.', low_priority: 'Notifications that are safe to archive.' }[g.key] }))))),
    sec('g-example', 'Worked example',
      h('p', { text: 'Input (one email the agent sees):' }),
      h('pre', { class: 'code', text: 'From: Example Bank Alerts <alerts@examplebank.test>\nSubject: Rs. 2,499.00 debited from your account XX1234\nSnippet: INR 2,499.00 was debited on 25/11 for UPI txn ref 627153940211' }),
      h('p', { text: 'Expected output (what you see):' }),
      ul('Group: Receipts & Finance. Priority 3.', 'Suggested action: Move to label "Receipts".', 'Amount: ₹2,499.00, stored as 249900 paise, added to FY 2026-27, month Nov.', 'Reference: 627153940211, kept as text so Excel shows every digit.')),
    sec('g-privacy', 'Privacy and safety',
      ul('Your email data lives only in your private repository, on a branch called mailean-state. Each sync replaces it, so old subjects do not pile up in history.',
        'Only sender, subject, date, labels and a short snippet go to Claude, never the full text or attachments. Codes such as OTPs are masked.',
        'The text of each inbox email is kept in your private repository so you can read it here. It is deleted after the email leaves the inbox. Attachments are copied only when you ask, and deleted after 7 days. Set a passphrase to encrypt both.',
        'In the reader, links show their real address and open in a new tab. Suspicious emails get no clickable links. Attachments are always saved as files, never opened in the page.',
        'Email text is treated as data, never as instructions. Emails that try to instruct an AI are marked Suspicious and never get automatic suggestions.',
        'The agent only does what you queue and execute. Trash is recoverable in Gmail for 30 days; starred mail is never bulk-trashed.',
        'This page talks only to api.github.com. No analytics, no other servers.'),
      h('p', {}, 'Full details: ', h('a', { href: 'privacy.html', text: 'privacy policy' }), '.')),
    sec('g-trouble', 'Troubleshooting',
      ul(h('span', {}, h('strong', { text: '"GitHub rejected the token": ' }), 'create a new fine-grained token and connect again.'),
        h('span', {}, h('strong', { text: '"Google refused the saved sign-in": ' }), 'run setup_oauth.py again for that account and update MAILEAN_ACCOUNTS. If it happens every 7 days, set the OAuth app to "In production".'),
        h('span', {}, h('strong', { text: '"No inbox data yet": ' }), 'open Activity and press "Run sync now". The first sync takes about two minutes.'),
        h('span', {}, h('strong', { text: '"The full text of this email is not saved yet": ' }), 'it arrived after the last sync. Run a sync, or use "Open in Gmail".'),
        h('span', {}, h('strong', { text: 'Execution waits a long time: ' }), 'GitHub sometimes queues runs for a few minutes. The queue keeps waiting up to 15 minutes; your items stay queued if it gives up.'))));
}

// ------------------------------------------------------------------ queue drawer and execution

function openQueue() {
  const d = $('#queue');
  d.hidden = false;
  document.body.classList.add('drawer-open');
  renderQueue();
  requestAnimationFrame(() => d.classList.add('open'));
  $('#queue-title').focus();
}

function closeQueue() {
  const d = $('#queue');
  d.classList.remove('open');
  document.body.classList.remove('drawer-open');
  setTimeout(() => { d.hidden = true; }, reduceMotion() ? 0 : 200);
  $('#queue-btn').focus();
}

function renderQueue() {
  const body = $('#queue-body');
  clear(body);
  const entries = queueEntries();
  const accountIds = new Set(S.state ? S.state.accounts.map((a) => a.id) : []);
  if (S.exec.steps.length) {
    body.append(h('ol', { class: 'progress', 'aria-live': 'polite' }, S.exec.steps.map((s) => h('li', { class: s.state },
      h('span', { class: 'status-dot', 'aria-hidden': 'true' }), h('span', { text: s.text }),
      s.url && safeUrl(s.url) ? h('a', { href: safeUrl(s.url), target: '_blank', rel: 'noopener noreferrer', class: 'small', text: ' View run' }) : null))));
    if (S.exec.error) body.append(h('div', { class: 'banner warn', role: 'alert' }, icon(ICONS.alert), h('p', { text: S.exec.error })));
  }
  if (!entries.length) {
    if (!S.exec.steps.length) body.append(emptyState('The queue is empty', 'Add actions from the Inbox or Cleanup, or press "Stage suggestions" on Home.', h('a', { href: '#/inbox', class: 'btn', text: 'Go to Inbox', onclick: closeQueue })));
    $('#queue-foot').hidden = true;
    return;
  }
  $('#queue-foot').hidden = false;
  // Group by account then action, so the summary reads like a plan.
  const groups = new Map();
  for (const [recKey, v] of entries) {
    const gk = `${v.account}\u0000${v.op}\u0000${v.label || ''}`;
    if (!groups.has(gk)) groups.set(gk, { ...v, recKeys: [], n: 0, invalid: 0 });
    const g = groups.get(gk);
    g.recKeys.push(recKey);
    g.n += v.op === 'bulk_trash_sender' ? 1 : v.keys.length || 1;
    if (itemError(v, accountIds)) g.invalid++;
  }
  const list = h('ul', { class: 'queue-list' });
  for (const g of [...groups.values()].sort((a, b) => a.account.localeCompare(b.account) || a.op.localeCompare(b.op))) {
    const what = g.op === 'bulk_trash_sender' ? `Trash all from ${g.recKeys.map((k) => k.split(':').slice(3).join(':')).join(', ')}`
      : `${OP_LABELS[g.op]}${g.label ? ` → ${g.label}` : ''}: ${plural(g.n, 'conversation')}`;
    list.append(h('li', { class: DESTRUCTIVE.has(g.op) ? 'destructive' : '' },
      h('div', {}, h('strong', { text: what }), h('p', { class: 'muted small', text: accountLabel(g.account) }),
        g.invalid ? h('p', { class: 'error-text', text: `${g.invalid} item(s) are invalid and will be skipped.` }) : null),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${what} from the queue`, disabled: S.exec.running, onclick: async () => { await S.records.remove(g.recKeys); renderQueue(); render(); } }, icon(ICONS.close))));
  }
  body.append(list);
  const sum = summarise(entries.map(([, v]) => v));
  if (sum.delete || sum.bulk_trash_sender) {
    body.append(h('p', { class: 'note warn' }, icon(ICONS.alert), 'Trash moves mail to Gmail Trash. Gmail keeps it for 30 days, so you can restore it there.'));
  }
  const exec = $('#queue-exec');
  exec.disabled = S.exec.running;
  exec.textContent = S.exec.running ? 'Working…' : S.demo ? 'Execute (demo)' : 'Execute via agent';
  $('#queue-clear').disabled = S.exec.running;
}

function step(text, state = 'active', url) {
  for (const s of S.exec.steps) if (s.state === 'active') s.state = 'done';
  S.exec.steps.push({ text, state, url });
  renderQueue();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function executeQueue() {
  if (S.exec.running) return;
  const accountIds = new Set(S.state ? S.state.accounts.map((a) => a.id) : []);
  const entries = queueEntries();
  const valid = entries.filter(([, v]) => !itemError(v, accountIds));
  if (!valid.length) return toast('Nothing valid to execute. Remove the invalid items and try again.', 'error');
  if (!S.demo && !navigator.onLine) return toast('You are offline. Your queue is saved; execute it when you are back online.', 'error', 8000);
  S.exec = { running: true, steps: [], error: '' };
  const items = valid.map(([, v]) => v);
  const payloads = buildPayloads(items);
  const started = Date.now();
  const sumText = Object.entries(summarise(items)).map(([op, n]) => `${OP_LABELS[op]} ${formatCount(n)}`).join(', ');
  let allOk = true;
  try {
    for (const [i, p] of payloads.entries()) {
      const label = payloads.length > 1 ? ` (batch ${i + 1} of ${payloads.length})` : '';
      await S.records.put(`b:${p.batch_id}`, { id: p.batch_id, status: 'queued', at: Date.now(), summary: sumText });
      if (S.demo) {
        step(`Sending to the agent${label}…`);
        await wait(600);
        step('Agent is working (demo)…');
        await wait(900);
        step(`Done${label}: ${sumText}.`, 'done');
        await S.records.put(`b:${p.batch_id}`, { id: p.batch_id, status: 'ok', at: Date.now(), summary: sumText });
        continue;
      }
      step(`Sending to GitHub${label}…`);
      const since = new Date(Date.now() - 60_000).toISOString().slice(0, 19) + 'Z';
      await S.gh.dispatch(p);
      step('Waiting for GitHub to start the run…');
      let run = null;
      for (let t = 0; t < 40 && !run; t++) {
        await wait(Math.min(3000 + t * 500, 8000));
        run = await S.gh.findRun(p.batch_id, since).catch(() => null);
      }
      if (!run) throw new Error('GitHub did not start the run within a few minutes. Your queue is kept; check the Actions tab in the repository, then try again.');
      step('Agent is working…', 'active', run.html_url);
      await S.records.put(`b:${p.batch_id}`, { id: p.batch_id, status: 'running', at: Date.now(), summary: sumText, runUrl: run.html_url });
      const deadline = Date.now() + 15 * 60_000;
      while (run.status !== 'completed' && Date.now() < deadline) {
        await wait(5000);
        run = await S.gh.getRun(run.id).catch(() => run);
      }
      if (run.status !== 'completed') throw new Error('The run is taking longer than 15 minutes. It keeps going on GitHub; check Activity later. Your queue is kept.');
      let audit = null;
      try {
        const year = p.batch_id.slice(2, 6);
        audit = JSON.parse((await S.gh.getStateFile(`audit/${year}/${p.batch_id}.json`)).text);
      } catch { /* the audit file can lag a few seconds; the run conclusion still tells us enough */ }
      const status = audit ? audit.status : run.conclusion === 'success' ? 'ok' : 'failed';
      const s = audit && audit.summary ? audit.summary : null;
      const detail = s ? `${formatCount(s.succeeded)} done, ${formatCount(s.failed)} failed${s.manual ? `, ${formatCount(s.manual)} need a manual unsubscribe` : ''}` : `run ${run.conclusion}`;
      await S.records.put(`b:${p.batch_id}`, { id: p.batch_id, status, at: Date.now(), summary: detail, runUrl: run.html_url });
      step(`${statusText(status)}${label}: ${detail}.`, status === 'ok' ? 'done' : 'warn', run.html_url);
      if (status === 'failed' || status === 'rejected') allOk = false;
    }
  } catch (err) {
    allOk = false;
    S.exec.error = err.message || String(err);
    step('Stopped.', 'warn');
  }
  if (allOk) {
    // Hide acted-on conversations until the agent's next sync confirms the new state.
    const keys = [...new Set(items.flatMap((v) => v.keys))];
    await S.records.putMany(keys.map((k) => [`h:${k}`, { at: started }]));
    await S.records.remove(valid.map(([k]) => k));
    step(S.demo ? 'Demo finished. In real use Gmail now reflects these changes.' : 'Finished. A fresh sync has started; the inbox refreshes automatically.', 'done');
    if (!S.demo) pollForFreshState(started);
  }
  S.exec.running = false;
  renderQueue();
  render();
}

async function pollForFreshState(since) {
  // run-commands.yml starts a sync when it finishes; wait for its new state file.
  for (let i = 0; i < 15; i++) {
    await wait(20_000);
    await refresh({ quiet: true });
    if (S.state && Date.parse(S.state.generated_at) > since) {
      toast('Inbox refreshed with the agent’s latest sync.');
      return;
    }
  }
}

// ------------------------------------------------------------------ folder sync wiring

async function initFolderSync() {
  let device = ls.get('device');
  if (!device || !/^[a-z0-9]{6,16}$/.test(device)) {
    device = Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    ls.set('device', device);
  }
  S.sync = new FolderSync(S.records, device);
  S.sync.onStatus(() => renderChrome());
  S.records.onChange((source) => {
    if (source === 'local') S.sync.changed();
    if (source === 'sync') render();
  });
  if (!('showDirectoryPicker' in window)) return;
  const handle = await kvGet('syncDir');
  if (!handle) return;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') await S.sync.attach(directoryAdapter(handle));
    else S.sync.detach('access', 'Press "Allow folder access" in Settings.');
  } catch (err) {
    S.sync.detach('error', err.message);
  }
  setInterval(() => {
    if (document.visibilityState === 'visible' && S.sync.dir) S.sync.pull();
  }, 60_000);
}

async function chooseFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'mailean-sync', mode: 'readwrite' });
    await kvSet('syncDir', handle);
    await S.sync.attach(directoryAdapter(handle));
    toast('Folder sync is on. Choose the same folder on your other computers.');
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Could not use that folder: ${err.message}`, 'error');
  }
  render();
}

async function regrantFolder() {
  const handle = await kvGet('syncDir');
  if (!handle) return chooseFolder();
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm === 'granted') await S.sync.attach(directoryAdapter(handle));
  render();
}

async function stopFolderSync() {
  await kvDelete('syncDir');
  S.sync.detach('local');
  toast('Folder sync stopped. Your data stays on this device.');
  render();
}

// ------------------------------------------------------------------ quick start

async function quickStart() {
  if (ls.get('quickstart') === true) return;
  const steps = h('ol', { class: 'steps' },
    h('li', {}, h('strong', { text: 'Connect or try the demo. ' }), 'Enter your private repository and token, or explore made-up data first.'),
    h('li', {}, h('strong', { text: 'Review. ' }), 'Home shows how many actions Claude suggests. The Inbox shows every conversation by group.'),
    h('li', {}, h('strong', { text: 'Queue. ' }), 'Pick actions. Nothing changes in Gmail yet.'),
    h('li', {}, h('strong', { text: 'Execute. ' }), 'Press "Execute via agent" in the queue. GitHub runs the agent and reports back.'));
  await dialog({ title: 'Welcome to Mailean', body: h('div', { class: 'stack' }, steps, h('p', { class: 'muted small', text: 'You can reopen this from Settings. The full Guide is in the menu.' })),
    actions: [{ label: 'Open the Guide', value: 'guide', kind: 'ghost' }, { label: 'Get started', value: 'ok', kind: 'primary' }] }).then((v) => {
    ls.set('quickstart', true);
    if (v === 'guide') go('guide');
  });
}

// ------------------------------------------------------------------ keyboard-safe inputs

function keepFocusedFieldVisible() {
  // On phones the on-screen keyboard shrinks the visual viewport. Scroll the
  // focused field into view, and never close anything on resize.
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener('resize', () => {
    const el = document.activeElement;
    if (el && el.matches('input, textarea, select')) el.scrollIntoView({ block: 'center', behavior: 'auto' });
  });
}

// ------------------------------------------------------------------ start

async function init() {
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
  $('#theme-btn').addEventListener('click', () => {
    const cur = ls.get('theme') || 'system';
    const dark = cur === 'dark' || (cur === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(dark ? 'light' : 'dark');
  });
  $('#queue-btn').addEventListener('click', openQueue);
  clear($('#queue-close')).append(icon(ICONS.close));
  $('#queue-close').addEventListener('click', closeQueue);
  $('#queue-exec').addEventListener('click', executeQueue);
  $('#queue-clear').addEventListener('click', async () => {
    await S.records.remove(queueEntries().map(([k]) => k));
    S.exec.steps = [];
    renderQueue();
    render();
  });
  $('#queue-scrim').addEventListener('click', closeQueue);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#queue').hidden && !$('#dlg').open) closeQueue();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && S.sync) S.sync.flush();
  });
  window.addEventListener('hashchange', () => {
    render();
    const main = $('#main');
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderChrome);
  window.addEventListener('online', () => toast('Back online.'));
  window.addEventListener('offline', () => toast('You are offline. Cached data stays available.', 'info'));
  keepFocusedFieldVisible();
  await S.records.load();
  loadConnection();
  await loadCached();
  render();
  initFolderSync().catch((err) => toast(`Folder sync could not start: ${err.message}`, 'error'));
  if (S.conn || S.demo) refresh({ quiet: true });
  quickStart();
}

init().catch((err) => {
  const view = document.getElementById('view');
  if (view) view.textContent = `Mailean could not start: ${err.message}. Reload the page; if it keeps happening, clear this site's data in the browser settings.`;
});
