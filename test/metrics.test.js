import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndexMetrics,
  checkInvariants,
  counterfactualCurve,
  median,
  mean,
} from '../shared/metrics.js';

/**
 * Elle hesaplanmis 4 hisselik senaryo. Butun beklenen degerler kagit uzerinde
 * cikarildi; kod degisirse test degil kod duzeltilmeli.
 *
 *   sembol  pay  baz  piyasaDegeri  agirlik  fiyat  getiri
 *   A       100  100      10.000     0,50     110   +10%
 *   B       100   50       5.000     0,25      45   -10%
 *   C       100   30       3.000     0,15      30     0%
 *   D       100   20       2.000     0,10      19    -5%
 *   toplam           20.000     1,00
 *
 *   Σ w·r = 0,5(0,10) + 0,25(-0,10) + 0,15(0) + 0,10(-0,05) = 0,02 → +%2,00
 */
const SESSION_START = 1_000_000;
const NDX_BASE = 1000;

const ROWS = [
  { symbol: 'A', shares: 100, baseline: 100, price: 110, open: 105, lastTradeAtUtc: SESSION_START + 500 },
  { symbol: 'B', shares: 100, baseline: 50, price: 45, open: 47, lastTradeAtUtc: SESSION_START + 500 },
  { symbol: 'C', shares: 100, baseline: 30, price: 30, open: 30, lastTradeAtUtc: SESSION_START - 500 },
  { symbol: 'D', shares: 100, baseline: 20, price: 19, open: 19.5, lastTradeAtUtc: SESSION_START + 500 },
];

const near = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b} bekleniyordu (fark ${Math.abs(a - b)})`);

function build(rows = ROWS, extra = {}) {
  return buildIndexMetrics({
    rows,
    ndxBase: NDX_BASE,
    sessionStartUtc: SESSION_START,
    ...extra,
  });
}

test('agirliklar baz fiyattan turer ve 1e toplanir', () => {
  const m = build();
  const w = Object.fromEntries(m.constituents.map((c) => [c.s, c.w]));
  near(w.A, 0.5);
  near(w.B, 0.25);
  near(w.C, 0.15);
  near(w.D, 0.1);
  near(m.constituents.reduce((s, c) => s + c.w, 0), 1);
});

test('sentetik endeks hareketi Σw·r ozdesligini tutar', () => {
  const m = build();
  near(m.index.changePct, 2);
  near(m.index.changePts, 20);
  near(m.index.syntheticLevel, 1020);
});

test('katkilar tam olarak endeks hareketine toplanir', () => {
  const m = build();
  const c = Object.fromEntries(m.constituents.map((x) => [x.s, x]));
  near(c.A.contribPp, 5);
  near(c.B.contribPp, -2.5);
  near(c.C.contribPp, 0);
  near(c.D.contribPp, -0.5);
  near(m.constituents.reduce((s, x) => s + x.contribPp, 0), m.index.changePct);

  near(c.A.contribPts, 50);
  near(c.B.contribPts, -25);
  near(c.D.contribPts, -5);
  near(m.constituents.reduce((s, x) => s + x.contribPts, 0), 20);
});

test('brut yukari/asagi havuzlari ve paylar', () => {
  const m = build();
  near(m.index.grossUpPp, 5);
  near(m.index.grossDownPp, -3);
  const c = Object.fromEntries(m.constituents.map((x) => [x.s, x]));
  // A tek pozitif katkili: yukselisin tamami onun.
  near(c.A.sharePct, 100);
  // Dususte B ve D kendi taraflarinin brut havuzuna oranlanir.
  near(c.B.sharePct, (2.5 / 3) * 100);
  near(c.D.sharePct, (0.5 / 3) * 100);
});

test('idxPct ~ 0 iken net pay gosterilmez, brut pay yine tanimli', () => {
  // A'yi +%5, B'yi -%10 yaparak net hareketi sifira yaklastiralim.
  const rows = [
    { symbol: 'A', shares: 100, baseline: 100, price: 105, lastTradeAtUtc: SESSION_START + 1 },
    { symbol: 'B', shares: 200, baseline: 100, price: 97.5, lastTradeAtUtc: SESSION_START + 1 },
  ];
  const m = build(rows);
  // wA=1/3, wB=2/3 → Σwr = (1/3)(0,05) + (2/3)(-0,025) = 0
  near(m.index.changePct, 0);
  for (const c of m.constituents) {
    assert.equal(c.shareOfNetPct, null, 'net pay bastirilmali');
    assert.ok(Number.isFinite(c.sharePct), 'brut pay her zaman sonlu olmali');
  }
});

test('esit agirlikli ve medyan getiri — asil aciklayici sayilar', () => {
  const m = build();
  near(m.index.equalWeightPct, -1.25);
  near(m.index.medianPct, -2.5);
  near(m.index.divergencePp, 2 - -1.25);
  near(m.index.upWeight, 0.5);
});

test('genislik: islem gormeyenler ayri kovada', () => {
  const m = build();
  const b = m.index.breadth;
  assert.equal(b.advancers, 1);
  assert.equal(b.decliners, 2);
  assert.equal(b.unchanged, 0);
  assert.equal(b.noTrade, 1, 'C seans basindan once islem gordu → noTrade');
  assert.equal(b.traded, 3);
  near(b.declinersPctOfTraded, (2 / 3) * 100, 1e-9);
});

test('karsi-olgu yeniden normalize eder; naif rakamdan ayrisir', () => {
  const m = build();
  const cf = Object.fromEntries(m.counterfactual.map((x) => [x.removeTop, x]));
  near(cf[0].changePct, 2);
  // A cikinca kalan agirlik 0,5; kalan Σwr = -0,03 → -0,03/0,5 = -%6
  near(cf[1].changePct, -6);
  // Naif yaklasim -%3 derdi; etkiyi yarisi kadar gosteriyor.
  near(cf[1].naivePct, -3);
});

test('pozitif katkili sayisindan fazlasini cikarmak egriyi duzlestirir', () => {
  const m = build();
  const cf = Object.fromEntries(m.counterfactual.map((x) => [x.removeTop, x]));
  // Sadece bir pozitif katkili (A) var.
  near(cf[2].changePct, cf[1].changePct);
  near(cf[10].changePct, cf[1].changePct);
});

test('tasiyicilari cikarmak endeksi monoton dusurur', () => {
  const rows = [
    { symbol: 'A', shares: 100, baseline: 100, price: 112, lastTradeAtUtc: SESSION_START + 1 },
    { symbol: 'B', shares: 100, baseline: 100, price: 108, lastTradeAtUtc: SESSION_START + 1 },
    { symbol: 'C', shares: 100, baseline: 100, price: 104, lastTradeAtUtc: SESSION_START + 1 },
    { symbol: 'D', shares: 100, baseline: 100, price: 99, lastTradeAtUtc: SESSION_START + 1 },
  ];
  const m = build(rows);
  const xs = m.counterfactual.map((x) => x.changePct);
  for (let i = 1; i < 4; i++) {
    assert.ok(xs[i] <= xs[i - 1] + 1e-12, `adim ${i}: ${xs[i]} > ${xs[i - 1]}`);
  }
});

test('bosluk / ana seans ayrimi hisse bazinda tam carpimsal', () => {
  const m = build();
  for (const c of m.constituents) {
    if (c.gapPct === null) continue;
    const recomposed = (1 + c.gapPct / 100) * (1 + c.rthPct / 100) - 1;
    near(recomposed, c.changePct / 100, 1e-12);
  }
});

test('gecersiz satirlar dusurulur, kalanlar yeniden normalize olur', () => {
  const rows = [
    ...ROWS,
    { symbol: 'BAD1', shares: 100, baseline: 0, price: 10, lastTradeAtUtc: SESSION_START },
    { symbol: 'BAD2', shares: 100, baseline: 10, price: 0, lastTradeAtUtc: SESSION_START },
  ];
  const m = build(rows);
  assert.deepEqual(m.dropped.sort(), ['BAD1', 'BAD2']);
  assert.equal(m.constituents.length, 4);
  near(m.constituents.reduce((s, c) => s + c.w, 0), 1);
  near(m.index.changePct, 2, 1e-12);
});

test('tum getiriler esitse endeks ve esit agirlikli ayni olur', () => {
  const rows = [10, 20, 30, 40].map((p, i) => ({
    symbol: `S${i}`,
    shares: 100 * (i + 1),
    baseline: p,
    price: p * 1.03,
    lastTradeAtUtc: SESSION_START + 1,
  }));
  const m = build(rows);
  near(m.index.changePct, 3, 1e-12);
  near(m.index.equalWeightPct, 3, 1e-12);
  near(m.index.divergencePp, 0, 1e-12);
});

test('degismezler saglikli veride temiz gecer', () => {
  const m = build();
  assert.deepEqual(checkInvariants(m, { minConstituents: 4 }), []);
});

test('degismezler bozuk veriyi yakalar', () => {
  const m = build();
  m.constituents[0].w += 0.01; // agirlik toplamini boz
  const errs = checkInvariants(m, { minConstituents: 4 });
  assert.ok(errs.length > 0, 'bozulma yakalanmaliydi');
  assert.ok(errs.some((e) => e.includes('Σw')));
});

test('yardimci istatistikler', () => {
  near(mean([1, 2, 3, 4]), 2.5);
  near(median([3, 1, 2]), 2);
  near(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(mean([]), 0);
});

test('bos girdi cokmez', () => {
  const m = build([]);
  assert.equal(m.constituents.length, 0);
  assert.equal(m.index.changePct, 0);
  assert.deepEqual(counterfactualCurve([]), Array.from({ length: 11 }, (_, i) => ({
    removeTop: i, changePct: 0, naivePct: 0,
  })));
});
