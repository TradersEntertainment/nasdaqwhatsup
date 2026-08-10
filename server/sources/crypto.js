/**
 * Kripto borsalarindaki hisse piyasalari (Hyperliquid / Binance).
 *
 * ⚠ ONEMLI SINIR:
 * Bu kaynak NASDAQ-100'un tamamini VEREMEZ ve verdigi fiyat spot hisse
 * fiyati DEGIL, perp/token fiyatidir (funding, likidite ve hafta sonu islemi
 * yuzunden sapar). Bu yuzden yalnizca KISMI-KAPSAM yedegi olarak kullanilir
 * ve arayuz neyin eksik oldugunu acikca soyler. Kismi kapsamla genislik
 * ("hisselerin %62'si kirmizi") hesaplanamaz — yanlis bir sayiyi dogru gibi
 * gostermek, hic gostermemekten kotudur.
 *
 * Hangi borsada hangi hissenin oldugu TAHMIN EDILMEZ: /api/discover ve
 * calisma zamanindaki kesif, kesisimi ve hacmi olcer; borsa secimini veri
 * yapar.
 *
 * ⚠ Bu dosya bu container'dan test edilemez (cikis politikasi engelliyor).
 * Saf ayristirma fonksiyonlari test/crypto.test.js ile kapsanir.
 */

import { fetchWithTimeout, withRetry, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const BINANCE = 'https://api.binance.com';

/* ------------------------------------------------------------------ */
/* Saf ayristiricilar — cevrimdisi test edilebilir                     */
/* ------------------------------------------------------------------ */

/**
 * Hyperliquid metaAndAssetCtxs cevabi: [{universe:[...]}, [ctx...]] — iki
 * paralel dizi.
 *
 * @param {any} json
 * @param {string} [dex] HIP-3 builder dex adi; ana evren icin ''.
 */
export function parseHlMetaCtxs(json, dex = '') {
  const universe = json?.[0]?.universe;
  const ctxs = json?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) return [];

  const out = [];
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i] ?? {};
    const c = ctxs[i] ?? {};
    if (!u.name || u.isDelisted) continue;
    const price = Number(c.markPx ?? c.midPx ?? c.oraclePx);
    if (!Number.isFinite(price) || price <= 0) continue;
    const raw = String(u.name);
    out.push({
      venue: 'hyperliquid',
      dex,
      name: raw.toUpperCase(),
      rawName: raw,
      // Builder dex'lerdeki coin'ler dis API'de "dex:AD" ile adreslenir.
      market: dex ? `${dex}:${raw}` : raw,
      price,
      prevDayPx: Number(c.prevDayPx) > 0 ? Number(c.prevDayPx) : null,
      volume: Number(c.dayNtlVlm) || 0,
    });
  }
  return out;
}

/**
 * Binance 24s ticker listesi. Hisse tokenlari varsa {TICKER}{USDT|...}
 * deseninde gorunur.
 * @param {any} json
 */
export function parseBinanceTickers(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const t of json) {
    const sym = String(t?.symbol ?? '');
    const price = Number(t?.lastPrice);
    if (!sym || !Number.isFinite(price) || price <= 0) continue;
    const m = /^([A-Z0-9]+?)(USDT|USDC|BUSD|FDUSD|TUSD)$/.exec(sym);
    if (!m) continue;
    const open = Number(t?.openPrice);
    out.push({
      venue: 'binance',
      dex: null,
      name: m[1],
      rawName: sym,
      market: sym,
      price,
      prevDayPx: Number.isFinite(open) && open > 0 ? open : null,
      volume: Number(t?.quoteVolume) || 0,
    });
  }
  return out;
}

/**
 * Piyasa listesini NDX sembolleriyle eslestirir.
 * - exact: birebir ad eslesmesi (ayni ad birden fazla dex'te varsa en
 *   hacimlisi kazanir)
 * - loose: adin icinde ticker gecen ama birebir olmayanlar — SADECE RAPOR
 *   icin (adlandirma "XNVDA" gibi degiskense insana gorunsun; koda tahminle
 *   baglanmaz)
 *
 * @param {ReturnType<typeof parseHlMetaCtxs>} markets
 * @param {string[]} symbols
 */
export function matchMarkets(markets, symbols) {
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  /** @type {Map<string, any>} */
  const exact = new Map();
  const loose = [];

  for (const m of markets) {
    if (want.has(m.name)) {
      const cur = exact.get(m.name);
      if (!cur || m.volume > cur.volume) exact.set(m.name, m);
      continue;
    }
    for (const sym of want) {
      if (sym.length >= 3 && m.name.includes(sym)) {
        loose.push({ market: m.market, venue: m.venue, matches: sym, volume: m.volume });
        break;
      }
    }
  }
  loose.sort((a, b) => b.volume - a.volume);
  return { exact, loose: loose.slice(0, 25) };
}

/**
 * Zaman serisi mumlarindan TSI bazi: sessionStart'tan KESINLIKLE onceki son
 * kapanis (Yahoo taraflarindaki kuralin aynisi).
 * @param {{t: number, c: number}[]} candles ms acilis zamani + kapanis
 * @param {number} sessionStartUtc
 */
export function candleBaseline(candles, sessionStartUtc) {
  let best = null;
  for (const k of candles) {
    if (Number.isFinite(k.t) && k.t < sessionStartUtc && k.c > 0 && (!best || k.t > best.t)) {
      best = k;
    }
  }
  return best ? { baseline: best.c, at: best.t } : null;
}

/* ------------------------------------------------------------------ */
/* Ag katmani                                                          */
/* ------------------------------------------------------------------ */

async function hlInfo(body, { tries = 2, label = 'hl' } = {}) {
  return withRetry(async () => {
    const res = await fetchWithTimeout(HL_INFO, {
      method: 'POST',
      timeoutMs: 15_000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assertOk(res, `${HL_INFO} ${body?.type}`);
    return res.json();
  }, { tries, label });
}

/** HIP-3 builder dex adlari. Hisse perp'leri genelde ana evrende DEGIL, bunlarda. */
export async function listHlDexes() {
  try {
    const json = await hlInfo({ type: 'perpDexs' }, { tries: 1, label: 'hl:perpDexs' });
    if (!Array.isArray(json)) return [];
    const names = [];
    for (const d of json) {
      const name = typeof d === 'string' ? d : d?.name;
      if (name && typeof name === 'string') names.push(name);
    }
    return [...new Set(names)].slice(0, 30);
  } catch (err) {
    log.debug('perpDexs alinamadi — yalniz ana evren', { err: String(err?.message ?? err) });
    return [];
  }
}

/**
 * @param {string[]} dexes '' ana evren demektir
 */
export async function fetchHlMarkets(dexes = ['']) {
  const out = [];
  for (const dex of dexes) {
    try {
      const body = dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' };
      const json = await hlInfo(body, { tries: 1, label: `hl:${dex || 'main'}` });
      out.push(...parseHlMetaCtxs(json, dex));
    } catch (err) {
      log.debug('HL dex okunamadi', { dex, err: String(err?.message ?? err) });
    }
    if (dexes.length > 1) await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

export async function fetchBinanceMarkets() {
  const json = await withRetry(async () => {
    const res = await fetchWithTimeout(`${BINANCE}/api/v3/ticker/24hr`, { timeoutMs: 20_000 });
    assertOk(res, 'binance 24hr');
    return res.json();
  }, { tries: 2, label: 'binance:24hr' });
  return parseBinanceTickers(json);
}

/**
 * TSI bazi icin mum kapanisi.
 * @param {'hyperliquid'|'binance'} venue
 * @param {{market: string, rawName?: string}} entry
 * @param {number} sessionStartUtc
 */
export async function fetchCandleBaseline(venue, entry, sessionStartUtc) {
  const startTime = sessionStartUtc - 2 * 86400_000;
  const endTime = sessionStartUtc + 60_000;

  if (venue === 'binance') {
    const url = `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(entry.market)}` +
      `&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=1000`;
    try {
      const json = await withRetry(async () => {
        const res = await fetchWithTimeout(url, { timeoutMs: 15_000 });
        assertOk(res, url);
        return res.json();
      }, { tries: 2, label: `bnKline:${entry.market}` });
      const candles = (Array.isArray(json) ? json : [])
        .map((k) => ({ t: Number(k?.[0]), c: Number(k?.[4]) }));
      const b = candleBaseline(candles, sessionStartUtc);
      return b ? { ...b, source: 'binance-kline' } : null;
    } catch { return null; }
  }

  // Hyperliquid: builder dex coin'i "dex:AD" ile adreslenir; bazi surumler
  // duz adi da kabul ediyor — once tam adres, olmazsa duz ad.
  const coins = entry.rawName && entry.rawName !== entry.market
    ? [entry.market, entry.rawName]
    : [entry.market];
  for (const coin of coins) {
    try {
      const json = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '5m', startTime, endTime },
      }, { tries: 1, label: `hlCandle:${coin}` });
      const candles = (Array.isArray(json) ? json : [])
        .map((k) => ({ t: Number(k?.t), c: Number(k?.c) }));
      const b = candleBaseline(candles, sessionStartUtc);
      if (b) return { ...b, source: 'hl-candle' };
    } catch { /* siradaki adres */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Kesif                                                               */
/* ------------------------------------------------------------------ */

/**
 * Iki borsayi da olcup NDX kesisimini raporlar. Borsa secimini VERI yapar.
 * @param {string[]} ndxSymbols
 */
export async function discoverEquityMarkets(ndxSymbols) {
  /** @type {Record<string, any>} */
  const report = {};

  const venues = [
    ['hyperliquid', async () => fetchHlMarkets(['', ...(await listHlDexes())])],
    ['binance', fetchBinanceMarkets],
  ];

  for (const [venue, fn] of venues) {
    try {
      const markets = await fn();
      const { exact, loose } = matchMarkets(markets, ndxSymbols);
      const matched = [...exact.values()].sort((a, b) => b.volume - a.volume);
      report[venue] = {
        ok: true,
        totalMarkets: markets.length,
        matched: matched.length,
        coveragePct: +((matched.length / ndxSymbols.length) * 100).toFixed(1),
        totalVolumeUsd: Math.round(matched.reduce((s, m) => s + m.volume, 0)),
        symbols: matched.map((m) => ({
          s: m.name, market: m.market, dex: m.dex, rawName: m.rawName ?? m.market,
          price: m.price, prevDayPx: m.prevDayPx, volume: Math.round(m.volume),
        })),
        looseMatches: loose,
      };
      log.info(`${venue} kesfi`, {
        piyasa: markets.length, eslesen: matched.length,
        hacimUsd: report[venue].totalVolumeUsd,
      });
    } catch (err) {
      report[venue] = { ok: false, error: String(err?.message ?? err) };
      log.warn(`${venue} kesfi basarisiz`, { err: String(err?.message ?? err) });
    }
  }

  const candidates = Object.entries(report)
    .filter(([, v]) => v.ok && v.matched > 0)
    .sort((a, b) => b[1].totalVolumeUsd - a[1].totalVolumeUsd);

  return {
    ndxSymbolCount: ndxSymbols.length,
    venues: report,
    recommended: candidates[0]?.[0] ?? null,
    verdict: candidates.length === 0
      ? 'Hicbir borsada NASDAQ-100 sembolleriyle birebir eslesen piyasa bulunamadi. ' +
        '(looseMatches alanina bakin — adlandirma farkli olabilir.)'
      : `${candidates[0][0]} daha hacimli: ${candidates[0][1].matched}/${ndxSymbols.length} sembol, ` +
        `24s hacim $${candidates[0][1].totalVolumeUsd.toLocaleString('en-US')}.`,
  };
}

/**
 * Secilen borsadan guncel fiyatlar — yalnizca haritadaki piyasalar icin.
 * @param {'hyperliquid'|'binance'} venue
 * @param {Record<string, {market: string, dex: string|null}>} entries sym -> piyasa
 * @returns {Promise<Map<string, {price: number, prevDayPx: number|null}>>}
 */
export async function fetchCryptoPrices(venue, entries) {
  const markets = venue === 'binance'
    ? await fetchBinanceMarkets()
    : await fetchHlMarkets([...new Set(Object.values(entries).map((e) => e.dex ?? ''))]);

  const byMarket = new Map(markets.map((m) => [m.market, m]));
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const [sym, e] of Object.entries(entries)) {
    const m = byMarket.get(e.market);
    if (m) out.set(sym, { price: m.price, prevDayPx: m.prevDayPx });
  }
  return out;
}
