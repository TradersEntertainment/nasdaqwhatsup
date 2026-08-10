#!/usr/bin/env node
/**
 * Cevrimdisi gelistirme verisi uretir.
 *
 * ONEMLI: hazir bir "snapshot" degil, HAM SATIR (QuoteRow) uretir. Boylece
 * fixture modunda da gercek boru hatti (agirlik -> katki -> genislik ->
 * karsi-olgu -> degismez kontrolu) bastan sona calisir. Hazir snapshot
 * servis etmek matematigi test disi birakirdi.
 *
 * Bu container piyasa host'larini 403'le engelledigi icin yerel gelistirmenin
 * TEK veri kaynagi budur.
 *
 * Kullanim:  node scripts/make-fixture.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionStartUtc, sessionState } from '../shared/session.js';
import { buildIndexMetrics } from '../shared/metrics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'fixtures');

const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'holdings.seed.json'), 'utf8'));

/** Deterministik PRNG — ayni girdi her zaman ayni fixture'i uretsin. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NDX_BASE = 25400;

/**
 * Iki bilinmeyenli tam cozum: pozitif getirileri alfa, negatifleri beta ile
 * olcekleyerek hem endeks hareketini hem esit agirlikli getiriyi tam olarak
 * hedefe oturtur.
 *
 *   alfa·Σ_P w·r + beta·Σ_N w·r = hedefEndeks
 *   (alfa·Σ_P r  + beta·Σ_N r)/n = hedefEsitAgirlik
 */
function solveScales(items, targetIdx, targetEw) {
  const n = items.length;
  let a1 = 0, a2 = 0, b1 = 0, b2 = 0;
  for (const it of items) {
    if (it.r > 0) { a1 += it.w * it.r; b1 += it.r / n; }
    else { a2 += it.w * it.r; b2 += it.r / n; }
  }
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-15) throw new Error('olceklendirme cozulemedi (tekil matris)');
  const alpha = (targetIdx * b2 - a2 * targetEw) / det;
  const beta = (a1 * targetEw - targetIdx * b1) / det;
  return { alpha, beta };
}

/**
 * @param {object} cfg
 * @param {string} cfg.label
 * @param {string} cfg.nowIso        TSI ofsetli ISO ("+03:00")
 * @param {number} cfg.targetIdxPct
 * @param {number} cfg.targetEwPct
 * @param {number} cfg.redRatio      kirmizi hisse orani
 * @param {number} cfg.seed
 * @param {'full'|'sparse'|'none'} cfg.tradeActivity
 * @param {number} [cfg.dropCount]
 */
function makeVariant(cfg) {
  const nowUtc = Date.parse(cfg.nowIso);
  const start = sessionStartUtc(nowUtc);
  const rnd = mulberry32(cfg.seed);

  let holdings = seed.holdings;
  if (cfg.dropCount) holdings = holdings.slice(0, holdings.length - cfg.dropCount);

  const totalRefW = holdings.reduce((s, h) => s + h.refWeight, 0);

  // 1) Ham getiri sekli. En buyuk 8 hisse "tasiyici": carrierDir yonunde
  //    guclu hareket eder. Geri kalanlardan tam olarak hedef kadari ters yonde
  //    olur — boylece genislik orani rastgeleye birakilmaz, tam tutar.
  const carrierDir = cfg.carrierDir ?? 1;
  const sorted = [...holdings].sort((a, b) => b.refWeight - a.refWeight);
  const carriers = new Set(sorted.slice(0, 8).map((h) => h.s));

  const others = holdings.filter((h) => !carriers.has(h.s));
  // Deterministik karistirma (Fisher-Yates, tohumlu).
  const shuffled = [...others];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const targetRed = Math.round(cfg.redRatio * holdings.length);
  const redFromCarriers = carrierDir < 0 ? carriers.size : 0;
  const redFromOthers = Math.max(0, Math.min(others.length, targetRed - redFromCarriers));
  const redSet = new Set(shuffled.slice(0, redFromOthers).map((h) => h.s));

  const items = holdings.map((h) => {
    const w = h.refWeight / totalRefW;
    let r;
    if (carriers.has(h.s)) {
      r = carrierDir * (0.004 + rnd() * 0.022);   // ±%0,4 … ±%2,6
    } else if (redSet.has(h.s)) {
      r = -(0.001 + rnd() * 0.020);               // -%0,1 … -%2,1
    } else {
      r = 0.0005 + rnd() * 0.009;                 // +%0,05 … +%0,95
    }
    return { h, w, r };
  });

  // 2) Hedeflere tam oturt.
  if (cfg.tradeActivity === 'none') {
    for (const it of items) it.r = 0;
  } else {
    const { alpha, beta } = solveScales(items, cfg.targetIdxPct / 100, cfg.targetEwPct / 100);
    if (alpha <= 0 || beta <= 0) {
      throw new Error(`${cfg.label}: negatif olcek (alpha=${alpha}, beta=${beta})`);
    }
    for (const it of items) it.r *= it.r > 0 ? alpha : beta;
  }

  // 3) Satirlari kur.
  const rows = items.map(({ h, r }) => {
    const baseline = h.refPrice;
    const price = baseline * (1 + r);

    // Hareketin bir kismi gece boslugundan, kalani seans icinden gelsin.
    const gapShare = 0.35 + rnd() * 0.4;
    const open = cfg.tradeActivity === 'full' ? baseline * (1 + r * gapShare) : null;

    /** @type {number|null} */
    let lastTradeAtUtc;
    if (cfg.tradeActivity === 'full') {
      lastTradeAtUtc = start + Math.floor((nowUtc - start) * (0.7 + rnd() * 0.3));
    } else if (cfg.tradeActivity === 'sparse') {
      // Seans disinda cogu hisse hic islem gormez — "islemYok" kovasini besler.
      lastTradeAtUtc = rnd() < 0.12 ? start + Math.floor(rnd() * (nowUtc - start)) : start - 3600_000;
    } else {
      lastTradeAtUtc = start - 3600_000;
    }

    return {
      symbol: h.s,
      name: h.n,
      sector: h.sector,
      shares: h.refWeight / h.refPrice,
      baseline,
      price,
      open,
      lastTradeAtUtc,
      baselineAtUtc: start - 60_000,
      baselineSource: 'chart-bar',
    };
  });

  return {
    label: cfg.label,
    nowUtc,
    ndxBase: NDX_BASE,
    // Resmi ^NDX ana seans %'si: TSI seansindan gece boslugu kadar farkli.
    officialRegularPct: cfg.tradeActivity === 'full' ? cfg.targetIdxPct * 0.42 : null,
    weightsSource: cfg.dropCount ? 'fallback' : 'invesco',
    weightsAsOf: seed.asOf,
    rows,
  };
}

const VARIANTS = [
  {
    // Kullanicinin tarif ettigi senaryonun tam kendisi.
    label: 'regular', nowIso: '2026-08-11T18:00:00+03:00',
    targetIdxPct: 0.80, targetEwPct: -0.41, redRatio: 0.62,
    seed: 20260811, tradeActivity: 'full',
  },
  {
    label: 'overnight', nowIso: '2026-08-11T06:00:00+03:00',
    targetIdxPct: 0.12, targetEwPct: -0.05, redRatio: 0.55,
    seed: 606, tradeActivity: 'sparse',
  },
  {
    label: 'weekend', nowIso: '2026-08-15T12:00:00+03:00',
    targetIdxPct: 0, targetEwPct: 0, redRatio: 0.5,
    seed: 815, tradeActivity: 'none',
  },
  {
    label: 'holiday', nowIso: '2026-01-01T18:00:00+03:00',
    targetIdxPct: 0, targetEwPct: 0, redRatio: 0.5,
    seed: 101, tradeActivity: 'none',
  },
  {
    // Kis rejimi (TSI gunu tam olarak kapanis-kapanis) + AYNA SENARYO:
    // tasiyicilar dususte, endeks kirmizi ama hisselerin cogu yesil.
    label: 'est', nowIso: '2026-01-15T20:00:00+03:00',
    targetIdxPct: -0.55, targetEwPct: 0.22, redRatio: 0.38,
    seed: 115, tradeActivity: 'full', carrierDir: -1,
  },
  {
    label: 'degraded', nowIso: '2026-08-11T18:00:00+03:00',
    targetIdxPct: 0.34, targetEwPct: -0.28, redRatio: 0.60,
    seed: 999, tradeActivity: 'full', dropCount: 12,
  },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const cfg of VARIANTS) {
  const v = makeVariant(cfg);
  writeFileSync(join(OUT_DIR, `${v.label}.json`), JSON.stringify(v, null, 1));

  // Ureteni dogrula: hedefler gercekten tutuyor mu?
  const m = buildIndexMetrics({
    rows: v.rows,
    ndxBase: v.ndxBase,
    sessionStartUtc: sessionStartUtc(v.nowUtc),
    officialRegularPct: v.officialRegularPct,
  });
  const st = sessionState(v.nowUtc);
  const b = m.index.breadth;
  const redPct = b.traded > 0 ? (b.decliners / b.traded) * 100 : 0;
  console.log(
    `${v.label.padEnd(10)} faz=${st.phase.padEnd(18)} ` +
    `endeks=${m.index.changePct.toFixed(2).padStart(6)}%  ` +
    `esitAgirlik=${m.index.equalWeightPct.toFixed(2).padStart(6)}%  ` +
    `kirmizi=${redPct.toFixed(0).padStart(3)}%  ` +
    `hisse=${m.constituents.length}  islemYok=${b.noTrade}`
  );
}

console.log(`\n${VARIANTS.length} varyant yazildi -> data/fixtures/`);
