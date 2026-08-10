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
import { ROOT, config } from '../config.js';
import { log } from '../lib/log.js';
import * as storage from '../storage.js';
import { paths } from '../storage.js';
import { fetchQuotes, fetchBaselines, fetchChartAll, fetchSparkAll, pickCurrent } from '../sources/yahoo.js';
import { discoverEquityMarkets, fetchCryptoPrices, fetchCandleBaseline } from '../sources/crypto.js';
import { pool } from '../lib/retry.js';
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
  if (!config.yahooUseCrumb) return null;
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

/* ---------- Kripto kismi-kapsam yedegi ---------- */

/** @type {{venue: string|null, at: number, entries: Record<string, any>}|null} */
let cryptoMapCache = null;
/** @type {{day: string, map: Map<string, any>}|null} */
let cryptoBaselineCache = null;

/**
 * Hangi borsada hangi NDX piyasasi var? Gunde bir kesfedilir, volume'a
 * yazilir. Sonuc bossa 6 saat "yok" olarak onbelleklenir — bos kesfi her
 * 5 dakikada tekrarlamak iki borsayi da bosuna dover.
 * @param {string[]} symbols
 */
async function getCryptoMap(symbols) {
  const now = Date.now();
  const ttl = (m) => (m?.venue ? 24 : 6) * 3600_000;

  if (cryptoMapCache && now - cryptoMapCache.at < ttl(cryptoMapCache)) return cryptoMapCache;

  const saved = await storage.readJson('crypto-map.json');
  if (saved && now - (saved.at ?? 0) < ttl(saved)) {
    cryptoMapCache = saved;
    return saved;
  }

  try {
    const d = await discoverEquityMarkets(symbols);
    /** @type {Record<string, any>} */
    const entries = {};
    if (d.recommended) {
      for (const m of d.venues[d.recommended].symbols) {
        entries[m.s] = { market: m.market, rawName: m.rawName, dex: m.dex ?? null };
      }
    }
    cryptoMapCache = { venue: d.recommended, at: now, entries };
    log.info('kripto piyasa haritasi', {
      venue: d.recommended ?? 'yok', eslesen: Object.keys(entries).length,
    });
  } catch (err) {
    cryptoMapCache = { venue: null, at: now, entries: {} };
    log.warn('kripto kesfi basarisiz', { err: String(err?.message ?? err) });
  }
  await storage.writeJson('crypto-map.json', cryptoMapCache);
  return cryptoMapCache;
}

/**
 * Kapsanan semboller icin TSI bazlari — mum verisinden, gunde bir.
 * @param {{venue: string, entries: Record<string, any>}} map
 * @param {number} startUtc
 */
async function getCryptoBaselines(map, startUtc) {
  const day = tsiDate(startUtc + 1000);
  if (cryptoBaselineCache?.day === day) return cryptoBaselineCache.map;

  const rel = `baseline/${day}.crypto.json`;
  const saved = await storage.readJson(rel);
  if (saved?.entries?.length) {
    cryptoBaselineCache = { day, map: new Map(saved.entries) };
    return cryptoBaselineCache.map;
  }

  const syms = Object.keys(map.entries);
  const settled = await pool(syms, 4, (sym) =>
    fetchCandleBaseline(/** @type {any} */ (map.venue), map.entries[sym], startUtc),
  { spacingMs: 150 });

  /** @type {Map<string, any>} */
  const m = new Map();
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) m.set(syms[i], r.value);
  });
  cryptoBaselineCache = { day, map: m };
  await storage.writeJson(rel, { day, entries: [...m] });
  log.info('kripto bazlar', { day, ok: m.size, toplam: syms.length });
  return m;
}

/**
 * KISMI-KAPSAM yolu. Yahoo'nun hicbir ucu calismadiginda devreye girer.
 *
 * Donen anlik goruntu `coverage.partial=true` tasir: arayuz genislik ve esit
 * agirlik istatistiklerini gizler, "yalnizca N hisse izleniyor" der ve
 * fiyatlarin perp oldugunu soyler. Kismi gunler GECMISE YAZILMAZ — 12
 * hisselik bir gunun "genisligi" liderlik tablosunu zehirlemesin.
 *
 * @param {{holdings: any[], source: string, asOf: string}} weights
 * @param {number} startUtc
 * @param {number} nowUtc
 */
async function tryCrypto(weights, startUtc, nowUtc) {
  const symbols = weights.holdings.map((h) => h.s);
  const map = await getCryptoMap(symbols);
  if (!map?.venue || Object.keys(map.entries).length === 0) return null;

  let prices;
  try {
    prices = await fetchCryptoPrices(/** @type {any} */ (map.venue), map.entries);
  } catch (err) {
    log.warn('kripto fiyatlar alinamadi', { err: String(err?.message ?? err) });
    return null;
  }
  if (prices.size === 0) return null;

  const baselines = await getCryptoBaselines(/** @type {any} */ (map), startUtc);

  const rows = [];
  let covW = 0, totW = 0;
  for (const h of weights.holdings) {
    const pw = Number(h.publishedWeight) || 0;
    totW += pw;
    const pm = prices.get(h.s);
    if (!pm) continue;
    const b = baselines.get(h.s);
    // Mum bazi yoksa 24 saat onceki fiyata dusulur — TSI gece yarisi degil,
    // yaklasik; kaynakta isaretlenir.
    const baseline = b?.baseline ?? (pm.prevDayPx > 0 ? pm.prevDayPx : null);
    if (!(baseline > 0) || !(pm.price > 0)) continue;
    covW += pw;
    rows.push({
      symbol: h.s,
      name: h.n ?? h.s,
      sector: h.sector ?? null,
      shares: h.shares,
      baseline,
      price: pm.price,
      open: null,
      // Perp'ler surekli islem gorur; "islemYok" kovasina dusmesinler.
      lastTradeAtUtc: nowUtc,
      baselineAtUtc: b?.at ?? null,
      baselineSource: b ? b.source : 'prev24h-approx',
    });
  }
  if (rows.length < 5) return null;

  // Puan cevrimi icin son bilinen ^NDX kapanisi (Yahoo calisirken yazilir).
  const ref = await storage.readJson('ndx-ref.json');
  const ndxBase = ref?.ndxBase > 0 ? ref.ndxBase : 25400;

  const warnings = ['crypto-partial'];
  if (!(ref?.ndxBase > 0)) warnings.push('ndx-ref-approx');
  if (weights.source !== 'invesco') warnings.push('weights-approx');

  return {
    rows,
    ndxBase,
    nowUtc,
    officialRegularPct: null,
    officialRegularLevel: null,
    minConstituents: 5,
    coverage: {
      partial: true,
      count: rows.length,
      total: weights.holdings.length,
      weightPct: totW > 0 ? +((covW / totW) * 100).toFixed(1) : null,
      venue: map.venue,
    },
    quality: {
      source: `crypto-${map.venue}`,
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing: symbols.filter((s) => !rows.some((r) => r.symbol === s)),
      warnings,
    },
  };
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

  const st = sessionState(nowUtc);
  const regOpen = st.isTradingDay ? phaseBoundaries(st.usDate).regOpen : null;
  const all = [...symbols, NDX];

  // YOL SIRASI — ucuzdan pahaliya, anahtarsizdan kapiliya:
  //   1) spark  : toplu, crumb YOK, ~5 istek                 ← birincil
  //   2) chart  : sembol basina, crumb YOK, ~102 istek
  //   3) quotes : crumb GEREKLI, 3 istek — varsayilan KAPALI
  // Onceden sira tersineydi ve en cok kisitlanan uctan baslamak, ondan
  // bagimsiz olmasi gereken uclari da zehirliyordu.
  /** @type {Map<string, any>|null} */
  let series = null;
  let seriesVia = null;
  const why = [];

  const spark = await fetchSparkAll(all, startUtc, regOpen);
  if (spark.series.size >= all.length * 0.5) {
    series = spark.series;
    seriesVia = 'spark';
  } else {
    if (spark.reasons?.length) why.push(`spark: ${spark.reasons.join(' | ')}`);
    else why.push(`spark: yalnizca ${spark.series.size}/${all.length} sembol dondu`);

    const chartRes = await fetchChartAll(all, startUtc, regOpen);
    if (chartRes.series.size > 0) {
      series = chartRes.series;
      seriesVia = 'chart';
    } else if (chartRes.reasons?.length) {
      why.push(`chart: ${chartRes.reasons.join(' | ')}`);
    }
  }

  // Son care (Yahoo icinde): crumb yolu, yalnizca acikca etkinlestirildiyse.
  const quotes = series ? null : await tryQuotes(all);
  if (!series && !quotes) {
    // Yahoo'nun hicbir ucu calismadi. Kripto kismi-kapsam yedegini dene —
    // buyuk hisseler izlenebiliyorsa site karanlik kalmasin.
    const cr = await tryCrypto(weights, startUtc, nowUtc);
    if (cr) return cr;
    throw new Error(`Yahoo erisilemiyor. ${why.join(' || ') || 'sebep bilinmiyor'}`);
  }

  const chart = series;

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

  // Kripto kismi-kapsam modu Yahoo'suz kalinca puan cevrimi icin bu degeri
  // okur; her basarili Yahoo turunda tazelenir.
  await storage.writeJson('ndx-ref.json', { ndxBase, at: nowUtc });

  const warnings = [];
  if (seriesVia === 'chart') warnings.push('chart-fallback');
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
      source: seriesVia ? `yahoo-${seriesVia}` : 'yahoo',
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing,
      warnings,
    },
  };
}
