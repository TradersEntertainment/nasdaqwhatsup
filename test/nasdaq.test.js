/**
 * api.nasdaq.com liste ayristiricisi — ag gerekmez.
 * Ic ice zarf ve alan-adi cesitleri tolere edilmeli; $/virgul temizlenmeli;
 * baz net degisimden (ya da yuzdeden) dogru turetilmeli.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseNasdaqList } from '../server/sources/nasdaq.js';

test('parseMoney: $ virgul % parantez temizler', () => {
  assert.equal(parseMoney('$1,234.56'), 1234.56);
  assert.equal(parseMoney('223.96'), 223.96);
  assert.equal(parseMoney('2.27%'), 2.27);
  assert.equal(parseMoney('-3.45'), -3.45);
  assert.equal(parseMoney('N/A'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(null), null);
});

test('ic ice zarf (data.data.rows) ayristirilir, baz net degisimden turer', () => {
  const json = { data: { data: { rows: [
    { symbol: 'NVDA', companyName: 'NVIDIA Corp Common Stock', lastSalePrice: '$223.96', netChange: '4.97', percentageChange: '2.27%' },
    { symbol: 'AAPL', companyName: 'Apple Inc. Common Stock', lastSalePrice: '$313.33', netChange: '0.92', percentageChange: '0.29%' },
  ] } } };
  const rows = parseNasdaqList(json);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'NVDA');
  assert.equal(rows[0].name, 'NVIDIA Corp');           // " Common Stock..." kirpilir
  assert.equal(rows[0].price, 223.96);
  assert.ok(Math.abs(rows[0].prevClose - (223.96 - 4.97)) < 1e-9);  // baz = fiyat - net
});

test('netChange yoksa baz YUZDEDEN turer', () => {
  const rows = parseNasdaqList({ rows: [
    { symbol: 'MSFT', lastSalePrice: '499.99', percentageChange: '0.03%' },
  ] });
  assert.equal(rows.length, 1);
  const expected = 499.99 / (1 + 0.03 / 100);
  assert.ok(Math.abs(rows[0].prevClose - expected) < 1e-6);
});

test('gecersiz sembol / sifir fiyat elenir, taninmayan sekil bos doner', () => {
  const rows = parseNasdaqList({ rows: [
    { symbol: 'CASH', lastSalePrice: '$0.00' },
    { symbol: '-', lastSalePrice: '$5' },
    { symbol: 'AAPL', lastSalePrice: '$313', netChange: '1' },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'AAPL');
  assert.equal(parseNasdaqList(null).length, 0);
  assert.equal(parseNasdaqList({ foo: 1 }).length, 0);
});
