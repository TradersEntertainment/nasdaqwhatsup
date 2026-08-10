/**
 * Kismi-kapsam (kripto yedegi) semantigi.
 *
 * Kural: 12 hisseyle "%62 kirmizi" ILAN EDILEMEZ. Kapsam kismi oldugunda
 * hukum PARTIAL'a sabitlenir, endekse yaklasik katki kapsanan agirlikla
 * olceklenir ve dusuk esik degismezleri bozmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../server/pipeline/build-snapshot.js';

const NOW = Date.parse('2026-08-11T18:00:00+03:00');

function makeRows(n = 10) {
  return Array.from({ length: n }, (_, k) => ({
    symbol: `S${k}`,
    name: `Hisse ${k}`,
    shares: 1000 / (100 + k),
    baseline: 100 + k,
    price: (100 + k) * (1 + (k % 3 === 0 ? 0.02 : -0.005)),
    open: null,
    lastTradeAtUtc: NOW - 60_000,
    baselineAtUtc: NOW - 86_400_000,
    baselineSource: 'hl-candle',
  }));
}

test('kismi kapsamda hukum PARTIAL olur, QUIET/MASKED degil', () => {
  const { snapshot, errors } = buildSnapshot({
    rows: makeRows(10),
    ndxBase: 25400,
    nowUtc: NOW,
    coverage: { partial: true, count: 10, total: 101, weightPct: 66, venue: 'hyperliquid' },
    quality: { source: 'crypto-hyperliquid', warnings: ['crypto-partial'] },
    minConstituents: 5,
  });
  assert.deepEqual(errors, []);
  assert.equal(snapshot.verdict.verdict, 'PARTIAL');
  assert.equal(snapshot.coverage.partial, true);
  assert.equal(snapshot.coverage.venue, 'hyperliquid');
});

test('endekse yaklasik katki = altKumeGetirisi x kapsananAgirlik', () => {
  const { snapshot } = buildSnapshot({
    rows: makeRows(10),
    ndxBase: 25400,
    nowUtc: NOW,
    coverage: { partial: true, count: 10, total: 101, weightPct: 66 },
    quality: {},
    minConstituents: 5,
  });
  const expected = +(snapshot.index.changePct * 0.66).toFixed(3);
  assert.equal(snapshot.coverage.contribPpNdx, expected);
});

test('agirlik bilinmiyorsa katki uydurulmaz', () => {
  const { snapshot } = buildSnapshot({
    rows: makeRows(10),
    ndxBase: 25400,
    nowUtc: NOW,
    coverage: { partial: true, count: 10, total: 101, weightPct: null },
    quality: {},
    minConstituents: 5,
  });
  assert.equal(snapshot.coverage.contribPpNdx, undefined);
});

test('tam kapsamda coverage null kalir ve hukum normal calisir', () => {
  const { snapshot } = buildSnapshot({
    rows: makeRows(100),
    ndxBase: 25400,
    nowUtc: NOW,
    quality: {},
    minConstituents: 85,
  });
  assert.equal(snapshot.coverage, null);
  assert.notEqual(snapshot.verdict.verdict, 'PARTIAL');
});
