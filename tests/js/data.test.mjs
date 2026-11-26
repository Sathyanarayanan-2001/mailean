// CSV round trip, import preview, state model, dashboard figures, commands, crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toCsv, parseCsv, encodeCell, decodeCell, findHeaderRow, mapColumns, buildImportPreview } from '../../docs/js/csv.js';
import { validateState, indexState, filterMessages, sortMessages, dashboardStats, suggestionItems } from '../../docs/js/model.js';
import { buildPayloads, newBatchId, validateLabel, itemError, LIMITS } from '../../docs/js/commands.js';
import { decryptState } from '../../docs/js/crypto.js';
import { exportInboxCsv } from '../../docs/js/exporter.js';
import { formatInr, parseInrToPaise } from '../../docs/js/format.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-26T03:00:00Z');
const fixture = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const demo = () => validateState(fixture('../../docs/demo-state.json')).state;
const ACCOUNTS = [{ id: 'account_1', label: 'Personal' }, { id: 'account_2', label: 'Work' }];

test('CSV: BOM, quoting, formula guard, ids kept as text', () => {
  const csv = toCsv([['a', 'b,c', 'say "hi"'], [encodeCell('=HYPERLINK("x")'), encodeCell('627153940211', 'id'), 'line\nbreak']]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"b,c"') && csv.includes('"say ""hi"""'));
  const back = parseCsv(csv);
  assert.deepEqual(back[0], ['a', 'b,c', 'say "hi"']);
  assert.equal(back[1][0], "'=HYPERLINK(\"x\")");          // neutralised for Excel
  assert.equal(decodeCell(back[1][0]), '=HYPERLINK("x")');  // and restored on import
  assert.equal(decodeCell(back[1][1]), '627153940211');     // all 12 digits survive
  assert.equal(back[1][2], 'line\nbreak');
});

test('CSV round trip: export everything, import into an empty copy, counts and totals match', () => {
  const state = demo();
  const csv = exportInboxCsv(state.messages, state.accounts, { timeZone: TZ, now: NOW });
  const rows = parseCsv(csv);
  const h = findHeaderRow(rows);
  assert.ok(h >= 2, 'preamble lines are skipped');
  const cols = mapColumns(rows[h]);
  const body = rows.slice(h + 1).filter((r) => r.some((c) => c !== ''));
  assert.equal(body.length, state.messages.length);
  const ids = new Set(body.map((r) => `${decodeCell(r[cols.account])}:${decodeCell(r[cols.id])}`));
  assert.equal(ids.size, state.messages.length);
  const total = body.reduce((s, r) => s + (parseInrToPaise(decodeCell(r[cols.amount])) ?? 0), 0);
  const expected = state.messages.reduce((s, m) => s + (m.amount_paise ?? 0), 0);
  assert.equal(total, expected);
  assert.equal(formatInr(total), formatInr(expected));
});

test('import preview: header after preamble, aliases, status per row, nothing saved', () => {
  const text = [
    'My notes from Excel', 'exported 26/11', '',
    'Mailbox,Msg ID,Command,Folder,Amount (INR)',
    'Personal,1a00000000000037,archive,,"1,23,456.78"',
    'account_2,2b0000000000000a,Move,Finance/Receipts,0.22',
    'Work,2b0000000000000b,move,INBOX,',
    'account_9,abc123,trash,,',
    'Personal,bad id!,trash,,',
    'Personal,1a00000000000040,,,',
    'Personal,1a00000000000041,explode,,',
    'Personal,="1a00000000000042",Read,,',
  ].join('\r\n');
  const p = buildImportPreview(text, ACCOUNTS);
  assert.equal(p.headerRow, 3);
  assert.deepEqual(p.counts, { ready: 3, skip: 1, error: 4 });
  assert.deepEqual(p.rows.map((r) => r.status), ['ready', 'ready', 'error', 'error', 'error', 'skip', 'error', 'ready']);
  assert.equal(p.rows[1].item.label, 'Finance/Receipts');
  assert.match(p.rows[2].message, /system label/);
  assert.match(p.rows[3].message, /Unknown account/);
  assert.equal(p.rows[7].item.ids[0], '1a00000000000042');
  assert.equal(p.amountTotal, 12345678 + 22);
  assert.match(buildImportPreview('just,some,text', ACCOUNTS).error, /No header row/);
});

test('state validation drops bad rows and keeps good ones', () => {
  const raw = fixture('../../docs/demo-state.json');
  const evil = { ...raw.messages[0], id: '../../x' };
  const dup = { ...raw.messages[1] };
  const res = validateState({ ...raw, messages: [...raw.messages, evil, dup, { group: 'vip' }] });
  assert.equal(res.dropped, 3);
  assert.equal(res.state.messages.length, raw.messages.length);
  assert.match(validateState({ enc: 'mailean-aesgcm-v1' }).error, /encrypted/);
  assert.match(validateState({ schema: 9 }).error, /not a Mailean/);
});

test('sorting is stable with tie-breaks; lookups by id use the index', () => {
  const rows = [
    { key: 'a:4', priority: 3, ts: 10, sender_name: 'Zed' }, { key: 'a:2', priority: 3, ts: 10, sender_name: 'amy' },
    { key: 'a:1', priority: 3, ts: 10, sender_name: 'amy' }, { key: 'a:3', priority: 5, ts: 1, sender_name: 'x' },
    { key: 'a:5', priority: 3, ts: 20, sender_name: 'm' },
  ];
  assert.deepEqual(sortMessages(rows).map((r) => r.key), ['a:3', 'a:5', 'a:1', 'a:2', 'a:4']);
  assert.deepEqual(sortMessages(rows, 'oldest').map((r) => r.key), ['a:3', 'a:1', 'a:2', 'a:4', 'a:5']);
  const state = demo();
  const idx = indexState(state);
  const m = state.messages[17];
  assert.equal(idx.byKey.get(m.key), m);
  assert.equal(idx.byMessageId.get(`${m.account}:${m.message_ids[0]}`), m);
  const f = filterMessages(state.messages, { account: 'account_2', group: 'receipts_finance', hidden: new Set([m.key]) });
  assert.ok(f.every((x) => x.account === 'account_2' && x.group === 'receipts_finance' && x.key !== m.key));
});

test('every dashboard figure matches the Python oracle (second method)', () => {
  const oracle = fixture('../fixtures/dashboard-oracle.json');
  const s = dashboardStats(demo().messages, { timeZone: TZ, now: NOW });
  assert.equal(s.total, oracle.total);
  assert.equal(s.unread, oracle.unread);
  for (const g of s.byGroup) assert.equal(g.value, oracle.by_group[g.key] ?? 0, g.key);
  assert.equal(s.receiptsTotal, oracle.receipts_total_paise);
  for (const mo of s.receiptsByMonth) assert.equal(mo.value, oracle.receipts_by_month[mo.key] ?? 0, mo.key);
  assert.deepEqual(s.weeks.map((w) => [w.key, w.value]), oracle.last8_weeks.map((w) => [w.key, w.value]));
  for (const p of s.byPriority) assert.equal(p.value, oracle.by_priority[p.key] ?? 0);
  assert.equal(s.fyLabel, 'FY 2026-27');
  assert.equal(s.weeks.at(-1).label, 'CW48');
});

test('suggestions never stage anything for suspicious mail', () => {
  const rows = demo().messages;
  const items = suggestionItems(rows);
  const suspicious = new Set(rows.filter((m) => m.suspicious).map((m) => m.key));
  assert.ok(suspicious.size > 0);
  assert.ok(items.every((i) => !i.keys.some((k) => suspicious.has(k))));
  assert.ok(items.every((i) => i.op !== 'unsubscribe' || i.ids.length === 1));
});

test('payloads: merged per op, ordered safe-first, split under limits', () => {
  let n = 0;
  const ids = (k, c) => Array.from({ length: c }, (_, i) => `${k}${String(i).padStart(10, '0')}`);
  const items = [
    { account: 'account_1', op: 'delete', ids: ids('d', 3) },
    { account: 'account_1', op: 'archive', ids: ids('a', 2) },
    { account: 'account_1', op: 'archive', ids: ids('a', 3) },
    { account: 'account_2', op: 'move_to_label', ids: ids('m', 2), label: 'Receipts' },
  ];
  const [p] = buildPayloads(items, () => `b-20261126-031400-t${n++}abcd`);
  assert.deepEqual(p.commands.map((c) => [c.op, c.ids.length]), [['move_to_label', 2], ['archive', 3], ['delete', 3]]);
  const big = buildPayloads([{ account: 'account_1', op: 'archive', ids: ids('x', 7000) }], () => `b-20261126-031400-t${n++}abcd`);
  assert.ok(big.length >= 2);
  for (const pl of big) {
    assert.ok(JSON.stringify(pl).length <= LIMITS.payloadChars);
    assert.ok(pl.commands.reduce((s, c) => s + c.ids.length, 0) <= LIMITS.ids);
  }
  assert.equal(big.reduce((s, pl) => s + pl.commands.reduce((t, c) => t + c.ids.length, 0), 0), 7000);
  assert.match(newBatchId(NOW, () => 0.5), /^b-20261126-030000-[a-z0-9]{6}$/);
  assert.match(validateLabel('').error, /Type a label/);
  assert.equal(itemError({ account: 'account_1', op: 'archive', ids: ['abc123'] }, new Set(['account_1'])), null);
  assert.match(itemError({ account: 'account_1', op: 'archive', ids: ['a b'] }, new Set(['account_1'])), /malformed/);
});

test('WebCrypto decrypts what Python encrypted (cross-language check)', async () => {
  const blob = fixture('../fixtures/encrypted-state.json');
  const plain = await decryptState(blob, 'fixture passphrase 1');
  assert.deepEqual(plain, { hello: 'world', amount_paise: 12345678 });
  await assert.rejects(decryptState(blob, 'wrong one'), /Wrong passphrase/);
});
