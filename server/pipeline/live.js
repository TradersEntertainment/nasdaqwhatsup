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
import { fetchStooqQuotes, fetchStooqBaselines, stooqBlocked, stooqInfo } from '../sources/stooq.js';
import { fetchFinnhubQuotes } from '../sources/finnhub.js';
import { fetchNasdaq100 } from '../sources/nasdaq.js';
import { fetchTradingView, toSessionRow } from '../sources/tradingview.js';
import { pool } from '../lib/retry.js';
import { fetchHoldings } from '../sources/invesco.js';
import { sessionStartUtc, tsiDate, sessionState, phaseBoundaries, previousTradingDay, tsiDayHasTrading } from '../../shared/session.js';

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

/**
 * Ad cakismasi korumasi icin beklenen fiyat araligi.
 *
 * Uretimde olculen gercek: Binance'te NDX sembolleriyle "eslesen" 2 piyasa
 * hisse degil, ayni kisaltmayi tasiyan KRIPTO COINLERDI. Boyle bir coinin
 * fiyatini hisse fiyati diye gostermek felaket olur. Seed'deki referans
 * fiyata gore [x0.2, x5] disinda kalan her eslesme cakisma sayilip elenir
 * (hisse bir gunde 5 katina cikmaz; coin fiyatlari ise bambaska olcekte).
 */
let refPriceMap = null;
function getRefPrices() {
  if (!refPriceMap) {
    const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'holdings.seed.json'), 'utf8'));
    refPriceMap = new Map(seed.holdings.map((h) => [h.s, h.refPrice]));
  }
  return refPriceMap;
}

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
  // Bos sonuc yalnizca 30 dk saklanir (kesif 2 istek — ucuz) ve surumsuz /
  // eski onbellekler YOK SAYILIR: kesif mantigi degisince volume'daki eski
  // "venue:null" kaydi yeni kodu 6 saat kilitliyordu.
  const MAP_V = 2;
  const ttl = (m) => (m?.venue ? 24 * 3600_000 : 30 * 60_000);
  const valid = (m) => m && m.v === MAP_V && now - (m.at ?? 0) < ttl(m);

  if (valid(cryptoMapCache)) return cryptoMapCache;

  const saved = await storage.readJson('crypto-map.json');
  if (valid(saved)) {
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
    cryptoMapCache = { v: 2, venue: d.recommended, at: now, entries,
      // Teshis: eslesme yoksa iki borsanin da NE dedigini sakla.
      note: d.recommended ? null : Object.entries(d.venues)
        .map(([k, v]) => `${k}: ${v.ok ? `${v.matched} eslesme / ${v.totalMarkets} piyasa` : v.error}`)
        .join(' | '),
    };
    log.info('kripto piyasa haritasi', {
      venue: d.recommended ?? 'yok', eslesen: Object.keys(entries).length,
      not: cryptoMapCache.note ?? '-',
    });
  } catch (err) {
    cryptoMapCache = { v: 2, venue: null, at: now, entries: {}, note: String(err?.message ?? err) };
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
  if (!map?.venue || Object.keys(map.entries).length === 0) {
    return { ok: false, reason: `kripto: eslesen piyasa yok (${map?.note ?? 'kesif yapilamadi'})` };
  }

  let prices;
  try {
    prices = await fetchCryptoPrices(/** @type {any} */ (map.venue), map.entries);
  } catch (err) {
    return { ok: false, reason: `kripto(${map.venue}): fiyatlar alinamadi — ${String(err?.message ?? err).slice(0, 80)}` };
  }
  if (prices.size === 0) {
    return { ok: false, reason: `kripto(${map.venue}): haritadaki piyasalar fiyat dondurmedi` };
  }

  const baselines = await getCryptoBaselines(/** @type {any} */ (map), startUtc);

  const rows = [];
  let covW = 0, totW = 0, collisions = 0;
  for (const h of weights.holdings) {
    const pw = Number(h.publishedWeight) || 0;
    totW += pw;
    const pm = prices.get(h.s);
    if (!pm) continue;
    // Ad cakismasi: fiyat, hissenin bilinen olceginden kopuksa bu bir coin.
    const ref = getRefPrices().get(h.s);
    if (ref > 0 && (pm.price / ref < 0.2 || pm.price / ref > 5)) {
      collisions++;
      continue;
    }
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
  if (rows.length < 5) {
    return { ok: false, reason:
      `kripto(${map.venue}): yalnizca ${rows.length} gercek hisse (<5)` +
      (collisions ? ` — ${collisions} ad cakismasi elendi (ayni kisaltmali coin)` : '') };
  }

  // Puan cevrimi icin son bilinen ^NDX kapanisi (Yahoo calisirken yazilir).
  const ref = await storage.readJson('ndx-ref.json');
  const ndxBase = ref?.ndxBase > 0 ? ref.ndxBase : 25400;

  const warnings = ['crypto-partial'];
  if (!(ref?.ndxBase > 0)) warnings.push('ndx-ref-approx');
  if (weights.source !== 'invesco') warnings.push('weights-approx');

  return { ok: true, raw: {
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
  } };
}

/* ---------- TradingView: anahtarsiz, tek istek, UZATILMIS SEANS DAHIL ---------- */

let tvCache = { at: 0, map: null, extended: false };

/**
 * BIRINCIL yol. Tek POST ile 100 hissenin fiyati, net degisimi ve pre/after
 * market baskilari. "Seans disi dahil" gereksinimini gercekten karsilayan
 * tek anahtarsiz kaynak bu — Yahoo spark'i bile uzatilmis seansi ayri bir
 * istek olmadan vermiyordu.
 *
 * @param {{holdings: any[], source: string, asOf: string}} weights
 * @param {number} startUtc
 * @param {number} nowUtc
 * @param {ReturnType<typeof sessionState>} st
 */
async function tryTradingView(weights, startUtc, nowUtc, st) {
  const symbols = weights.holdings.map((h) => h.s);

  let map = tvCache.map;
  // TTL, poll kadansini (60 sn) ASLA cok asmamali: banda yazilan her kare
  // gercek bir gozlem olmali. Eski 15 dakikalik "seans disi" TTL'i, 1 dk ve
  // 5 dk pencerelerini kalici olarak %0,00'a kilitliyordu.
  const ttl = st.live ? 30_000 : 3 * 60_000;
  if (!map || nowUtc - tvCache.at > ttl) {
    try {
      // QQQ da istenir: ucretsiz uclarin hicbiri ^NDX vermiyor, QQQ resmi
      // ana-seans yuzdesi icin en yakin vekil (izleme farki birkac baz puan).
      const r = await fetchTradingView([...symbols, 'QQQ']);
      map = r.map;
      tvCache = { at: nowUtc, map, extended: r.extended };
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err).slice(0, 140) };
    }
  }

  const hasTrading = tsiDayHasTrading(st.tsiDate);
  const rows = [];
  for (const h of weights.holdings) {
    const rec = map.get(h.s);
    if (!rec) continue;
    const sr = toSessionRow(rec, st.phase, hasTrading);
    if (!sr) continue;
    rows.push({
      symbol: h.s,
      name: h.n ?? h.s,
      sector: h.sector ?? null,
      shares: h.shares,
      baseline: sr.baseline,
      price: sr.price,
      open: sr.open,
      // TradingView zaman damgasi vermiyor; "islem gordu mu" sorusu uzatilmis
      // seans HACMINDEN cevaplaniyor (fiyat esitligi yaniltici bir olcu).
      lastTradeAtUtc: sr.traded ? nowUtc : startUtc - 3600_000,
      baselineAtUtc: null,
      baselineSource: st.phase === 'REGULAR' || st.phase === 'AFTER_HOURS'
        ? 'tv-prevclose' : 'tv-lastclose',
    });
  }

  if (rows.length < 85) {
    return { ok: false, reason: `tradingview: yalnizca ${rows.length}/${symbols.length} sembol cozuldu (<85)` };
  }

  const ref = await storage.readJson('ndx-ref.json');
  const ndxBase = ref?.ndxBase > 0 ? ref.ndxBase : 25400;
  const warnings = [];
  if (!(ref?.ndxBase > 0)) warnings.push('ndx-ref-approx');
  if (weights.source !== 'invesco') warnings.push('weights-approx');
  // Asgari kolon setine dusulduyse uzatilmis seans YOK — kullaniciya soyle.
  if (!tvCache.extended) warnings.push('no-extended-hours');

  const qqq = map.get('QQQ');
  return { ok: true, raw: {
    rows,
    ndxBase,
    nowUtc,
    // Bant bu damgayla tekrar kare yazmaktan kacinir.
    observedAt: tvCache.at,
    officialRegularPct: Number.isFinite(qqq?.change) ? qqq.change : null,
    officialRegularLevel: null,
    quality: {
      source: 'tradingview',
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing: symbols.filter((s) => !rows.some((r) => r.symbol === s)),
      warnings,
    },
  } };
}


/* ---------- Hyperliquid CANLI KAPLAMA (7/24) ---------- */

/**
 * Hisse perp fiyatlariyla canli kaplama.
 *
 * SORUN: TradingView/nasdaq.com hisse verisi ABD borsasi kapaliyken DONAR.
 * TSI gunun 8 saati (gece) ve tum hafta sonu boyunca hicbir fiyat degismez;
 * site "101 hisse kipirdamadi" der ve olu gorunur. Bu dogru ama ise yaramaz.
 *
 * COZUM: Hyperliquid'in HIP-3 `xyz` dex'indeki hisse perp'leri 7/24 islem
 * goruyor. Kapsadigi semboller icin fiyat VE baz oradan alinir.
 *
 * Neden hem fiyat hem baz: getiri `fiyat/baz` oldugu icin ikisinin AYNI
 * piyasadan gelmesi sart. Perp fiyatini spot baza bolmek, iki piyasa
 * arasindaki taban farkini "gunluk hareket" diye gosterirdi.
 *
 * Neden her fazda (yalniz gece degil): kaynak faz sinirinda degisirse o
 * sembolun fiyat serisi kirilir ve o ani kapsayan pencereler perp fiyatini
 * spot fiyatla karsilastirip sacma bir getiri uretir. Tek bir sembol icin
 * TEK bir piyasa — hep.
 *
 * Guvenlik: ad cakismasi araligi (ayni kisaltmali coin), akil disi getiri
 * siniri ve sembol basina "ikisi de var mi" kontrolu. Biri bile tutmazsa o
 * sembol dokunulmadan birakilir.
 *
 * @param {any[]} rows birincil kaynaktan gelen satirlar (YERINDE degistirilmez)
 * @param {number} startUtc
 * @param {number} nowUtc
 */
async function applyHlOverlay(rows, startUtc, nowUtc) {
  if (!config.hlOverlay) return { rows, overlay: null };

  const map = await getCryptoMap(rows.map((r) => r.symbol));
  if (!map?.venue || Object.keys(map.entries).length === 0) {
    return { rows, overlay: { venue: null, count: 0, reason: map?.note ?? 'eslesen piyasa yok' } };
  }

  let prices;
  try {
    prices = await fetchCryptoPrices(/** @type {any} */ (map.venue), map.entries);
  } catch (err) {
    log.debug('kaplama fiyatlari alinamadi', { err: String(err?.message ?? err) });
    return { rows, overlay: { venue: map.venue, count: 0, reason: 'fiyat alinamadi' } };
  }

  const baselines = await getCryptoBaselines(/** @type {any} */ (map), startUtc);
  const ref = getRefPrices();

  let count = 0, collision = 0, insane = 0, noBase = 0;
  const out = rows.map((r) => {
    const pm = prices.get(r.symbol);
    const b = baselines.get(r.symbol);
    if (!pm || !(pm.price > 0)) return r;

    // 1) Ad cakismasi: ayni kisaltmayi tasiyan bir COIN olabilir.
    const rp = ref.get(r.symbol);
    if (rp > 0 && (pm.price / rp < 0.2 || pm.price / rp > 5)) { collision++; return r; }

    // 2) Baz: TSI seans basindaki perp fiyati. Yoksa kaplama yapilmaz —
    //    perp fiyatini spot baza bolmek en tehlikeli hata olurdu.
    const base = b?.baseline;
    if (!(base > 0)) { noBase++; return r; }

    // 3) Akil disi getiri: hisse perp'i bir seansta %35 oynamaz; oynadiysa
    //    muhtemelen yanlis piyasa ya da bozuk mum.
    const chg = pm.price / base - 1;
    if (!Number.isFinite(chg) || Math.abs(chg) > 0.35) { insane++; return r; }

    count++;
    return {
      ...r,
      baseline: base,
      price: pm.price,
      // Perp'ler surekli islem gorur — "islem yok" kovasina dusmemeliler.
      lastTradeAtUtc: nowUtc,
      baselineAtUtc: b.at ?? null,
      baselineSource: `hl-perp(${b.source})`,
      // Perp fiyat serisi spot acilisiyla ayni seyi ifade etmiyor.
      open: null,
    };
  });

  if (count === 0) {
    return { rows, overlay: { venue: map.venue, count: 0,
      reason: `cakisma:${collision} bazsiz:${noBase} akildisi:${insane}` } };
  }
  log.info('hl kaplamasi', { venue: map.venue, kaplanan: count, cakisma: collision, bazsiz: noBase });
  return { rows: out, overlay: {
    venue: map.venue, count, total: rows.length,
    symbols: out.filter((r) => r.baselineSource?.startsWith('hl-perp')).map((r) => r.symbol),
  } };
}

/* ---------- api.nasdaq.com: anahtarsiz, tek istekte tam kapsam ---------- */

let nasdaqCache = { at: 0, rows: null };

/**
 * En iyi ANAHTARSIZ yol: nasdaq.com'un kendi API'si, tek istekte 100 hisse
 * (fiyat + net degisimden turetilen baz). Anahtar istemez; kullanicinin
 * "anahtarla ugrasmak istemiyorum" talebini karsilar.
 *
 * @param {{holdings: any[], source: string, asOf: string}} weights
 * @param {number} nowUtc
 * @param {{live: boolean}} st
 */
async function tryNasdaq(weights, nowUtc, st) {
  let rows = nasdaqCache.rows;
  const ttl = st.live ? 30_000 : 3 * 60_000;
  if (!rows || nowUtc - nasdaqCache.at > ttl) {
    try {
      const r = await fetchNasdaq100();
      rows = r.rows;
      nasdaqCache = { at: nowUtc, rows };
    } catch (err) {
      return { ok: false, reason: `nasdaq.com: ${String(err?.message ?? err).slice(0, 90)}` };
    }
  }

  const byS = new Map(rows.map((r) => [r.symbol, r]));
  const built = [];
  for (const h of weights.holdings) {
    const q = byS.get(h.s);
    if (!q || !(q.price > 0) || !(q.prevClose > 0)) continue;
    // Fiyat prevClose'dan farkliysa bugun islem gormus demektir.
    const traded = Math.abs(q.price - q.prevClose) > 1e-9 || q.pct != null;
    built.push({
      symbol: h.s,
      name: h.n ?? q.name ?? h.s,
      sector: h.sector ?? null,
      shares: h.shares,
      baseline: q.prevClose,
      price: q.price,
      open: null,
      lastTradeAtUtc: traded ? nowUtc : startUtcOf(nowUtc) - 3600_000,
      baselineAtUtc: null,
      baselineSource: 'nasdaq-prevclose',
    });
  }
  if (built.length < 85) {
    return { ok: false, reason: `nasdaq.com: yalnizca ${built.length} eslesme (<85)` };
  }

  const ref = await storage.readJson('ndx-ref.json');
  const ndxBase = ref?.ndxBase > 0 ? ref.ndxBase : 25400;
  const warnings = [];
  if (!(ref?.ndxBase > 0)) warnings.push('ndx-ref-approx');
  if (weights.source !== 'invesco') warnings.push('weights-approx');

  return { ok: true, raw: {
    rows: built,
    ndxBase,
    nowUtc,
    observedAt: nasdaqCache.at,
    officialRegularPct: null,
    officialRegularLevel: null,
    quality: {
      source: 'nasdaq.com',
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing: weights.holdings.map((h) => h.s).filter((x) => !built.some((b) => b.symbol === x)),
      warnings,
    },
  } };
}

/**
 * Birincil (hisse) kaynagin sonucuna HL kaplamasini uygular ve sonucu
 * `quality` icinde gorunur kilar. Kaplama basarisiz olursa ham sonuc aynen
 * doner — kaplama bir IYILESTIRME, bagimlilik degil.
 *
 * @param {any} raw
 * @param {number} startUtc
 * @param {number} nowUtc
 */
async function withOverlay(raw, startUtc, nowUtc) {
  try {
    const { rows, overlay } = await applyHlOverlay(raw.rows, startUtc, nowUtc);
    if (!overlay?.count) {
      return { ...raw, quality: { ...raw.quality, overlay: overlay ?? null } };
    }
    return {
      ...raw,
      rows,
      // Kaplanmis satirlarin fiyati her poll'da degisiyor; kaynak onbellegi
      // artik "gozlem tazeligi" olcusu degil. Bant her turu kaydetmeli.
      observedAt: nowUtc,
      quality: {
        ...raw.quality,
        source: `${raw.quality.source}+hl`,
        overlay,
        warnings: [...(raw.quality.warnings ?? []), 'hl-overlay'],
      },
    };
  } catch (err) {
    log.warn('hl kaplamasi atlandi', { err: String(err?.message ?? err) });
    return raw;
  }
}

/** Kucuk yardimci: nasdaq yolu startUtc'yi disaridan almiyor. */
function startUtcOf(nowUtc) {
  return sessionStartUtc(nowUtc);
}

/* ---------- Finnhub: anahtarli BIRINCIL yol ---------- */

let finnhubCache = { at: 0, map: null };

/**
 * FINNHUB_KEY ayarliysa birincil kaynak budur — anahtarsiz kaynaklarin IP
 * savaslarindan tamamen bagimsiz. Tam tarama ~2 dk surer (60/dk siniri);
 * canli seansta her poll'da, kapali piyasada 30 dk'da bir tazelenir.
 *
 * @param {{holdings: any[], source: string, asOf: string}} weights
 * @param {number} startUtc
 * @param {number} nowUtc
 * @param {{live: boolean}} st
 */
async function tryFinnhub(weights, startUtc, nowUtc, st) {
  if (!config.finnhubKey) return { ok: false, reason: 'finnhub: anahtar yok (FINNHUB_KEY)' };
  const symbols = weights.holdings.map((h) => h.s);

  let map = finnhubCache.map;
  const ttl = st.live ? 4 * 60_000 : 30 * 60_000;
  if (!map || nowUtc - finnhubCache.at > ttl) {
    // QQQ da taranir: resmi ana-seans %'si icin ^NDX vekili (izleme farki
    // birkac baz puan). Ucretsiz katman endeks kotasyonu vermiyor.
    const r = await fetchFinnhubQuotes([...symbols, 'QQQ'], config.finnhubKey);
    if (r.map.size < 85) {
      return { ok: false, reason: `finnhub: yalnizca ${r.map.size} kotasyon (${r.reasons.join(' | ') || '?'})` };
    }
    map = r.map;
    finnhubCache = { at: nowUtc, map };
  }

  const rows = [];
  for (const h of weights.holdings) {
    const q = map.get(h.s);
    if (!q) continue;
    rows.push({
      symbol: h.s,
      name: h.n ?? h.s,
      sector: h.sector ?? null,
      shares: h.shares,
      baseline: q.prevClose,
      price: q.price,
      open: q.open,
      lastTradeAtUtc: q.at,
      baselineAtUtc: null,
      baselineSource: 'finnhub-prevclose',
    });
  }
  if (rows.length < 85) {
    return { ok: false, reason: `finnhub: yalnizca ${rows.length} satir kurulabildi` };
  }

  const ref = await storage.readJson('ndx-ref.json');
  const ndxBase = ref?.ndxBase > 0 ? ref.ndxBase : 25400;
  const warnings = [];
  if (!(ref?.ndxBase > 0)) warnings.push('ndx-ref-approx');
  if (weights.source !== 'invesco') warnings.push('weights-approx');

  const qqq = map.get('QQQ');
  return { ok: true, raw: {
    rows,
    ndxBase,
    nowUtc,
    observedAt: finnhubCache.at,
    officialRegularPct: qqq?.dp ?? null,
    officialRegularLevel: null,
    quality: {
      source: 'finnhub',
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing: symbols.filter((s2) => !rows.some((r2) => r2.symbol === s2)),
      warnings,
    },
  } };
}

/* ---------- Stooq: gecikmeli ama TAM kapsamli yedek ---------- */

/** Gunluk istek limiti icin kotasyonlar 9 dk onbellekte tutulur. */
let stooqQuoteCache = { at: 0, map: null };
/** @type {{day: string, map: Map<string, any>}|null} */
let stooqBaselineCache = null;

/**
 * Stooq yolu: ~15 dk gecikmeli ama 101 sembolun TAMAMI — genislik istatistigi
 * ancak tam kapsamla hesaplanabilir, o yuzden kripto kismi-kapsamindan once.
 *
 * @param {{holdings: any[], source: string, asOf: string}} weights
 * @param {number} startUtc
 * @param {number} nowUtc
 * @param {{usDate: string, live: boolean}} st seans durumu
 */
async function tryStooq(weights, startUtc, nowUtc, st) {
  if (stooqBlocked()) {
    return { ok: false, reason: `stooq: limit sogumasi (${stooqInfo().remainingSec} sn)` };
  }
  const symbols = weights.holdings.map((h) => h.s);

  // Kotasyonlar — onbellek suresi istek sayisina gore ayarlanir: tek istekle
  // calisirken 9 dk, parcali moddayken daha seyrek (gunluk limit butcesi).
  let quotes = stooqQuoteCache.map;
  const ttlMs = Math.max(9, (stooqQuoteCache.requests ?? 1) * 4) * 60_000;
  if (!quotes || nowUtc - stooqQuoteCache.at > ttlMs) {
    try {
      const r = await fetchStooqQuotes([...symbols, NDX]);
      quotes = r.map;
      stooqQuoteCache = { at: nowUtc, map: quotes, requests: r.requests };
      // Kendi kendini besleme: bugunun kapanis kotasyonlari, YARININ TSI
      // bazidir (kisin birebir). Her tazelemede diske yazilir; ertesi gun
      // bazlar SIFIR ek istekle buradan kurulur.
      await storage.writeJson('stooq-quotes.json', {
        at: nowUtc,
        entries: [...quotes].map(([sym, q]) => [sym, { price: q.price, date: q.date }]),
      });
    } catch (err) {
      return { ok: false, reason: `stooq: ${String(err?.message ?? err).slice(0, 80)}` };
    }
  }

  // Bazlar — gunde bir. Kaynak oncelik sirasi:
  //   1) bu gunun volume dosyasi
  //   2) dunku kotasyon anlik goruntusu (SIFIR ek istek — onceki islem
  //      gununun kapanislari zaten elimizde)
  //   3) q/d/l gunluk-seri yayilimi (102 istek; yalniz soguk baslangicta)
  //   4) eksik kalanlar icin bugunun ACILISI (gece boslugunu kacirir ama
  //      hisseyi dusurmekten iyidir; kaynakta isaretlenir)
  const day = tsiDate(startUtc + 1000);
  if (stooqBaselineCache?.day !== day) {
    const rel = `baseline/${day}.stooq.json`;
    const saved = await storage.readJson(rel);
    if (saved?.entries?.length) {
      stooqBaselineCache = { day, map: new Map(saved.entries) };
    } else {
      /** @type {Map<string, any>} */
      const m = new Map();

      const prevDay = previousTradingDay(st.usDate);
      const snap = await storage.readJson('stooq-quotes.json');
      if (snap?.entries?.length) {
        for (const [sym, q] of snap.entries) {
          if (q?.date === prevDay && q.price > 0) {
            m.set(sym, { baseline: q.price, date: q.date, source: 'stooq-prev-quote' });
          }
        }
      }

      if (m.size < 85) {
        const missing = [...symbols, NDX].filter((s2) => !m.has(s2));
        const fetched = await fetchStooqBaselines(missing, st.usDate);
        for (const [k, v] of fetched) m.set(k, v);
      }

      // 4. kademe: hala eksikse bugunun acilisi.
      for (const s2 of [...symbols, NDX]) {
        if (m.has(s2)) continue;
        const q = quotes.get(s2);
        if (q?.date === st.usDate && q.open > 0) {
          m.set(s2, { baseline: q.open, date: st.usDate, source: 'stooq-open-approx' });
        }
      }

      stooqBaselineCache = { day, map: m };
      await storage.writeJson(rel, { day, entries: [...m] });
    }
  }
  const baselines = stooqBaselineCache.map;

  const rows = [];
  for (const h of weights.holdings) {
    const q = quotes.get(h.s);
    const b = baselines.get(h.s);
    if (!q || !(b?.baseline > 0)) continue;
    // Kotasyon tarihi bu seansin ABD gunu degilse hisse bugun HENUZ islem
    // gormemis demektir (gecikme/kapali piyasa) — fiyat baza esitlenir ve
    // "islemYok" kovasina duser; sahte sifir-degisim yaratmaz, durust olur.
    const traded = q.date === st.usDate;
    rows.push({
      symbol: h.s,
      name: h.n ?? h.s,
      sector: h.sector ?? null,
      shares: h.shares,
      baseline: b.baseline,
      price: traded ? q.price : b.baseline,
      open: traded ? q.open : null,
      lastTradeAtUtc: traded ? nowUtc : startUtc - 3600_000,
      baselineAtUtc: null,
      baselineSource: b.source,
    });
  }
  if (rows.length < 85) {
    return { ok: false, reason: `stooq: yalnizca ${rows.length} sembol cozuldu (<85)` };
  }

  // ^NDX: onceki kapanis, NDX_base tanimimizin birebir kendisi.
  const ndxQ = quotes.get(NDX);
  const ndxB = baselines.get(NDX);
  const ndxBase = ndxB?.baseline ?? null;
  if (!(ndxBase > 0)) {
    return { ok: false, reason: 'stooq: ^NDX referansi alinamadi' };
  }
  await storage.writeJson('ndx-ref.json', { ndxBase, at: nowUtc });

  const warnings = ['stooq-delayed'];
  if (weights.source !== 'invesco') warnings.push('weights-approx');

  return { ok: true, raw: {
    rows,
    ndxBase,
    nowUtc,
    officialRegularPct: ndxQ && ndxQ.date === st.usDate && ndxBase > 0
      ? +(((ndxQ.price / ndxBase) - 1) * 100).toFixed(4)
      : null,
    officialRegularLevel: ndxQ?.date === st.usDate ? ndxQ.price : null,
    quality: {
      source: 'stooq',
      weightsSource: weights.source === 'bundled-approx' ? 'bundled-approx' : weights.source,
      weightsAsOf: weights.asOf,
      missing: symbols.filter((s2) => !rows.some((r) => r.symbol === s2)),
      warnings,
    },
  } };
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
  /** Her katmanin basarisizlik sebebi buraya birikir — hata mesajina gider. */
  const why = [];

  // KAYNAK SIRASI — anahtarsiz ve veri merkezi IP'sinden GERCEKTEN calisan
  // uclar once. Sira, tahminle degil olcumle belirlendi: Yahoo bulut
  // IP'lerine 34 ms'de 429 basiyor, Stooq 404 veriyor. Asagidaki ilk uc
  // kaynak ise ayni ag konumundan calisan uretim kodunda kanitli.

  // 0) TRADINGVIEW — tek POST, 100 hisse, PRE/AFTER MARKET DAHIL. "Seans
  //    disi da dahil" gereksinimini karsilayan tek anahtarsiz kaynak.
  {
    const tv = await tryTradingView(weights, startUtc, nowUtc, st);
    if (tv.ok) return withOverlay(tv.raw, startUtc, nowUtc);
    why.push(tv.reason);
  }

  // 1) NASDAQ.COM — tek istekte 100 hisse (ana seans odakli). Tarayici
  //    User-Agent'i sart; UA'siz istek 403 aliyor.
  {
    const nd = await tryNasdaq(weights, nowUtc, st);
    if (nd.ok) return withOverlay(nd.raw, startUtc, nowUtc);
    why.push(nd.reason);
  }

  // 2) HYPERLIQUID (HIP-3 `xyz` dex'i) — hisse perp'leri. Kismi kapsam ama
  //    7/24 fiyat verir; kullanicinin kendi projesi fiyatlarini buradan
  //    okuyor. Kapsam yetersizse asagidaki katmanlar devam eder.
  {
    const cr = await tryCrypto(weights, startUtc, nowUtc);
    if (cr.ok) return cr.raw;
    why.push(cr.reason);
  }

  // 3) FINNHUB — yalnizca anahtar varsa; artik birincil DEGIL.
  if (config.finnhubKey) {
    const fh = await tryFinnhub(weights, startUtc, nowUtc, st);
    if (fh.ok) return fh.raw;
    why.push(fh.reason);
  }

  // YOL SIRASI — ucuzdan pahaliya, anahtarsizdan kapiliya:
  //   1) spark  : toplu, crumb YOK, ~5 istek                 ← birincil
  //   2) chart  : sembol basina, crumb YOK, ~102 istek
  //   3) quotes : crumb GEREKLI, 3 istek — varsayilan KAPALI
  // Onceden sira tersineydi ve en cok kisitlanan uctan baslamak, ondan
  // bagimsiz olmasi gereken uclari da zehirliyordu.
  /** @type {Map<string, any>|null} */
  let series = null;
  let seriesVia = null;

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
    // Yahoo'nun da hicbir ucu calismadi. Son katman: stooq (gecikmeli ama TAM
    // kapsam). Kripto yolu yukarida zaten denendi — tekrar denemek iki borsayi
    // bosuna dover. Her katmanin basarisizlik SEBEBI hata mesajina eklenir;
    // "calismadi" teshis icin yetersiz.
    const stq = await tryStooq(weights, startUtc, nowUtc, st);
    if (stq.ok) return stq.raw;
    why.push(stq.reason);

    throw new Error(`Hicbir veri kaynagi calismadi. ${why.join(' || ')}`);
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
