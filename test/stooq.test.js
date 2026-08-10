/**
 * Stooq ayristiricilari — ag gerekmez. CSV bicimi degisirse ya da "N/D"
 * satirlari sizarsa burada yakalanir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toStooqSymbol,
  fromStooqSymbol,
  parseQuoteCsv,
  parseDailyCsv,
  pickPrevClose,
  buildQuoteUrl,
} from '../server/sources/stooq.js';

test('kotasyon URL: virguller LITERAL, %2C yok — uretimdeki 404 regresyonu', () => {
  const url = buildQuoteUrl(['NVDA', 'AAPL', '^NDX']);
  assert.ok(url.includes('s=nvda.us,aapl.us,^ndx'), url);
  assert.ok(!url.includes('%2C'), 'encodeURIComponent geri gelmis: ' + url);
  assert.ok(url.endsWith('&f=sd2t2ohlcv&h&e=csv'));
  // Ayrac parametreli cesit: '+' PHP tarzi sunucularda bosluk cozulur.
  const plus = buildQuoteUrl(['NVDA', 'AAPL'], '+');
  assert.ok(plus.includes('s=nvda.us+aapl.us'), plus);
});

test('sembol cevrimi gidis-donus', () => {
  assert.equal(toStooqSymbol('NVDA'), 'nvda.us');
  assert.equal(toStooqSymbol('^NDX'), '^ndx');
  assert.equal(fromStooqSymbol('NVDA.US'), 'NVDA');
  assert.equal(fromStooqSymbol('^ndx'), '^NDX');
  for (const s of ['AAPL', 'GOOGL', '^NDX']) {
    assert.equal(fromStooqSymbol(toStooqSymbol(s)), s);
  }
});

test('kotasyon CSV: baslik atlanir, N/D elenir, ^NDX eslenir', () => {
  const csv = [
    'Symbol,Date,Time,Open,High,Low,Close,Volume',
    'NVDA.US,2026-08-10,17:45:12,220.10,225.00,219.50,223.96,12345678',
    'AAPL.US,2026-08-10,17:45:12,N/D,N/D,N/D,N/D,N/D',
    '^NDX,2026-08-10,17:45:12,25350.00,25500.00,25300.00,25460.50,0',
    '',
  ].join('\n');
  const m = parseQuoteCsv(csv);
  assert.equal(m.size, 2, 'N/D satiri elenmali');
  assert.equal(m.get('NVDA').price, 223.96);
  assert.equal(m.get('NVDA').date, '2026-08-10');
  assert.equal(m.get('NVDA').open, 220.10);
  assert.equal(m.get('^NDX').price, 25460.50);
});

test('kotasyon CSV: taninmayan govde bos doner (limit uyarisi vb.)', () => {
  assert.equal(parseQuoteCsv('Exceeded the daily hits limit').size, 0);
  assert.equal(parseQuoteCsv('').size, 0);
  assert.equal(parseQuoteCsv('<html>hata</html>').size, 0);
});

test('gunluk CSV ayristirilir ve onceki kapanis KESINLIKLE onceki gunden secilir', () => {
  const csv = [
    'Date,Open,High,Low,Close,Volume',
    '2026-08-06,215,218,214,216.5,1000',
    '2026-08-07,216,220,215,219.0,1200',
    '2026-08-10,220,224,219,223.9,1500',  // usDate'in kendisi — SECILMEMELI
  ].join('\n');
  const rows = parseDailyCsv(csv);
  assert.equal(rows.length, 3);
  const prev = pickPrevClose(rows, '2026-08-10');
  assert.equal(prev.date, '2026-08-07', 'hafta sonunu atlayip son islem gunune gitmeli');
  assert.equal(prev.close, 219.0);
  assert.equal(pickPrevClose(rows, '2026-08-06'), null, 'daha eski gun yoksa null');
});
