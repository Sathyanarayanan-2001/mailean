// Email reader helpers. Expected values are hand-worked; the saved-text check is
// also run against texts the Python agent wrote (docs/demo-bodies.json), a second method.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkSegments, gmailLink, gmailSearch, formatBytes, validateBody, validateManifest, conversationOrder } from '../../docs/js/mailtext.js';
import { validateState } from '../../docs/js/model.js';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('linkSegments makes only http(s) links, trims trailing punctuation and keeps every character', () => {
  const text = 'See https://a.test/x). Or javascript:alert(1), data:text/html,hi and http://b.test/p?q=1&r=2.\nEnd';
  const segs = linkSegments(text);
  assert.equal(segs.map((s) => s.value).join(''), text, 'nothing is lost or added');
  const links = segs.filter((s) => s.type === 'link');
  assert.deepEqual(links.map((l) => l.value), ['https://a.test/x', 'http://b.test/p?q=1&r=2']);
  assert.deepEqual(links.map((l) => l.href), ['https://a.test/x', 'http://b.test/p?q=1&r=2']);
  assert.ok(segs.every((s) => s.type === 'text' || /^https?:\/\//.test(s.href)));
  assert.deepEqual(linkSegments('no links here'), [{ type: 'text', value: 'no links here' }]);
  assert.deepEqual(linkSegments(''), []);
});

test('linkSegments shows the real address, so link text cannot disguise where it goes', () => {
  const segs = linkSegments('Pay at https://real.test/pay"onmouseover=x <b>');
  const link = segs.find((s) => s.type === 'link');
  assert.equal(link.value, 'https://real.test/pay');
  assert.equal(link.href, 'https://real.test/pay');
});

test('linkSegments is linear on long input', () => {
  const long = 'x '.repeat(50_000) + 'https://a.test';
  const t = performance.now();
  const segs = linkSegments(long);
  assert.ok(performance.now() - t < 200);
  assert.equal(segs.length, 2);
});

test('gmailLink searches by Message-ID and picks the account', () => {
  assert.equal(gmailLink({ email: 'me@x.test', messageIdHeader: '<abc1@mail.test>', id: '1a00000000000001' }),
    'https://mail.google.com/mail/?authuser=me%40x.test#search/rfc822msgid%3Aabc1%40mail.test');
  assert.equal(gmailLink({ messageIdHeader: '<abc1@mail.test>' }), 'https://mail.google.com/mail/u/0/#search/rfc822msgid%3Aabc1%40mail.test');
  assert.equal(gmailLink({ email: 'me@x.test', messageIdHeader: null, id: '1a00000000000001' }), 'https://mail.google.com/mail/?authuser=me%40x.test#all/1a00000000000001');
  assert.equal(gmailLink({ messageIdHeader: '<bad header>', id: '../x' }), 'https://mail.google.com/mail/');
  // Same form as Gmail Help's own example: rfc822msgid:200503292@example.com (no angle brackets).
  assert.equal(gmailSearch('<abc1@mail.test>'), 'rfc822msgid:abc1@mail.test');
  assert.equal(gmailSearch('abc1@mail.test'), '');
  assert.equal(gmailSearch(null), '');
});

test('formatBytes uses 1 KB = 1,024 bytes (hand-worked)', () => {
  const cases = [[0, '0 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [1048576, '1 MB'], [15 * 1048576, '15 MB'], [1572864, '1.5 MB'], ['x', '0 B']];
  for (const [n, s] of cases) assert.equal(formatBytes(n), s, String(n));
});

test('validateBody keeps known fields with bounded sizes and rejects junk', () => {
  assert.equal(validateBody(null), null);
  assert.equal(validateBody({ text: 5 }), null);
  const b = validateBody({ id: '1a00000000000001', text: 'x'.repeat(30000), from: 'a'.repeat(400), extra: '<script>',
    attachments: [{ name: '', mime: 'application/pdf', size: '12' }, null, ...Array(60).fill({ name: 'f' })] });
  assert.equal(b.text.length, 25000);
  assert.equal(b.from.length, 300);
  assert.equal(b.extra, undefined);
  assert.equal(b.attachments.length, 50);
  assert.deepEqual(b.attachments[0], { name: 'attachment', mime: 'application/pdf', size: 12 });
  assert.equal(b.attachments[1].name, 'attachment');
  assert.equal(validateBody({ id: '../etc', text: '' }).id, '');
});

test('every text the Python agent wrote for the demo passes validateBody unchanged', () => {
  const bodies = read('../../docs/demo-bodies.json');
  const keys = Object.keys(bodies);
  assert.ok(keys.length > 100);
  for (const k of keys) {
    const raw = bodies[k];
    const b = validateBody(raw);
    assert.ok(b, k);
    assert.equal(b.text, raw.text, k);
    assert.equal(b.attachments.length, raw.attachments.length, k);
    assert.equal(k, `${k.split(':')[0]}:${b.id}`);
  }
});

test('demo state rows carry the new reader fields and match the saved texts', () => {
  const { state } = validateState(read('../../docs/demo-state.json'));
  const bodies = read('../../docs/demo-bodies.json');
  assert.equal(state.bodies.stored, true);
  assert.equal(state.bodies.encrypted, false);
  let withFiles = 0;
  for (const m of state.messages) {
    assert.equal(m.has_body, true);
    assert.match(m.message_id_header, /^<[^<>\s]+@[^<>\s]+>$/);
    const total = m.message_ids.reduce((n, id) => n + bodies[`${m.account}:${id}`].attachments.length, 0);
    assert.equal(m.attachments, total, m.key);
    if (total) withFiles++;
  }
  assert.ok(withFiles > 0);
});

test('validateState drops malformed reader fields instead of trusting them', () => {
  const raw = read('../../docs/demo-state.json');
  raw.messages[0].message_id_header = '<script>alert(1)</script>';
  raw.messages[0].attachments = -3;
  raw.messages[1].attachments = 1.5;
  const { state } = validateState(raw);
  const first = state.messages.find((m) => m.id === raw.messages[0].id);
  const second = state.messages.find((m) => m.id === raw.messages[1].id);
  assert.equal(first.message_id_header, null);
  assert.equal(first.attachments, null);
  assert.equal(second.attachments, null);
});

test('validateManifest accepts only safe stored file names', () => {
  const m = validateManifest({ fetched_at: '2026-11-28T10:00:00Z', files: [
    { name: 'a.pdf', mime: 'application/pdf', size: 10, file: '00-a.pdf', encrypted: false },
    { name: 'b.pdf', size: 10, file: '01-b.pdf.enc.json', encrypted: true },
    { name: 'c', file: '../../inbox.json' },
    { name: 'big.zip', file: null, skipped: 'Larger than 15 MB.' },
  ] });
  assert.deepEqual(m.files.map((f) => f.file), ['00-a.pdf', '01-b.pdf.enc.json', null, null]);
  assert.equal(m.files[1].encrypted, true);
  assert.equal(m.files[3].skipped, 'Larger than 15 MB.');
  assert.equal(validateManifest({}), null);
});

test('conversationOrder lists the newest message first and caps at 10', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `1a0000000000${String(i).padStart(4, '0')}`);
  const order = conversationOrder({ id: ids[13], message_ids: ids });
  assert.equal(order.length, 10);
  assert.equal(order[0], ids[13]);
  assert.equal(order[1], ids[12]);
  assert.deepEqual(conversationOrder({ id: 'a1b2c3', message_ids: [] }), ['a1b2c3']);
});
