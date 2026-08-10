/**
 * Cevrimdisi veri kaynagi.
 *
 * Bu container'in cikis politikasi tum piyasa veri host'larini 403'le
 * engelliyor (Yahoo, Invesco, Stooq, Finnhub...). Yerel gelistirmenin tek
 * yolu bu. Fixture HAM SATIR dondurur; snapshot yine gercek boru hattinda
 * kurulur, boylece matematik test disi kalmaz.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../config.js';
import { sessionStartUtc } from '../../shared/session.js';
import { log } from '../lib/log.js';

/** @type {Map<string, any>} */
const cache = new Map();

/** @param {string} variant */
function load(variant) {
  if (cache.has(variant)) return cache.get(variant);
  const file = join(ROOT, 'data', 'fixtures', `${variant}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `fixture "${variant}" okunamadi (${file}). Once \`npm run fixture\` calistirin. ` +
      `Sebep: ${err?.message ?? err}`
    );
  }
  cache.set(variant, data);
  return data;
}

/** Deterministik ufak dalgalanma — SSE/canli guncelleme yolunu gercekten calistirir. */
function jitter(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} tick artan sayac — her poll'da degisen dalgalanma icin
 * @returns {{rows: any[], ndxBase: number, nowUtc: number, officialRegularPct: number|null, quality: object}}
 */
export function fetchFixture(tick = 0) {
  const variant = config.fixtureVariant;
  const f = load(variant);

  // Saati sabitlemek hafta sonu / gece / tatil ekranlarini gercek saati
  // beklemeden gostermeyi mumkun kiliyor (ekran goruntusu almak icin sart).
  const nowUtc = config.fixturePinClock ? f.nowUtc : Date.now();
  const start = sessionStartUtc(nowUtc);

  const rnd = jitter(1000 + tick * 7919);
  const alive = f.rows.some((r) => r.lastTradeAtUtc >= f.nowUtc - 86400000);

  const rows = f.rows.map((r) => {
    // Fixture'in kendi seansindan simdiki seansa kaydir (saat sabitlenmemisse).
    const shift = start - sessionStartUtc(f.nowUtc);
    const wobble = tick === 0 || !alive ? 0 : (rnd() - 0.5) * 0.0016;
    return {
      ...r,
      price: r.price * (1 + wobble),
      lastTradeAtUtc: r.lastTradeAtUtc + shift,
      baselineAtUtc: r.baselineAtUtc + shift,
    };
  });

  return {
    rows,
    ndxBase: f.ndxBase,
    nowUtc,
    officialRegularPct: f.officialRegularPct ?? null,
    officialRegularLevel: null,
    // Kismi-kapsam gibi ozel durumlar fixture'dan aynen tasinir ki her UI
    // durumu agsiz gorulebilsin.
    coverage: f.coverage ?? null,
    minConstituents: f.minConstituents,
    quality: {
      source: f.qualitySource ?? 'fixture',
      weightsSource: f.weightsSource ?? 'bundled-approx',
      weightsAsOf: f.weightsAsOf ?? null,
      missing: [],
      warnings: ['fixture-mode', ...(f.warnings ?? [])],
    },
  };
}

export function fixtureInfo() {
  const f = load(config.fixtureVariant);
  log.debug('fixture yuklendi', { variant: config.fixtureVariant, rows: f.rows.length });
  return { variant: config.fixtureVariant, rows: f.rows.length, nowUtc: f.nowUtc };
}

/* ------------------------------------------------------------------ */
/* Fixture: pencere bandi ve bilanco takvimi                           */
/* ------------------------------------------------------------------ */

/**
 * Sentetik fiyat bandi.
 *
 * Neden gerekli: pencere bolumu (1 dk … 4 sa) canli sunucuda DAKIKALAR
 * boyunca kare biriktikce doluyor. Fixture modunda beklemek, ekran goruntusu
 * almayi ve gorsel denetimi imkansiz kilardi. Burada bant, anlik goruntunun
 * kendi fiyatlarindan geriye dogru TURETILIYOR — uydurma bir hisse listesi
 * degil, ayni hisselerin gecmisi.
 *
 * Sentetik drift bilincli olarak SITENIN TEZINI tasiyor: en agir birkac isim
 * yukselirken genis taban asagi gidiyor. Boylece pencere paneli, yakalamak
 * icin var oldugu durumu bos ekran yerine gercekten gosteriyor.
 *
 * @param {any[]} rows
 * @param {number} nowUtc
 * @returns {{t: number, p: Record<string, number>}[]}
 */
export function fixtureTape(rows, nowUtc) {
  const cap = config.fixtureTapeMin;
  const OFFSETS_MIN = [245, 240, 62, 60, 16, 15, 6, 5, 2, 1]
    .filter((m) => !cap || m <= cap);
  if (OFFSETS_MIN.length === 0) return [];

  // Agirlik sirasi: pay adedi x fiyat. Ilk 8 "tasiyici" rolunu ustlenir.
  const ranked = [...rows]
    .filter((r) => r.price > 0 && r.shares > 0)
    .sort((a, b) => b.shares * b.price - a.shares * a.price);
  const rank = new Map(ranked.map((r, i) => [r.symbol, i]));

  return OFFSETS_MIN.map((min) => {
    /** @type {Record<string, number>} */
    const p = {};
    for (const r of rows) {
      if (!(r.price > 0)) continue;
      const i = rank.get(r.symbol) ?? 999;
      const rnd = jitter(i * 7919 + min * 104729)();
      // Dakika basina drift: ilk 8 isim pozitif, gerisi agirlikli olarak negatif.
      const perMin = i < 8
        ? 0.00018 + rnd * 0.00022
        : -0.00009 - rnd * 0.00011;
      // Gecmis fiyat = simdiki / (1 + drift x dakika). Ileri degil GERI bakiliyor.
      p[r.symbol] = +(r.price / (1 + perMin * min)).toFixed(4);
    }
    return { t: nowUtc - min * 60_000, p };
  }).sort((a, b) => a.t - b.t);
}

/**
 * Sentetik bilanco takvimi — rozetlerin ve "yaklasan bilancolar" kartinin
 * agsiz gorulebilmesi icin. Deterministik: ayni fixture hep ayni takvimi verir.
 *
 * @param {any[]} rows
 * @param {string} todayEt YYYY-MM-DD
 */
export function fixtureEarnings(rows, todayEt) {
  /** @type {Record<string, any>} */
  const out = {};
  const base = Date.parse(`${todayEt}T00:00:00Z`);
  const picks = rows.filter((_, i) => i % 7 === 3).slice(0, 14);

  picks.forEach((r, i) => {
    const days = [0, 0, 1, 1, 2, 3, 3, 4, 5, 5, 6, 7, 9, 12][i] ?? 6;
    const hint = i % 3 === 0 ? 'bmo' : i % 3 === 1 ? 'amc' : 'unknown';
    const when = hint === 'bmo' ? 'açılış öncesi' : hint === 'amc' ? 'kapanış sonrası' : '';
    const day = days === 0 ? 'bugün' : days === 1 ? 'yarın' : `${days} gün sonra`;
    out[r.symbol] = {
      inDays: days,
      dateEt: new Date(base + days * 86400_000).toISOString().slice(0, 10),
      hint,
      text: when ? `Bilanço ${day}, ${when}` : `Bilanço ${day}`,
    };
  });
  return out;
}
