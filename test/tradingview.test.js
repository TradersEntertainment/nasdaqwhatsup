import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScan, toSessionRow, COLUMNS_FULL, COLUMNS_MIN,
} from '../server/sources/tradingview.js';

/** COLUMNS_FULL sirasina gore `d` dizisi kurar. */
function d(vals) {
  return COLUMNS_FULL.map((c) => (c in vals ? vals[c] : null));
}

test('parseScan: kolon sirasini alanlara dogru esler', () => {
  const json = { data: [{ s: 'NASDAQ:AAPL', d: d({
    name: 'AAPL', close: 226.4, change: 1.2, change_abs: 2.7, open: 224,
    volume: 5e7, premarket_close: 227.1, premarket_change: 0.31,
    premarket_volume: 12000, postmarket_close: 225.9, postmarket_change: -0.22,
    postmarket_volume: 8000,
  }) }] };
  const m = parseScan(json, COLUMNS_FULL);
  assert.equal(m.size, 1);
  const r = m.get('AAPL');
  assert.equal(r.close, 226.4);
  assert.equal(r.changeAbs, 2.7);
  assert.equal(r.preClose, 227.1);
  assert.equal(r.postVolume, 8000);
});

test('parseScan: asgari kolon setinde uzatilmis alanlar null kalir', () => {
  const row = COLUMNS_MIN.map((c) => ({
    name: 'MSFT', close: 500, change: 1, change_abs: 5, open: 496, volume: 1e7,
  })[c]);
  const m = parseScan({ data: [{ s: 'NASDAQ:MSFT', d: row }] }, COLUMNS_MIN);
  const r = m.get('MSFT');
  assert.equal(r.close, 500);
  assert.equal(r.preClose, null, 'istenmemis kolon null olmali, 0 degil');
  assert.equal(r.postVolume, null);
});

test('parseScan: OTC/yabanci borsa kopyalari elenir', () => {
  const json = { data: [
    { s: 'OTC:AAPL', d: d({ name: 'AAPL', close: 1, volume: 9e9 }) },
    { s: 'NASDAQ:AAPL', d: d({ name: 'AAPL', close: 226, volume: 100 }) },
  ] };
  const m = parseScan(json, COLUMNS_FULL);
  assert.equal(m.get('AAPL').close, 226, 'OTC kopyasi hacmi buyuk olsa da kazanmamali');
});

test('parseScan: ayni sembol iki iyi borsada ise en hacimlisi kazanir', () => {
  const json = { data: [
    { s: 'NYSE:XYZ', d: d({ name: 'XYZ', close: 10, volume: 100 }) },
    { s: 'NASDAQ:XYZ', d: d({ name: 'XYZ', close: 11, volume: 900 }) },
  ] };
  assert.equal(parseScan(json, COLUMNS_FULL).get('XYZ').close, 11);
});

test('parseScan: bozuk govde bos harita dondurur', () => {
  assert.equal(parseScan(null, COLUMNS_FULL).size, 0);
  assert.equal(parseScan({ data: 'yok' }, COLUMNS_FULL).size, 0);
  assert.equal(parseScan({ data: [{ s: 'NASDAQ:A', d: null }] }, COLUMNS_FULL).size, 0);
});

/* ---------------- faz mantigi: bu dosyanin asil konusu ---------------- */

const rec = {
  close: 100, change: 2, changeAbs: 2, open: 99, volume: 1e6,
  preClose: 103, preChange: 3, preVolume: 5000,
  postClose: 101, postChange: 1, postVolume: 4000,
};

test('REGULAR: baz = close - change_abs, fiyat = close', () => {
  const r = toSessionRow(rec, 'REGULAR');
  assert.equal(r.baseline, 98);
  assert.equal(r.price, 100);
  assert.equal(r.traded, true);
});

test('AFTER_HOURS: baz hala onceki kapanis, fiyat post-market', () => {
  const r = toSessionRow(rec, 'AFTER_HOURS');
  assert.equal(r.baseline, 98, 'ana seans BU TSI gunu icinde bitti — baz dun');
  assert.equal(r.price, 101);
});

test('PRE: `close` ONCEKI kapanistir — bazdan change_abs DUSULMEZ', () => {
  const r = toSessionRow(rec, 'PRE');
  assert.equal(r.baseline, 100, 'pre-market\'te close zaten TSI bazi');
  assert.equal(r.price, 103);
  // Bir gunluk kayma regresyonu: 98 cikarsa dunku hareket bugune yaziliyor.
  assert.notEqual(r.baseline, 98);
});

test('CARRY_AFTER_HOURS: TSI gunu onceki seansin uzatilmis islemiyle baslar', () => {
  const r = toSessionRow(rec, 'CARRY_AFTER_HOURS');
  assert.equal(r.baseline, 100);
  assert.equal(r.price, 101);
  assert.equal(r.traded, true, 'post hacmi > 0');
});

test('OVERNIGHT: donmus post-market fiyati korunur', () => {
  const r = toSessionRow(rec, 'OVERNIGHT');
  assert.equal(r.baseline, 100);
  assert.equal(r.price, 101);
});

test('uzatilmis seans hacmi 0 ise islemYok kovasina duser', () => {
  const q = { ...rec, postVolume: 0, postClose: 100 };
  assert.equal(toSessionRow(q, 'CARRY_AFTER_HOURS').traded, false);
  const p = { ...rec, preVolume: 0, preClose: 100 };
  assert.equal(toSessionRow(p, 'PRE').traded, false);
});

test('hacim alani yoksa fiyat-baz esitligine dusulur', () => {
  const q = { ...rec, postVolume: null, postClose: 100 };
  assert.equal(toSessionRow(q, 'OVERNIGHT').traded, false);
  const q2 = { ...rec, postVolume: null, postClose: 101 };
  assert.equal(toSessionRow(q2, 'OVERNIGHT').traded, true);
});

test('WEEKEND: islem penceresi olan TSI gununde post fiyati kalir', () => {
  const r = toSessionRow(rec, 'WEEKEND', true);
  assert.equal(r.price, 101);
  assert.equal(r.baseline, 100);
});

test('WEEKEND: hic islem penceresi yoksa fiyat baza esitlenir', () => {
  const r = toSessionRow(rec, 'WEEKEND', false);
  assert.equal(r.price, 100);
  assert.equal(r.traded, false, 'Pazar gunu Cuma hareketini bugunmus gibi gosterme');
});

test('change_abs yoksa yuzdeden baz turetilir', () => {
  const q = { close: 110, change: 10, changeAbs: null };
  // Bolme yolu kayan nokta tasir (99.999...); esiklik degil yakinlik aranir.
  assert.ok(Math.abs(toSessionRow(q, 'REGULAR').baseline - 100) < 1e-9);
});

test('degisim bilgisi hic yoksa REGULAR bazi close olur (duz)', () => {
  const q = { close: 110, change: null, changeAbs: null };
  const r = toSessionRow(q, 'REGULAR');
  assert.equal(r.baseline, 110);
  assert.equal(r.price, 110);
});

test('change = -100 sifira bolmeye yol acmaz', () => {
  const q = { close: 5, change: -100, changeAbs: null };
  assert.equal(toSessionRow(q, 'REGULAR').baseline, 5);
});

test('gecersiz kayit null doner', () => {
  assert.equal(toSessionRow(null, 'REGULAR'), null);
  assert.equal(toSessionRow({ close: 0 }, 'REGULAR'), null);
  assert.equal(toSessionRow({ close: -3 }, 'REGULAR'), null);
});

test('uzatilmis fiyat bozuksa ana seans kapanisina dusulur', () => {
  const q = { ...rec, postClose: 0 };
  assert.equal(toSessionRow(q, 'OVERNIGHT').price, 100);
});
