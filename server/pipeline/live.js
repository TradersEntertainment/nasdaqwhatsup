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
import { fetchQuotes, fetchBaselines, fetchChartAll, pickCurrent } from '../sources/yahoo.js';
import { fetchHoldings } from '../sources/invesco.js';
import { sessionStartUtc, tsiDate, sessionState, phaseBoundaries } from '../../shared/session.js';

const NDX = '^NDX';
const WEIGHTS_TTL_MS = 20 * 3600_000;

/** @type {{holdings: any[], source: string, asOf: string}|null} */
let weightsCache = null;
/** @type {{day: string, map: Map<string, any>}|null} */
let baselineCache = null;

/**
 * Crumb yolu 429 yedigi zaman bir sure ona hic dokunma. Hiz sinirine
 * takilmis bir ucu her 5 dakikada tekrar dovmek durumu kotulestirir.
 */
let crumbBlockedUntil = 0;
const CRUMB_COOLDOWN_MS = 30 * 60_000;

/**
 * Kotasyonlari dener; hiz siniri / el sikismasi hatasinda FIRLATMAZ, null
 * doner ki cagiran crumb'siz chart yoluna dusebilsin.
 * @param {string[]} symbols
 */
async function tryQuotes(symbols) {
  if (Date.now() < crumbBlockedUntil) {
    log.debug('crumb yolu sogumada, atlaniyor');
    return null;
  }
  try {
    const q = await fetchQuotes(symbols);
    if (q.size === 0) throw new Error('hicbir kotasyon donmedi');
    return q;
  } catch (err) {
    const status = /** @type {any} */ (err)?.status;
    if (status === 429) {
      crumbBlockedUntil = Date.now() + CRUMB_COOLDOWN_MS;
      log.warn('Yahoo crumb yolu hiz sinirinda — chart yoluna geciliyor', {
        sogumaDk: CRUMB_COOLDOWN_MS / 60000,
      });
    } else {
      log.warn('kotasyon yolu basarisiz — chart yoluna geciliyor', {
        err: String(err?.message ?? err),
      });
    }
    return null;
  }
}

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
 * @param {{refreshBaselines?: boolean, fast?: boolean}} [opts]
 *   fast: baz fan-out'unu ATLA, `regularMarketPreviousClose`'u gecici baz say.
 *         Acilista site 30-60 sn bos beklemesin diye. Kisin bu deger zaten
 *         TAM DOGRU (TSI siniri 16:00 ET'ye oturuyor); yazin ~1 saatlik
 *         after-hours farki tasir ve rafine tur dakikalar icinde duzeltir.
 */
export async function fetchLiveRows({ refreshBaselines = false, fast = false } = {}) {
  const nowUtc = Date.now();
  const startUtc = sessionStartUtc(nowUtc);

  const weights = await getWeights();
  const symbols = weights.holdings.map((h) => h.s);

  const quotes = await tryQuotes([...symbols, NDX]);

  // Crumb yolu calismiyorsa chart yolu HEM bazi HEM guncel fiyati veriyor;
  // o durumda ayrica baz cekmeye gerek yok.
  const st = sessionState(nowUtc);
  const regOpen = st.isTradingDay ? phaseBoundaries(st.usDate).regOpen : null;
  /** @type {Map<string, any>|null} */
  let chart = null;
  if (!quotes) {
    const res = await fetchChartAll([...symbols, NDX], startUtc, regOpen);
    chart = res.series;
    if (chart.size === 0) {
      // Sebebi TASI. "Calismadi" demek teshis icin yetersiz; asil soru
      // Yahoo'nun 403 mu 429 mu zaman asimi mi dondugu.
      throw new Error(
        `Yahoo erisilemiyor — kotasyon yolu da chart yolu da bos dondu. ` +
        `Chart hatalari: ${res.reasons?.join(' | ') || 'bilinmiyor'}`
      );
    }
  }

  const baselines = quotes && !fast
    ? await getBaselines(symbols, startUtc, refreshBaselines)
    : new Map();

  /** @type {string[]} */
  const missing = [];
  const rows = [];

  for (const h of weights.holdings) {
    const q = quotes?.get(h.s);
    const ch = chart?.get(h.s);
    const b = baselines.get(h.s) ?? (ch?.baseline > 0
      ? { baseline: ch.baseline, at: ch.baselineAt, source: 'chart-bar' }
      : null);

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

    const cur = q
      ? pickCurrent(q, startUtc)
      : (ch?.price > 0 ? { price: ch.price, at: ch.priceAt, kind: 'CHART' } : null);

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
        ? q.regularMarketOpen
        : (ch?.open > 0 ? ch.open : null),
      lastTradeAtUtc: cur?.at ?? null,
      baselineAtUtc: baselineAt,
      baselineSource,
    });
  }

  // Endeks referans seviyesi ve resmi ana seans yuzdesi.
  const ndxQ = quotes?.get(NDX);
  const ndxC = chart?.get(NDX);
  const ndxBase =
    baselines.get(NDX)?.baseline ??
    ndxC?.baseline ??
    ndxC?.prevClose ??
    (Number.isFinite(ndxQ?.regularMarketPreviousClose) ? ndxQ.regularMarketPreviousClose : null);

  if (!(ndxBase > 0)) {
    throw new Error('^NDX referans seviyesi alinamadi — anlik goruntu kurulamaz');
  }

  const warnings = [];
  if (chart) warnings.push('chart-fallback');
  if (weights.source !== 'invesco') warnings.push('weights-approx');
  if (missing.length) warnings.push('missing-symbols');
  if (fast) warnings.push('provisional-baselines');

  return {
    rows,
    ndxBase,
    nowUtc,
    officialRegularPct: Number.isFinite(ndxQ?.regularMarketChangePercent)
      ? ndxQ.regularMarketChangePercent
      : (ndxC?.price > 0 && ndxC?.prevClose > 0
          ? (ndxC.price / ndxC.prevClose - 1) * 100 : null),
    officialRegularLevel: Number.isFinite(ndxQ?.regularMarketPrice)
      ? ndxQ.regularMarketPrice
      : (ndxC?.price ?? null),
    quality: {
      source: chart ? 'yahoo-chart' : 'yahoo',
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing,
      warnings,
    },
  };
}
