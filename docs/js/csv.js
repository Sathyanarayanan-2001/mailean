// CSV export and import. Export: UTF-8 with a byte order mark, CRLF, quoted
// where needed, formula-injection safe, and ids kept as text for Excel.
// Import: finds the header row after any preamble, maps columns by name and
// alias, and returns a preview with one status per row. Nothing is saved here.

import { parseInrToPaise } from './format.js';
import { ACCOUNT_RE, MESSAGE_ID_RE, validateLabel } from './commands.js';

export const BOM = '﻿';

function quote(field) {
  return /[",\r\n]|^\s|\s$/.test(field) ? '"' + field.replace(/"/g, '""') + '"' : field;
}

/**
 * Cell encoders. 'text' neutralises formula injection: a subject starting with
 * "=" or "@" would otherwise run as a formula when opened in Excel.
 * 'id' wraps long digit strings as ="…" so Excel keeps every digit
 * (otherwise 627153940211 becomes 6.27E+11 and the digits are lost).
 */
export function encodeCell(value, kind = 'text') {
  const s = value === null || value === undefined ? '' : String(value);
  if (kind === 'id') return s === '' ? '' : `="${s.replace(/"/g, '')}"`;
  if (kind === 'text' && /^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

/** rows: array of arrays of already-encoded strings. */
export function toCsv(rows) {
  return BOM + rows.map((r) => r.map((c) => quote(String(c ?? ''))).join(',')).join('\r\n') + '\r\n';
}

/** RFC 4180 parser: quotes, doubled quotes, CR/LF/CRLF, BOM. O(n) in characters. */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') inQuotes = true; // a quote only opens at field start
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Undo the export encodings: ="123" -> 123, leading ' guard removed. */
export function decodeCell(value) {
  let s = String(value ?? '').trim();
  const m = /^="(.*)"$/.exec(s);
  if (m) s = m[1];
  if (/^'[=+\-@]/.test(s)) s = s.slice(1);
  return s;
}

const norm = (h) => decodeCell(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const IMPORT_COLUMNS = {
  account: ['account', 'account id', 'mailbox', 'account name'],
  id: ['message id', 'id', 'msg id', 'gmail id'],
  ids: ['message ids', 'all message ids', 'conversation ids'],
  action: ['action', 'command', 'op', 'operation', 'do', 'to do'],
  label: ['label', 'folder', 'move to', 'target label'],
  sender: ['from address', 'sender email', 'sender address', 'email'],
  amount: ['amount', 'amount rs', 'amount inr', 'amount ₹', 'value'],
};

/** Index of the first row that names at least two known columns. Skips preamble lines. */
export function findHeaderRow(rows, columns = IMPORT_COLUMNS, scan = 20) {
  const known = new Set(Object.values(columns).flat());
  for (let i = 0; i < Math.min(rows.length, scan); i++) {
    const hits = rows[i].filter((h) => known.has(norm(h))).length;
    if (hits >= 2) return i;
  }
  return -1;
}

/** {field: columnIndex} using names and aliases; first matching column wins. */
export function mapColumns(header, columns = IMPORT_COLUMNS) {
  const map = {};
  const names = header.map(norm);
  for (const [field, aliases] of Object.entries(columns)) {
    // Prefer the canonical name, then aliases in listed order.
    for (const alias of aliases) {
      const idx = names.indexOf(alias);
      if (idx !== -1 && !Object.values(map).includes(idx)) {
        map[field] = idx;
        break;
      }
    }
  }
  return map;
}

export const ACTION_ALIASES = new Map([
  ['archive', 'archive'], ['trash', 'delete'], ['delete', 'delete'], ['bin', 'delete'],
  ['move', 'move_to_label'], ['move to label', 'move_to_label'], ['move_to_label', 'move_to_label'], ['label', 'move_to_label'],
  ['read', 'mark_read'], ['mark read', 'mark_read'], ['mark_read', 'mark_read'], ['mark as read', 'mark_read'],
  ['star', 'star'], ['unsubscribe', 'unsubscribe'], ['trash sender', 'bulk_trash_sender'],
  ['bulk_trash_sender', 'bulk_trash_sender'], ['trash all from sender', 'bulk_trash_sender'],
]);

/**
 * Build the import preview. accounts: [{id, label}]. Returns
 * {headerRow, columns, rows:[{line, status:'ready'|'skip'|'error', message, item}], counts}.
 * O(r) rows with hash-map account lookup.
 */
export function buildImportPreview(text, accounts) {
  const rows = parseCsv(text);
  const headerRow = findHeaderRow(rows);
  if (headerRow === -1) {
    return { error: 'No header row found. The file needs at least an "Account" and a "Message ID" or "Action" column.' };
  }
  const cols = mapColumns(rows[headerRow]);
  const missing = ['account', 'action'].filter((f) => cols[f] === undefined);
  if (missing.length || (cols.id === undefined && cols.ids === undefined && cols.sender === undefined)) {
    return { error: `Missing column(s): ${[...missing, ...(cols.id === undefined && cols.ids === undefined ? ['Message ID'] : [])].join(', ')}. Check the header row (line ${headerRow + 1}).` };
  }
  const byKey = new Map();
  for (const a of accounts) {
    byKey.set(a.id.toLowerCase(), a.id);
    if (a.label) byKey.set(String(a.label).toLowerCase(), a.id);
  }
  const out = [];
  const counts = { ready: 0, skip: 0, error: 0 };
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => String(c).trim() === '')) continue;
    const cell = (f) => (cols[f] === undefined ? '' : decodeCell(r[cols[f]] ?? ''));
    const line = i + 1;
    const rawAction = cell('action').toLowerCase().replace(/\s+/g, ' ');
    const push = (status, message, item = null) => {
      counts[status]++;
      out.push({ line, status, message, item });
    };
    if (!rawAction) {
      push('skip', 'No action');
      continue;
    }
    const op = ACTION_ALIASES.get(rawAction);
    if (!op) {
      push('error', `Unknown action "${cell('action')}". Use archive, trash, move, read, star or unsubscribe.`);
      continue;
    }
    const account = byKey.get(cell('account').toLowerCase());
    if (!account || !ACCOUNT_RE.test(account)) {
      push('error', `Unknown account "${cell('account')}".`);
      continue;
    }
    if (op === 'bulk_trash_sender') {
      const sender = cell('sender').toLowerCase();
      if (!/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(sender)) {
        push('error', 'Trash sender needs a valid "From address".');
        continue;
      }
      push('ready', `Trash all from ${sender}`, { account, op, sender });
      continue;
    }
    const idText = cell('ids') || cell('id');
    const ids = [...new Set(idText.split(/[\s;|]+/).filter(Boolean))];
    if (!ids.length) {
      push('error', 'Message ID is empty.');
      continue;
    }
    const bad = ids.find((x) => !MESSAGE_ID_RE.test(x));
    if (bad) {
      push('error', `Message ID "${bad.slice(0, 24)}" is not valid (letters and digits only).`);
      continue;
    }
    let label;
    if (op === 'move_to_label') {
      const check = validateLabel(cell('label'));
      if (check.error) {
        push('error', check.error);
        continue;
      }
      label = check.label;
    }
    push('ready', `${op.replace(/_/g, ' ')} ${ids.length} message${ids.length === 1 ? '' : 's'}`, { account, op, ids, label });
  }
  const amountCol = cols.amount;
  let amountTotal = 0;
  if (amountCol !== undefined) {
    for (let i = headerRow + 1; i < rows.length; i++) {
      const p = parseInrToPaise(decodeCell(rows[i][amountCol] ?? ''));
      if (p !== null) amountTotal += p;
    }
  }
  return { headerRow, columns: cols, rows: out, counts, amountTotal };
}
