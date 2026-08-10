import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOWS, MAX_WINDOW_MS, pickFrame, windowAttribution, buildWindows,
} from '../shared/windows.js';

const T = 1_800_000_000_000;
const frames = [
  { t: T - 240 * 60_000, p: { A: 100, B: 100, C: 100 } },   // 4 sa once
  { t: T - 60 * 60_000, p: { A: 100, B: 100, C: 100 } },    // 1 sa once
  { t: T - 15 * 60_000, p: { A: 100, B: 100, C: 100 } },
  { t: T - 5 * 60_000, p: { A: 100, B: 100, C: 100 } },
  { t: T - 60_000, p: { A: 100, B: 100, C: 100 } },
];

test('WINDOWS: istenen bes pencere, kisadan uzuna', () => {
  assert.deepEqual(WINDOWS.map((w) => w.key), ['m1', 'm5', 'm15', 'h1', 'h4']);
  assert.equal(MAX_WINDOW_MS, 4 * 3600_000);
});

test('pickFrame: hedeften ONCEKI en yeni kareyi secer', () => {
  const hit = pickFrame(frames, T, 5 * 60_000);
  assert.equal(hit.frame.t, T - 5 * 60_000);
  assert.equal(hit.actualMs, 5 * 60_000);
  assert.equal(hit.approx, false);
});

test('pickFrame: pencere istenenden KISA olmaz', () => {
  // 3 dakikalik bir pencere istense, 1 dk'lik kare degil 5 dk'lik kare secilir.
  const hit = pickFrame(frames, T, 3 * 60_000);
  assert.ok(hit.actualMs >= 3 * 60_000, 'secilen kare hedeften eski olmali');
});

test('pickFrame: yeterince eski kare yoksa null — uydurmaz', () => {
  const kisa = [{ t: T - 60_000, p: {} }];
  assert.equal(pickFrame(kisa, T, 4 * 3600_000), null);
  assert.equal(pickFrame([], T, 60_000), null);
  assert.equal(pickFrame(null, T, 60_000), null);
});

test('pickFrame: hedefin %50 kadarina ulasan en eski kare kabul, approx isaretli', () => {
  const yari = [{ t: T - 40 * 60_000, p: {} }];
  const hit = pickFrame(yari, T, 60 * 60_000);
  assert.ok(hit, '40 dk, 1 saatin yarisindan fazla — kullanilabilir');
  assert.equal(hit.approx, true, 'gercek aralik sapiyorsa soylenmeli');
  assert.equal(hit.actualMs, 40 * 60_000);
});

/* ---------------- katki ozdesligi ---------------- */

const rows = [
  { symbol: 'A', name: 'A Corp', shares: 1000, price: 110 },  // +10%
  { symbol: 'B', name: 'B Corp', shares: 500, price: 95 },    // −5%
  { symbol: 'C', name: 'C Corp', shares: 200, price: 100 },   //  0%
];
const past = new Map([['A', 100], ['B', 100], ['C', 100]]);

test('Σ katkiPp = endeks % (temel ozdeslik)', () => {
  const a = windowAttribution({ rows, past, ndxBase: 20000 });
  const sum = [...a.carriers, ...a.draggers].reduce((s, c) => s + c.contribPp, 0);
  assert.ok(Math.abs(sum - a.changePct) < 1e-9, `${sum} ≠ ${a.changePct}`);
});

test('agirliklar PENCERE BASINDAKI fiyattan hesaplanir', () => {
  // MV: A=100k, B=50k, C=20k → toplam 170k
  const a = windowAttribution({ rows, past, ndxBase: 0 });
  const A = a.carriers.find((c) => c.s === 'A');
  assert.ok(Math.abs(A.w - 100000 / 170000) < 1e-12);
  // Endeks: (100k*1.10 + 50k*0.95 + 20k*1.00) / 170k − 1
  const beklenen = ((110000 + 47500 + 20000) / 170000 - 1) * 100;
  assert.ok(Math.abs(a.changePct - beklenen) < 1e-9);
});

test('pay adedi olcegi sonucu degistirmez (normalizasyon)', () => {
  const olcekli = rows.map((r) => ({ ...r, shares: r.shares * 1e6 }));
  const a = windowAttribution({ rows, past, ndxBase: 0 });
  const b = windowAttribution({ rows: olcekli, past, ndxBase: 0 });
  assert.ok(Math.abs(a.changePct - b.changePct) < 1e-9);
});

test('tasiyici/dusurucu ayrimi ve siralamasi', () => {
  const a = windowAttribution({ rows, past, ndxBase: 0 });
  assert.deepEqual(a.carriers.map((c) => c.s), ['A']);
  assert.deepEqual(a.draggers.map((c) => c.s), ['B']);
  assert.equal(a.up, 1);
  assert.equal(a.down, 1);
  assert.equal(a.flat, 1, 'kipirdamayanlar ayri kovada');
});

test('pay yuzdesi kendi tarafinin brut havuzuna gore (endeks ~0 iken patlamaz)', () => {
  // A +%1, B −%1, esit agirlik → endeks ~0 ama paylar tanimli olmali.
  const r2 = [
    { symbol: 'A', shares: 100, price: 101 },
    { symbol: 'B', shares: 100, price: 99 },
  ];
  const a = windowAttribution({ rows: r2, past: new Map([['A', 100], ['B', 100]]), ndxBase: 0 });
  assert.ok(Math.abs(a.changePct) < 1e-9);
  assert.equal(a.carriers[0].sharePct, 100);
  assert.equal(a.draggers[0].sharePct, 100);
});

test('kullanicinin senaryosu: endeks artida, cogunluk ekside', () => {
  const dev = { symbol: 'MEGA', shares: 10000, price: 105 };
  const kucukler = Array.from({ length: 20 }, (_, i) => ({
    symbol: `S${i}`, shares: 10, price: 99,
  }));
  const p = new Map([['MEGA', 100], ...kucukler.map((k) => [k.symbol, 100])]);
  const a = windowAttribution({ rows: [dev, ...kucukler], past: p, ndxBase: 0 });
  assert.ok(a.changePct > 0, 'endeks yukselmis');
  assert.equal(a.down, 20);
  assert.equal(a.up, 1);
  assert.equal(a.namesToHalfOfUp, 1, 'yukselisin tamamini tek isim yapiyor');
  assert.equal(a.carriers[0].s, 'MEGA');
});

test('gecmis fiyati olmayan sembol pencereye girmez', () => {
  const a = windowAttribution({
    rows: [...rows, { symbol: 'YENI', shares: 100, price: 50 }],
    past, ndxBase: 0,
  });
  assert.equal(a.n, 3, 'banda hic girmemis sembol katkiya sokulmaz');
});

test('gecersiz fiyat/pay elenir; hicbiri kalmazsa null', () => {
  assert.equal(windowAttribution({ rows: [], past, ndxBase: 0 }), null);
  assert.equal(windowAttribution({
    rows: [{ symbol: 'A', shares: 0, price: 10 }], past, ndxBase: 0,
  }), null);
  assert.equal(windowAttribution({
    rows: [{ symbol: 'A', shares: 10, price: 0 }], past, ndxBase: 0,
  }), null);
  assert.equal(windowAttribution({
    rows: [{ symbol: 'A', shares: 10, price: 10 }], past: new Map([['A', 0]]), ndxBase: 0,
  }), null);
});

test('puan cevrimi ndxBase ile olcekli', () => {
  const a = windowAttribution({ rows, past, ndxBase: 20000 });
  assert.ok(Math.abs(a.changePts - (a.changePct / 100) * 20000) < 1e-6);
});

/* ---------------- buildWindows ---------------- */

test('buildWindows: veri yetmeyen pencere null kalir', () => {
  const kisa = [{ t: T - 90_000, p: { A: 100, B: 100, C: 100 } }];
  const w = buildWindows({ frames: kisa, rows, nowMs: T, ndxBase: 0 });
  assert.ok(w.m1, '1 dk dolu');
  assert.equal(w.h1, null, '1 saat icin veri yok — null olmali, uydurma degil');
  assert.equal(w.h4, null);
});

test('buildWindows: her pencere kendi etiketini ve gercek araligini tasir', () => {
  const w = buildWindows({ frames, rows, nowMs: T, ndxBase: 20000 });
  assert.equal(w.m5.label, '5 dk');
  assert.equal(w.m5.spanMs, 5 * 60_000);
  assert.equal(w.m5.actualMs, 5 * 60_000);
  assert.equal(w.m5.fromUtc, T - 5 * 60_000);
  assert.equal(w.h4.actualMs, 240 * 60_000);
});

test('buildWindows: bos bant her pencereyi null yapar, patlamaz', () => {
  const w = buildWindows({ frames: [], rows, nowMs: T, ndxBase: 0 });
  assert.deepEqual(Object.values(w), [null, null, null, null, null]);
});

test('yuvarlama artigi hareket sayilmaz (bant 4 hane, fiyat tam hassasiyet)', () => {
  // Bant 226,4012 kaydetmis; guncel fiyat 226,40123456 — AYNI baski.
  const a = windowAttribution({
    rows: [{ symbol: 'A', shares: 100, price: 226.40123456 },
           { symbol: 'B', shares: 100, price: 100.00004 }],
    past: new Map([['A', 226.4012], ['B', 100]]),
    ndxBase: 0,
  });
  assert.equal(a.flat, 2, 'iki hisse de kipirdamamis sayilmali');
  assert.equal(a.up, 0);
  assert.equal(a.down, 0);
});

test('gercek bir kurus hareketi hala yakalanir', () => {
  const a = windowAttribution({
    rows: [{ symbol: 'A', shares: 100, price: 226.41 }],
    past: new Map([['A', 226.40]]),
    ndxBase: 0,
  });
  assert.equal(a.up, 1);
  assert.equal(a.flat, 0);
});

test('hepsi kipirdamadiysa endeks TAM sifir (sahte kirmizi ok yok)', () => {
  const a = windowAttribution({
    rows: [{ symbol: 'A', shares: 100, price: 226.40123456 },
           { symbol: 'B', shares: 300, price: 99.999982 }],
    past: new Map([['A', 226.4012], ['B', 100]]),
    ndxBase: 20000,
  });
  assert.equal(a.changePct, 0);
  assert.equal(a.changePts, 0);
  assert.equal(a.carriers.length, 0);
  assert.equal(a.draggers.length, 0);
});
