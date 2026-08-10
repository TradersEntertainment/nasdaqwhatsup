import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTvEarnings, parseNasdaqEarnings, describe, etDateOf, hintFromTs,
} from '../server/sources/earnings.js';

/** 2026-08-12 20:05 ET (= kapanis sonrasi) icin unix saniye. */
const AMC = Math.floor(Date.parse('2026-08-13T00:05:00Z') / 1000);
/** 2026-08-12 07:00 ET (= acilis oncesi). */
const BMO = Math.floor(Date.parse('2026-08-12T11:00:00Z') / 1000);

test('etDateOf: UTC gecesini ET takvim gunune dogru dusurur', () => {
  // 00:05 UTC = onceki gun 20:05 ET. UTC'ye gore hesaplamak bir gun kaydirirdi.
  assert.equal(etDateOf(AMC), '2026-08-12');
  assert.equal(etDateOf(BMO), '2026-08-12');
});

test('hintFromTs: acilis oncesi / kapanis sonrasi ayrimi', () => {
  assert.equal(hintFromTs(BMO), 'bmo');
  assert.equal(hintFromTs(AMC), 'amc');
  // Gun ortasi ne biri ne digeri.
  assert.equal(hintFromTs(Math.floor(Date.parse('2026-08-12T16:00:00Z') / 1000)), 'unknown');
});

test('hintFromTs: 00:00 yer tutucu saat ipucu sayilmaz', () => {
  const gece = Math.floor(Date.parse('2026-08-12T04:00:00Z') / 1000); // 00:00 ET
  assert.equal(hintFromTs(gece), 'unknown');
});

test('parseTvEarnings: tarih + saat enum\'u', () => {
  const json = { data: [
    { s: 'NASDAQ:AAPL', d: ['AAPL', AMC, 2] },
    { s: 'NASDAQ:MSFT', d: ['MSFT', BMO, 1] },
  ] };
  const m = parseTvEarnings(json, '2026-08-10');
  assert.equal(m.AAPL.dateEt, '2026-08-12');
  assert.equal(m.AAPL.hint, 'amc');
  assert.equal(m.MSFT.hint, 'bmo');
  assert.equal(m.AAPL.source, 'tradingview');
});

test('parseTvEarnings: 3. kolon zaman damgasi olarak da gelebilir', () => {
  const m = parseTvEarnings({ data: [{ s: 'NASDAQ:NVDA', d: ['NVDA', AMC, AMC] }] }, '2026-08-10');
  assert.equal(m.NVDA.exactTs, AMC);
  assert.equal(m.NVDA.hint, 'amc');
});

test('parseTvEarnings: saat bilgisi yoksa tarihin kendisinden cikarilir', () => {
  const m = parseTvEarnings({ data: [{ s: 'NASDAQ:X', d: ['X', AMC, null] }] }, '2026-08-10');
  assert.equal(m.X.hint, 'amc');
});

test('parseTvEarnings: gecmis duyurular elenir', () => {
  const m = parseTvEarnings({ data: [{ s: 'NASDAQ:OLD', d: ['OLD', AMC, 2] }] }, '2026-09-01');
  assert.equal(m.OLD, undefined);
});

test('parseTvEarnings: bozuk govde patlatmaz', () => {
  assert.deepEqual(parseTvEarnings(null, '2026-08-10'), {});
  assert.deepEqual(parseTvEarnings({ data: 'yok' }, '2026-08-10'), {});
  assert.deepEqual(parseTvEarnings({ data: [{ s: 'X', d: ['X', 0, 1] }] }, '2026-08-10'), {});
  assert.deepEqual(parseTvEarnings({ data: [{ s: 'X', d: null }] }, '2026-08-10'), {});
});

test('parseNasdaqEarnings: yalnizca izlenen semboller alinir', () => {
  const json = { data: { rows: [
    { symbol: 'AAPL', time: 'time-after-hours' },
    { symbol: 'ZZZZ', time: 'time-pre-market' },
  ] } };
  const m = parseNasdaqEarnings(json, '2026-08-12', new Set(['AAPL']));
  assert.deepEqual(Object.keys(m), ['AAPL']);
  assert.equal(m.AAPL.hint, 'amc');
});

test('parseNasdaqEarnings: ic ice zarf da desteklenir', () => {
  const json = { data: { data: { rows: [{ symbol: 'MSFT', time: 'time-pre-market' }] } } };
  const m = parseNasdaqEarnings(json, '2026-08-12', new Set(['MSFT']));
  assert.equal(m.MSFT.hint, 'bmo');
});

test('parseNasdaqEarnings: bilinmeyen saat etiketi unknown', () => {
  const json = { data: { rows: [{ symbol: 'A', time: 'time-not-supplied' }] } };
  assert.equal(parseNasdaqEarnings(json, '2026-08-12', new Set(['A'])).A.hint, 'unknown');
});

/* ---------------- describe ---------------- */

const e = (dateEt, hint = 'amc') => ({ dateEt, hint, exactTs: null, source: 't' });

test('describe: bugun / yarin / N gun sonra', () => {
  assert.equal(describe(e('2026-08-10'), '2026-08-10').text, 'Bilanço bugün, kapanış sonrası');
  assert.equal(describe(e('2026-08-11'), '2026-08-10').text, 'Bilanço yarın, kapanış sonrası');
  assert.equal(describe(e('2026-08-13', 'bmo'), '2026-08-10').text, 'Bilanço 3 gün sonra, açılış öncesi');
});

test('describe: saat bilinmiyorsa ifade kisalir', () => {
  assert.equal(describe(e('2026-08-11', 'unknown'), '2026-08-10').text, 'Bilanço yarın');
});

test('describe: inDays dogru', () => {
  assert.equal(describe(e('2026-08-10'), '2026-08-10').inDays, 0);
  assert.equal(describe(e('2026-08-20'), '2026-08-10').inDays, 10);
});

test('describe: gecmis ve ufuk disi null', () => {
  assert.equal(describe(e('2026-08-09'), '2026-08-10'), null);
  assert.equal(describe(e('2026-09-30'), '2026-08-10'), null, '21 gunden uzagi "yakin" degil');
  assert.equal(describe(null, '2026-08-10'), null);
  assert.equal(describe({}, '2026-08-10'), null);
});

test('describe: ay ve yil sinirini asan aralik dogru sayilir', () => {
  assert.equal(describe(e('2026-09-01'), '2026-08-30').inDays, 2);
  assert.equal(describe(e('2027-01-01'), '2026-12-30').inDays, 2);
});
