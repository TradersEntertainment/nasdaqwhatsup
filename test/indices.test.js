import test from 'node:test';
import assert from 'node:assert/strict';
import { INDICES, indexDef, weightShares, DEFAULT_INDEX } from '../shared/indices.js';
import { buildIndexMetrics, computeWeights } from '../shared/metrics.js';

test('kutuk: uc endeks, dogru agirlik semalari', () => {
  assert.equal(INDICES.ndx.weighting, 'cap');
  assert.equal(INDICES.spx.weighting, 'cap');
  assert.equal(INDICES.dji.weighting, 'price', 'Dow FIYAT agirliklidir');
  assert.equal(DEFAULT_INDEX, 'ndx');
});

test('indexDef: bilinmeyen anahtar varsayilana duser', () => {
  assert.equal(indexDef('spx').key, 'spx');
  assert.equal(indexDef('SPX').key, 'spx', 'buyuk harf kabul');
  assert.equal(indexDef('yok').key, 'ndx');
  assert.equal(indexDef(null).key, 'ndx');
});

test('weightShares: fiyat agirlikli endekste pay adedi daima 1', () => {
  assert.equal(weightShares('price', { shares: 9e9, marketCap: 1e12, price: 300 }), 1);
});

test('weightShares: kap agirlikli — gercek pay adedi varsa o kullanilir', () => {
  assert.equal(weightShares('cap', { shares: 1234, marketCap: 1e12, price: 100 }), 1234);
});

test('weightShares: gercek pay adedi yoksa piyasa degerinden turetilir', () => {
  // 2 trilyon / 200 dolar = 10 milyar pay
  assert.equal(weightShares('cap', { marketCap: 2e12, price: 200 }), 1e10);
});

test('weightShares: turetilemezse null (uydurma yok)', () => {
  assert.equal(weightShares('cap', { price: 100 }), null);
  assert.equal(weightShares('cap', { marketCap: 1e9 }), null);
  assert.equal(weightShares('cap', { marketCap: 0, price: 0 }), null);
  assert.equal(weightShares('cap', {}), null);
});

/* ---------------- Dow'un fiyat agirligi ---------------- */

test('payAdedi=1 ile agirliklar FIYAT oranina esit olur', () => {
  const rows = [
    { symbol: 'A', shares: 1, baseline: 300, price: 300 },
    { symbol: 'B', shares: 1, baseline: 100, price: 100 },
    { symbol: 'C', shares: 1, baseline: 100, price: 100 },
  ];
  const { weights } = computeWeights(rows);
  assert.ok(Math.abs(weights[0] - 300 / 500) < 1e-12, 'pahali hisse endeksin %60\'i');
  assert.ok(Math.abs(weights[1] - 100 / 500) < 1e-12);
});

test('fiyat agirlikli endeks getirisi = ΔΣP / ΣP (Dow ozdesligi)', () => {
  // Dow: DJIA = ΣP/D. Bolen sadelesir, bilinmesine gerek yok.
  const rows = [
    { symbol: 'A', shares: 1, baseline: 300, price: 306 },   // +6
    { symbol: 'B', shares: 1, baseline: 100, price: 98 },    // −2
    { symbol: 'C', shares: 1, baseline: 200, price: 201 },   // +1
  ];
  const m = buildIndexMetrics({ rows, ndxBase: 47000, sessionStartUtc: 0 });

  const sumBase = 300 + 100 + 200;
  const beklenen = ((6 - 2 + 1) / sumBase) * 100;
  assert.ok(Math.abs(m.index.changePct - beklenen) < 1e-9,
    `${m.index.changePct} ≠ ${beklenen}`);

  // Σ katki = endeks hareketi ozdesligi fiyat agirliginda da tam gecerli.
  const toplam = m.constituents.reduce((s, c) => s + c.contribPp, 0);
  assert.ok(Math.abs(toplam - m.index.changePct) < 1e-9);
});

test('fiyat agirliginda EN PAHALI hisse en cok tasir, en buyuk sirket degil', () => {
  // B'nin sirketi 100 kat buyuk olsa bile fiyat agirliginda onemi yok.
  const rows = [
    { symbol: 'PAHALI', shares: 1, baseline: 500, price: 510 },  // +%2
    { symbol: 'UCUZ', shares: 1, baseline: 50, price: 51.5 },    // +%3
  ];
  const m = buildIndexMetrics({ rows, ndxBase: 47000, sessionStartUtc: 0 });
  assert.equal(m.carriers[0].s, 'PAHALI',
    'daha az yuzde kazanan pahali hisse yine de daha cok tasir');
});
