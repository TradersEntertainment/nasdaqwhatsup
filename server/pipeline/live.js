/**
 * Canli veri boru hatti: agirliklar + bazlar + kotasyonlar -> ham satirlar.
 *
 * ⚠ Bu yol bu container'dan calistirilamaz (piyasa host'lari 403). Railway'de
 * ilk dagitimdan sonra `/api/health` ve `/api/snapshot` ile dogrulanir.
 *
 * Kademeli yedekleme her katmanda var: bir kaynak dusunce site bozulmuyor,
 * koreliyor — ve neyin koreldigini `quality.warnings` ile SOYLUYOR.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';
import { log } from '../lib/log.js';
import * as storage from '../storage.js';
import { paths } from '../storage.js';
import { fetchQuotes, fetchBaselines, pickCurrent } from '../sources/yahoo.js';
import { fetchHoldings } from '../sources/invesco.js';
import { sessionStartUtc, tsiDate } from '../../shared/session.js';

const NDX = '^NDX';
const WEIGHTS_TTL_MS = 20 * 3600_000;

/** @type {{holdings: any[], source: string, asOf: string}|null} */
let weightsCache = null;
/** @type {{day: string, map: Map<string, any>}|null} */
let baselineCache = null;

/* ---------- Agirliklar (pay adetleri) ---------- */

function loadSeed() {
  const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'holdings.seed.json'), 'utf8'));
  return {
    // Seed'de pay adedi ORTULU: shares = refWeight / refPrice. Calisma aninda
    // w = shares * baz / Σ oldugundan, fiyatlar refPrice'tan uzaklastikca
    // agirliklar dogru yonde kayiyor.
    holdings: seed.holdings.map((h) => ({
      s: h.s, n: h.n, sector: h.sector,
      shares: h.refWeight / h.refPrice,
      publishedWeight: h.refWeight,
    })),
    source: seed.source,
    asOf: seed.asOf,
  };
}

async function getWeights() {
  if (weightsCache && Date.now() - Date.parse(weightsCache.asOf) < WEIGHTS_TTL_MS) {
    return weightsCache;
  }

  // 1) Canli Invesco.
  try {
    const { holdings, fetchedAt } = await fetchHoldings();
    weightsCache = { holdings, source: 'invesco', asOf: fetchedAt };
    await storage.writeJson(paths.weights(), weightsCache);
    return weightsCache;
  } catch (err) {
    log.warn('Invesco holdings alinamadi', { err: String(err?.message ?? err) });
  }

  // 2) Volume'daki son basarili kopya.
  const cached = await storage.readJson(paths.weights());
  if (cached?.holdings?.length >= 80) {
    log.info('agirliklar volume onbelleginden', { asOf: cached.asOf });
    weightsCache = { ...cached, source: 'cached' };
    return weightsCache;
  }

  // 3) Commit'li yaklasik seed.
  log.warn('agirliklar seed dosyasindan (YAKLASIK)');
  weightsCache = loadSeed();
  return weightsCache;
}

/* ---------- Bazlar ---------- */

/**
 * @param {string[]} symbols
 * @param {number} startUtc
 * @param {boolean} force
 */
async function getBaselines(symbols, startUtc, force) {
  const day = tsiDate(startUtc + 1000);

  if (!force && baselineCache?.day === day) return baselineCache.map;

  // Yeniden baslamada diskten geri yukle — 101 istegi tekrar etmeye gerek yok.
  if (!force) {
    const saved = await storage.readJson(paths.baseline(day));
    if (saved?.entries?.length >= 80) {
      log.info('bazlar volume\'dan geri yuklendi', { day, adet: saved.entries.length });
      baselineCache = { day, map: new Map(saved.entries) };
      return baselineCache.map;
    }
  }

  const { baselines } = await fetchBaselines([...symbols, NDX], startUtc);
  baselineCache = { day, map: baselines };
  await storage.writeJson(paths.baseline(day), {
    day, writtenAt: new Date().toISOString(), entries: [...baselines],
  });
  return baselines;
}

/* ---------- Ana giris ---------- */

/**
 * @param {{refreshBaselines?: boolean}} [opts]
 */
export async function fetchLiveRows({ refreshBaselines = false } = {}) {
  const nowUtc = Date.now();
  const startUtc = sessionStartUtc(nowUtc);

  const weights = await getWeights();
  const symbols = weights.holdings.map((h) => h.s);

  const baselines = await getBaselines(symbols, startUtc, refreshBaselines);
  const quotes = await fetchQuotes([...symbols, NDX]);

  /** @type {string[]} */
  const missing = [];
  const rows = [];

  for (const h of weights.holdings) {
    const q = quotes.get(h.s);
    const b = baselines.get(h.s);

    // Baz yedek zinciri: chart bari -> onceki resmi kapanis (kisin tam, yazin
    // ~1 saat eksik) -> sembolu dusur.
    let baseline = b?.baseline;
    let baselineAt = b?.at ?? null;
    let baselineSource = b?.source ?? null;
    if (!(baseline > 0) && Number.isFinite(q?.regularMarketPreviousClose)) {
      baseline = q.regularMarketPreviousClose;
      baselineAt = null;
      baselineSource = 'prev-close-approx';
    }

    const cur = q ? pickCurrent(q, startUtc) : null;

    if (!(baseline > 0)) { missing.push(h.s); continue; }

    // Islem gormemis hisse dusurulmez: fiyati bazina esitlenir ve genislikte
    // "islemYok" kovasina duser. Dusurmek agirligini digerlerine dagitir ve
    // endeks hareketini sisirir.
    const price = cur?.price ?? baseline;

    rows.push({
      symbol: h.s,
      name: h.n ?? h.s,
      sector: h.sector ?? null,
      shares: h.shares,
      baseline,
      price,
      open: Number.isFinite(q?.regularMarketOpen) && q.regularMarketOpen > 0
        ? q.regularMarketOpen : null,
      lastTradeAtUtc: cur?.at ?? null,
      baselineAtUtc: baselineAt,
      baselineSource,
    });
  }

  // Endeks referans seviyesi ve resmi ana seans yuzdesi.
  const ndxQ = quotes.get(NDX);
  const ndxB = baselines.get(NDX);
  const ndxBase =
    ndxB?.baseline ??
    (Number.isFinite(ndxQ?.regularMarketPreviousClose) ? ndxQ.regularMarketPreviousClose : null);

  if (!(ndxBase > 0)) {
    throw new Error('^NDX referans seviyesi alinamadi — anlik goruntu kurulamaz');
  }

  const warnings = [];
  if (weights.source !== 'invesco') warnings.push('weights-approx');
  if (missing.length) warnings.push('missing-symbols');

  return {
    rows,
    ndxBase,
    nowUtc,
    officialRegularPct: Number.isFinite(ndxQ?.regularMarketChangePercent)
      ? ndxQ.regularMarketChangePercent : null,
    officialRegularLevel: Number.isFinite(ndxQ?.regularMarketPrice)
      ? ndxQ.regularMarketPrice : null,
    quality: {
      source: 'yahoo',
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing,
      warnings,
    },
  };
}
