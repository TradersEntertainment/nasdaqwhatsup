/**
 * Kripto borsalarindaki hisse senedi piyasalari (Hyperliquid / Binance).
 *
 * ⚠ ONEMLI SINIR — bunu kullanmadan once oku:
 *
 * Bu kaynak NASDAQ-100'un TAMAMINI veremez. Verebilse bile fiyatlar SPOT
 * HISSE fiyati degil, PERP/token fiyatidir: dayanak varliktan sapar (funding,
 * likidite, hafta sonu islemi). Endeks matematigi spot fiyat varsayar.
 *
 * Kismi kapsam sitenin ana sorusunu OLDURUR:
 *   "endeks +%0,80 ama 99 hissenin %62'si kirmizi"
 * Bu cumledeki %62'yi hesaplamak icin 99 hissenin hepsi gerekir. 10 mega-cap
 * ile hesaplanan "genislik" yanlis olur — ve yanlis bir sayiyi dogru gibi
 * gostermek, hic gostermemekten kotudur.
 *
 * Bu yuzden buradan gelen veri YALNIZCA kismi-kapsam modunda kullanilir ve
 * arayuz neyin eksik oldugunu acikca soyler.
 *
 * ⚠ Bu dosya bu container'dan test EDILEMEZ (cikis politikasi engelliyor).
 * `npm run discover-equities` ya da `/api/discover` ile Railway'de calistirin.
 */

import { fetchWithTimeout, withRetry, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const BINANCE_24H = 'https://api.binance.com/api/v3/ticker/24hr';

/**
 * Hyperliquid perp evreni + anlik baglamlar.
 * `metaAndAssetCtxs` iki paralel dizi doner: [{universe:[...]}, [ctx...]]
 *
 * @returns {Promise<{name: string, price: number, prevDayPx: number|null, volume: number}[]>}
 */
export async function discoverHyperliquid() {
  const json = await withRetry(async () => {
    const res = await fetchWithTimeout(HL_INFO, {
      method: 'POST',
      timeoutMs: 15_000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    assertOk(res, HL_INFO);
    return res.json();
  }, { tries: 2, label: 'hyperliquid' });

  const universe = json?.[0]?.universe;
  const ctxs = json?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) {
    throw new Error('Hyperliquid cevabi taninmadi (metaAndAssetCtxs sekli degismis olabilir)');
  }

  const out = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i]?.name;
    const c = ctxs[i] ?? {};
    const price = Number(c.markPx ?? c.midPx ?? c.oraclePx);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    out.push({
      name: String(name).toUpperCase(),
      price,
      prevDayPx: Number.isFinite(Number(c.prevDayPx)) ? Number(c.prevDayPx) : null,
      volume: Number(c.dayNtlVlm) || 0,
    });
  }
  return out;
}

/**
 * Binance 24 saatlik ticker'lari. Hisse tokenlari varsa {TICKER}USDT gibi
 * isimlerle gorunur.
 *
 * @returns {Promise<{name: string, price: number, prevDayPx: number|null, volume: number}[]>}
 */
export async function discoverBinance() {
  const json = await withRetry(async () => {
    const res = await fetchWithTimeout(BINANCE_24H, { timeoutMs: 20_000 });
    assertOk(res, BINANCE_24H);
    return res.json();
  }, { tries: 2, label: 'binance' });

  if (!Array.isArray(json)) throw new Error('Binance cevabi taninmadi');

  const out = [];
  for (const t of json) {
    const sym = String(t?.symbol ?? '');
    const price = Number(t?.lastPrice);
    if (!sym || !Number.isFinite(price) || price <= 0) continue;
    // Yalnizca USD'ye endeksli cesitler; hisse fiyati USD cinsinden anlamli.
    const m = /^([A-Z0-9]+)(USDT|USDC|BUSD|FDUSD|TUSD)$/.exec(sym);
    if (!m) continue;
    const open = Number(t?.openPrice);
    out.push({
      name: m[1],
      price,
      prevDayPx: Number.isFinite(open) && open > 0 ? open : null,
      volume: Number(t?.quoteVolume) || 0,
    });
  }
  return out;
}

/**
 * Iki borsayi da sorgulayip NDX sembolleriyle KESISIMINI raporlar.
 *
 * Amac tahmin etmemek: hangi hissenin nerede oldugunu ve hacmini veri
 * soylesin. Hicbir eslesme yoksa bunu net sekilde raporlar.
 *
 * @param {string[]} ndxSymbols
 */
export async function discoverEquityMarkets(ndxSymbols) {
  const want = new Set(ndxSymbols.map((s) => s.toUpperCase()));
  /** @type {Record<string, any>} */
  const report = {};

  for (const [venue, fn] of [['hyperliquid', discoverHyperliquid], ['binance', discoverBinance]]) {
    try {
      const all = await fn();
      const matched = all.filter((m) => want.has(m.name));
      matched.sort((a, b) => b.volume - a.volume);
      report[venue] = {
        ok: true,
        totalMarkets: all.length,
        matched: matched.length,
        coveragePct: +((matched.length / want.size) * 100).toFixed(1),
        totalVolumeUsd: Math.round(matched.reduce((s, m) => s + m.volume, 0)),
        symbols: matched.map((m) => ({
          s: m.name, price: m.price, volume: Math.round(m.volume),
        })),
      };
      log.info(`${venue} kesfi`, {
        toplamPiyasa: all.length, eslesen: matched.length,
        hacimUsd: report[venue].totalVolumeUsd,
      });
    } catch (err) {
      report[venue] = { ok: false, error: String(err?.message ?? err) };
      log.warn(`${venue} kesfi basarisiz`, { err: String(err?.message ?? err) });
    }
  }

  // Hangisi daha hacimli? Karari veri versin.
  const candidates = Object.entries(report)
    .filter(([, v]) => v.ok && v.matched > 0)
    .sort((a, b) => b[1].totalVolumeUsd - a[1].totalVolumeUsd);

  return {
    ndxSymbolCount: want.size,
    venues: report,
    recommended: candidates[0]?.[0] ?? null,
    verdict: candidates.length === 0
      ? 'Hicbir borsada NASDAQ-100 sembolleriyle eslesen piyasa bulunamadi.'
      : `${candidates[0][0]} daha hacimli: ${candidates[0][1].matched}/${want.size} sembol ` +
        `(%${candidates[0][1].coveragePct} kapsam), 24s hacim ` +
        `$${candidates[0][1].totalVolumeUsd.toLocaleString('en-US')}.`,
  };
}

/**
 * Kesfedilen borsadan fiyat cek.
 *
 * @param {'hyperliquid'|'binance'} venue
 * @param {string[]} ndxSymbols
 * @returns {Promise<Map<string, {price: number, prevDayPx: number|null, volume: number}>>}
 */
export async function fetchCryptoPrices(venue, ndxSymbols) {
  const want = new Set(ndxSymbols.map((s) => s.toUpperCase()));
  const all = venue === 'binance' ? await discoverBinance() : await discoverHyperliquid();
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const m of all) {
    if (want.has(m.name)) out.set(m.name, m);
  }
  return out;
}
