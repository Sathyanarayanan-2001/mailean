// Merge laws on randomised data, and the two-device scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, merge, mergeAll, tombstone, liveEntries, pickWinner } from '../../docs/js/merge.js';

let seed = 20261126;
const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function randomRecords() {
  const out = {};
  const n = 1 + Math.floor(rand() * 12);
  for (let i = 0; i < n; i++) {
    const key = pick(['q:a', 'q:b', 'q:c', 'l:Receipts', 'l:News', 'h:account_1:abc123', 'b:b-1']);
    const u = 1000 + Math.floor(rand() * 5); // narrow range forces many exact ties
    out[key] = rand() < 0.25 ? tombstone(u) : { u, v: { op: pick(['archive', 'delete']), n: Math.floor(rand() * 3), z: pick([1, 'x', null]) } };
  }
  return out;
}
const same = (a, b) => assert.equal(canonicalJson(a), canonicalJson(b));

test('canonical JSON ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

test('merge is commutative, associative and idempotent (2,000 random trials)', () => {
  for (let i = 0; i < 2000; i++) {
    const a = randomRecords();
    const b = randomRecords();
    const c = randomRecords();
    same(merge(a, b), merge(b, a));
    same(merge(merge(a, b), c), merge(a, merge(b, c)));
    same(merge(a, a), merge(a, {}));
    same(merge(merge(a, b), b), merge(a, b));
  }
});

test('newer update wins; exact tie goes to larger canonical text', () => {
  assert.deepEqual(pickWinner({ u: 2, v: 'old' }, { u: 3, v: 'new' }), { u: 3, v: 'new' });
  const x = { u: 5, v: 'a' };
  const y = { u: 5, v: 'b' };
  assert.equal(pickWinner(x, y), y);
  assert.equal(pickWinner(y, x), y);
  assert.deepEqual(pickWinner({ u: 9, v: 'live' }, tombstone(10)), { d: 1, u: 10 });
  assert.equal(pickWinner(undefined, { nope: 1 }), undefined); // invalid records are ignored
});

test('two devices add at the same time; both keep both; a deletion propagates', () => {
  let phone = { 'q:1': { u: 100, v: { op: 'archive' } } };
  let laptop = { 'q:2': { u: 100, v: { op: 'delete' } } };
  // Each device writes its save file; each then reads the other's file.
  const phoneFile = { ...phone };
  const laptopFile = { ...laptop };
  phone = merge(phone, laptopFile);
  laptop = merge(laptop, phoneFile);
  same(phone, laptop);
  assert.deepEqual(liveEntries(phone).map(([k]) => k).sort(), ['q:1', 'q:2']);
  // The laptop deletes q:1; the tombstone reaches the phone on the next exchange.
  laptop = { ...laptop, 'q:1': tombstone(200) };
  phone = merge(phone, laptop);
  assert.deepEqual(liveEntries(phone).map(([k]) => k), ['q:2']);
  // An older save file arriving late cannot bring the deleted record back.
  phone = mergeAll([phone, phoneFile]);
  assert.deepEqual(liveEntries(phone).map(([k]) => k), ['q:2']);
});
