// Money, dates, FY and ISO weeks. Expected values are hand-worked, and the
// calendar is also checked against Python's zoneinfo/isocalendar (second method).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  formatInr, parseInrToPaise, formatRupees, formatCount, isoWeekOfYmd, isoWeek, cwLabel, fyLabel, localParts,
  formatDate, formatTime, formatDateTime, parseDayFirst, zonedMidnight, escapeHtml, safeUrl, formatWhen,
} from '../../docs/js/format.js';

const TZ = 'Asia/Kolkata';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

test('formatInr uses lakh grouping (hand-worked)', () => {
  const cases = [[12345678, '1,23,456.78'], [0, '0.00'], [5, '0.05'], [100000, '1,000.00'], [10000000, '1,00,000.00'],
    [1000000001, '1,00,00,000.01'], [-249900, '-2,499.00'], [99, '0.99']];
  for (const [p, s] of cases) assert.equal(formatInr(p), s);
  assert.equal(formatRupees(12345678), '₹1,23,456.78');
  assert.equal(formatCount(123456), '1,23,456');
  assert.throws(() => formatInr(1.5));
});

test('parseInrToPaise is exact and strict', () => {
  const ok = [['1,23,456.78', 12345678], ['₹1,23,456.78', 12345678], ['Rs. 2,499', 249900], ['INR 0.5', 50], ['-12.30', -1230], ['123456.78', 12345678]];
  for (const [s, p] of ok) assert.equal(parseInrToPaise(s), p, s);
  for (const bad of ['', 'abc', '1.234', '1e5', null, '₹', '12,34x']) assert.equal(parseInrToPaise(bad), null, String(bad));
});

test('money round trip on random values and exact totals', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 5000; i++) {
    const p = Math.floor((rand() - 0.5) * 2e12);
    assert.equal(parseInrToPaise(formatInr(p)), p);
  }
  // 0.1 + 0.2 in floats is 0.30000000000000004; in paise it is exactly 30.
  assert.equal(['0.10', '0.20'].map(parseInrToPaise).reduce((a, b) => a + b), 30);
  assert.equal(formatInr(['0.10', '0.20', '1,23,456.78', '99,999.99'].map(parseInrToPaise).reduce((a, b) => a + b)), '2,23,457.07');
});

test('ISO weeks: week 53 and year turns (hand-worked)', () => {
  assert.deepEqual(isoWeekOfYmd(2026, 12, 31), { year: 2026, week: 53 }); // Thursday
  assert.deepEqual(isoWeekOfYmd(2027, 1, 1), { year: 2026, week: 53 });   // Friday belongs to 2026-W53
  assert.deepEqual(isoWeekOfYmd(2027, 1, 3), { year: 2026, week: 53 });   // Sunday
  assert.deepEqual(isoWeekOfYmd(2027, 1, 4), { year: 2027, week: 1 });    // Monday
  assert.deepEqual(isoWeekOfYmd(2026, 11, 26), { year: 2026, week: 48 });
  assert.deepEqual(isoWeekOfYmd(2024, 12, 30), { year: 2025, week: 1 });  // Monday in next ISO year
  assert.equal(cwLabel({ year: 2026, week: 8 }), 'CW08');
});

test('financial year boundary and midnight crossing in IST', () => {
  // 18:29:59Z on 31 March is 23:59:59 IST, still FY 2025-26; one second later is 1 April.
  assert.equal(fyLabel(new Date('2026-03-31T18:29:59Z'), TZ), 'FY 2025-26');
  assert.equal(fyLabel(new Date('2026-03-31T18:30:00Z'), TZ), 'FY 2026-27');
  assert.equal(formatDateTime(new Date('2026-03-31T18:30:00Z'), TZ), '01/04/2026 00:00');
  assert.equal(formatDate(new Date('2024-02-29T00:00:00Z'), TZ), '29/02/2024');
  assert.equal(formatTime(new Date('2026-11-26T15:44:00Z'), TZ), '21:14'); // 24-hour clock
  // Month end: 30 Nov 20:00Z is 01 Dec 01:30 IST.
  assert.equal(formatDate(new Date('2026-11-30T20:00:00Z'), TZ), '01/12/2026');
});

test('calendar matches Python zoneinfo + isocalendar on 610 dates (second method)', () => {
  const cases = fixture('calendar-oracle.json');
  assert.ok(cases.length >= 600);
  for (const c of cases) {
    const d = new Date(c.utc);
    assert.equal(formatDateTime(d, TZ), c.local, c.utc);
    const w = isoWeek(d, TZ);
    assert.deepEqual([w.year, w.week], [c.iso_year, c.iso_week], c.utc);
    const fy = fyLabel(d, TZ);
    assert.equal(fy, `FY ${c.fy_start}-${String((c.fy_start + 1) % 100).padStart(2, '0')}`, c.utc);
  }
});

test('typed dates are day first, with leap-year checks', () => {
  const today = { y: 2026, m: 11, d: 26 };
  assert.deepEqual(parseDayFirst('28/10', today), { y: 2026, m: 10, d: 28 });
  assert.deepEqual(parseDayFirst('28/12', today), { y: 2025, m: 12, d: 28 });  // most recent past 28 Dec
  assert.deepEqual(parseDayFirst('29/02/2028', today), { y: 2028, m: 2, d: 29 });
  assert.match(parseDayFirst('29/02/2026', today).error, /not a leap year/);
  assert.match(parseDayFirst('10/28', today).error, /Month 28/);
  assert.match(parseDayFirst('yesterday', today).error, /day first/);
  assert.deepEqual(parseDayFirst('1-4-26', today), { y: 2026, m: 4, d: 1 });
  // Local midnight 01/04/2026 IST is 31/03/2026 18:30 UTC.
  assert.equal(new Date(zonedMidnight({ y: 2026, m: 4, d: 1 }, TZ)).toISOString(), '2026-03-31T18:30:00.000Z');
});

test('escaping and safe links', () => {
  assert.equal(escapeHtml('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(safeUrl('https://news.test/u?a=1'), 'https://news.test/u?a=1');
  assert.equal(safeUrl('mailto:x@y.test'), 'mailto:x@y.test');
});

test('formatWhen shows time today, day/month this year', () => {
  const now = new Date('2026-11-26T06:00:00Z');
  assert.equal(formatWhen(new Date('2026-11-26T03:14:00Z'), now, TZ), '08:44');
  assert.equal(formatWhen(new Date('2026-10-28T03:14:00Z'), now, TZ), '28/10');
  assert.equal(formatWhen(new Date('2025-10-28T03:14:00Z'), now, TZ), '28/10/2025');
  assert.equal(localParts('nonsense', TZ), null);
});
