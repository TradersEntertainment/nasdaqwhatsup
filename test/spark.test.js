/**
 * Spark cevabinin ayristirilmasi. Ag cagrisi yok — uc iki farkli sekil
 * dondurebiliyor ve ikisini de tanimak zorundayiz; tanimazsak site sessizce
 * bos veriyle calisir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpark } from '../server/sources/yahoo.js';

test('sekil A: sembolle anahtarlanmis duz nesne', () => {
  const m = normalizeSpark({
    AAPL: { symbol: 'AAPL', timestamp: [1, 2], close: [10, 11], chartPreviousClose: 9 },
    MSFT: { symbol: 'MSFT', timestamp: [1], close: [20], previousClose: 19 },
  });
  assert.equal(m.size, 2);
  assert.deepEqual(m.get('AAPL').close, [10, 11]);
  assert.equal(m.get('AAPL').prevClose, 9);
  assert.equal(m.get('MSFT').prevClose, 19);
});

test('sekil B: spark.result sarmalayicisi', () => {
  const m = normalizeSpark({
    spark: {
      result: [{
        symbol: 'NVDA',
        response: [{
          meta: { chartPreviousClose: 100 },
          timestamp: [1, 2, 3],
          indicators: { quote: [{ close: [101, 102, 103] }] },
        }],
      }],
    },
  });
  assert.equal(m.size, 1);
  assert.deepEqual(m.get('NVDA').ts, [1, 2, 3]);
  assert.equal(m.get('NVDA').prevClose, 100);
});

test('taninmayan sekil sessizce cokmez, bos doner', () => {
  assert.equal(normalizeSpark(null).size, 0);
  assert.equal(normalizeSpark({}).size, 0);
  assert.equal(normalizeSpark({ finance: { error: 'nope' } }).size, 0);
  assert.equal(normalizeSpark('metin').size, 0);
});

test('eksik dizileri olan girdiler atlanir', () => {
  const m = normalizeSpark({
    AAPL: { symbol: 'AAPL', timestamp: [1], close: [10] },
    BAD: { symbol: 'BAD', timestamp: null, close: null },
  });
  assert.equal(m.size, 1);
  assert.ok(m.has('AAPL'));
});
