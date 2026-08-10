/**
 * Finnhub /quote ayristiricisi — ag gerekmez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinnhubQuote } from '../server/sources/finnhub.js';

test('gecerli kotasyon ayristirilir', () => {
  const q = parseFinnhubQuote({ c: 224.1, pc: 219.0, o: 220.5, t: 1754838000, dp: 2.33 });
  assert.equal(q.price, 224.1);
  assert.equal(q.prevClose, 219.0);
  assert.equal(q.open, 220.5);
  assert.equal(q.at, 1754838000 * 1000);
  assert.equal(q.dp, 2.33);
});

test('bos/bilinmeyen sembol (c=0) null doner — Finnhub hatali sembolde sifir dondurur', () => {
  assert.equal(parseFinnhubQuote({ c: 0, pc: 0, o: 0, t: 0 }), null);
  assert.equal(parseFinnhubQuote(null), null);
  assert.equal(parseFinnhubQuote({}), null);
});

test('eksik alanlar null/varsayilanlarla tolere edilir', () => {
  const q = parseFinnhubQuote({ c: 100, pc: 99 });
  assert.equal(q.open, null);
  assert.equal(q.at, null);
  assert.equal(q.dp, null);
});
