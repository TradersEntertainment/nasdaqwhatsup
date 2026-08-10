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
    quality: {
      source: 'fixture',
      weightsSource: f.weightsSource ?? 'bundled-approx',
      weightsAsOf: f.weightsAsOf ?? null,
      missing: [],
      warnings: ['fixture-mode'],
    },
  };
}

export function fixtureInfo() {
  const f = load(config.fixtureVariant);
  log.debug('fixture yuklendi', { variant: config.fixtureVariant, rows: f.rows.length });
  return { variant: config.fixtureVariant, rows: f.rows.length, nowUtc: f.nowUtc };
}
