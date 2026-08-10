/**
 * Kripto kaynaginin saf ayristiricilari — ag gerekmez.
 *
 * Iki borsa da cevap sekillerini degistirebilir; taninmayan sekil sessizce
 * bos veriyle calismak yerine bos dizi doner ve ust katman bunu raporlar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHlMetaCtxs,
  parseBinanceTickers,
  matchMarkets,
  candleBaseline,
} from '../server/sources/crypto.js';

test('HL: paralel universe/ctx dizileri ayristirilir, dex adresi kurulur', () => {
  const json = [
    { universe: [{ name: 'NVDA' }, { name: 'ETH' }, { name: 'DEAD', isDelisted: true }] },
    [
      { markPx: '223.5', prevDayPx: '219.0', dayNtlVlm: '1500000' },
      { markPx: '4200', prevDayPx: '4100', dayNtlVlm: '900000000' },
      { markPx: '1', prevDayPx: '1', dayNtlVlm: '0' },
    ],
  ];
  const main = parseHlMetaCtxs(json, '');
  assert.equal(main.length, 2, 'delisted elenmali');
  assert.equal(main[0].market, 'NVDA');

  const dexed = parseHlMetaCtxs(json, 'km');
  assert.equal(dexed[0].market, 'km:NVDA', 'builder dex coini dex:AD ile adreslenir');
  assert.equal(dexed[0].price, 223.5);
});

test('HL: taninmayan sekil bos doner', () => {
  assert.deepEqual(parseHlMetaCtxs(null), []);
  assert.deepEqual(parseHlMetaCtxs({}), []);
  assert.deepEqual(parseHlMetaCtxs([{ universe: 'x' }, null]), []);
});

test('Binance: yalniz USD-endeksli pariteler, taban sembol cikarilir', () => {
  const rows = parseBinanceTickers([
    { symbol: 'NVDAUSDT', lastPrice: '224.1', openPrice: '220.0', quoteVolume: '5000000' },
    { symbol: 'BTCUSDT', lastPrice: '99000', openPrice: '98000', quoteVolume: '2e9' },
    { symbol: 'ETHBTC', lastPrice: '0.05', openPrice: '0.049', quoteVolume: '1000' },
    { symbol: 'BAD', lastPrice: '0', openPrice: '0', quoteVolume: '0' },
  ]);
  assert.equal(rows.length, 2, 'ETHBTC (USD degil) ve BAD elenmali');
  assert.equal(rows[0].name, 'NVDA');
  assert.equal(rows[0].market, 'NVDAUSDT');
});

test('eslestirme: birebir ad; ayni ad iki yerdeyse hacimli kazanir; loose ayri', () => {
  const markets = [
    { venue: 'hyperliquid', dex: '', name: 'NVDA', rawName: 'NVDA', market: 'NVDA', price: 223, prevDayPx: 220, volume: 100 },
    { venue: 'hyperliquid', dex: 'km', name: 'NVDA', rawName: 'NVDA', market: 'km:NVDA', price: 224, prevDayPx: 221, volume: 900 },
    { venue: 'hyperliquid', dex: '', name: 'XAAPL', rawName: 'xAAPL', market: 'xAAPL', price: 310, prevDayPx: 300, volume: 50 },
    { venue: 'hyperliquid', dex: '', name: 'ETH', rawName: 'ETH', market: 'ETH', price: 4200, prevDayPx: 4100, volume: 1e9 },
  ];
  const { exact, loose } = matchMarkets(markets, ['NVDA', 'AAPL', 'MSFT']);
  assert.equal(exact.size, 1);
  assert.equal(exact.get('NVDA').market, 'km:NVDA', 'hacimli olan secilmeli');
  assert.equal(loose.length, 1, 'XAAPL loose olarak raporlanmali');
  assert.equal(loose[0].matches, 'AAPL');
});

test('mum bazi: seans baslangicindan KESINLIKLE onceki son kapanis', () => {
  const start = 1_000_000;
  const candles = [
    { t: start - 600_000, c: 100 },
    { t: start - 300_000, c: 101 },   // <- bu
    { t: start, c: 999 },             // tam sinirda: YENI seansin bari
    { t: start + 300_000, c: 102 },
  ];
  const b = candleBaseline(candles, start);
  assert.equal(b.baseline, 101);
  assert.equal(b.at, start - 300_000);
  assert.equal(candleBaseline([], start), null);
});
