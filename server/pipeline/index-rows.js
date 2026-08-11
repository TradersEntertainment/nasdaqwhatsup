/**
 * IKINCIL endeksler (S&P 500, Dow 30) icin satir kurucu.
 *
 * ── Neden NDX yolundan ayri ──
 * NDX yolu altı basamakli bir yedek merdiveni tasiyor (TradingView →
 * nasdaq.com → Hyperliquid → Finnhub → Yahoo → Stooq) ve gercek pay
 * adetleriyle besleniyor. Sitenin cikis sorusu NDX uzerine kurulu; o yolun
 * dayanikliligini bozmamak icin ikincil endeksler AYRI ve daha basit bir
 * yoldan gecer: yalnizca TradingView (+ Hyperliquid kaplamasi).
 *
 * Sonuc: TradingView duserse NDX yine calisir, S&P/Dow o turda guncellenmez.
 * Dogru odunlesme bu — ana soruyu yedeksiz birakmaktansa yan endeksleri
 * bekletmek.
 *
 * ── Agirliklar ──
 *   Dow 30   → FIYAT agirlikli: payAdedi = 1 (bkz. shared/indices.js)
 *   S&P 500  → kap agirlikli: payAdedi = piyasaDegeri / fiyat
 *
 * S&P'de gercek (serbest dolasim duzeltmeli) pay adedi elde yok — iShares
 * CSV'si veri merkezi IP'sinden gelmiyor. Piyasa degerinden turetilen agirlik
 * dusuk halka aciklik oranli sirketlerde resmi agirliktan sapar; arayuz bunu
 * soyler, `trackingErrorPp` de olcer.
 *
 * ── Endeks SEVIYESI ──
 * Bu endekslerin puan cinsinden seviyesi anahtarsiz olarak elde edilemiyor.
 * Uydurmak yerine `ndxBase = 0` gonderiliyor: yuzdeler tam dogru, "puan"
 * gosterimi ise kapaniyor (arayuz seviye yoksa yuzde puanina duser).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';
import { log } from '../lib/log.js';
import * as storage from '../storage.js';
import { fetchMembers } from '../sources/members.js';
import { fetchTradingView, toSessionRow, fetchMarketCaps } from '../sources/tradingview.js';
import { indexDef, weightShares } from '../../shared/indices.js';
import { sessionState, tsiDayHasTrading } from '../../shared/session.js';

/** Uye listesi ve piyasa degerleri gunde iki kez tazelenir. */
const TTL_MS = 12 * 3600_000;

/** @type {Map<string, {at: number, members: any[], source: string, caps: Map<string, number>}>} */
const cache = new Map();

/**
 * Uye listesi + (gerekiyorsa) piyasa degerleri. Diske de yazilir ki yeniden
 * baslatma her seferinde Wikipedia'yi dovmesin.
 *
 * @param {string} key
 * @param {number} nowUtc
 */
async function getUniverse(key, nowUtc) {
  const hit = cache.get(key);
  if (hit && nowUtc - hit.at < TTL_MS) return hit;

  const rel = `members/${key}.json`;
  const saved = await storage.readJson(rel);
  if (saved?.at && nowUtc - saved.at < TTL_MS && saved.members?.length) {
    const built = {
      at: saved.at, members: saved.members, source: saved.source ?? 'cache',
      caps: new Map(saved.caps ?? []),
    };
    cache.set(key, built);
    return built;
  }

  const found = await fetchMembers(/** @type {any} */ (key));
  if (!found) {
    // Kaynak dusmuşse ESKI onbellek bos listeden iyidir — uyelik yavas degisir.
    if (saved?.members?.length) {
      const built = { at: saved.at ?? 0, members: saved.members,
        source: 'stale-cache', caps: new Map(saved.caps ?? []) };
      cache.set(key, built);
      return built;
    }
    return null;
  }

  const def = indexDef(key);
  /** @type {Map<string, number>} */
  let caps = new Map();
  // Kap agirlikli ve gercek pay adedi yoksa piyasa degeri SART.
  if (def.weighting === 'cap' && !found.members.some((m) => m.shares > 0)) {
    try {
      caps = await fetchMarketCaps(found.members.map((m) => m.symbol));
    } catch (err) {
      log.warn('piyasa degerleri alinamadi — endeks acilmayacak', {
        endeks: key, err: String(err?.message ?? err).slice(0, 90),
      });
      return null;
    }
  }

  const built = { at: nowUtc, members: found.members, source: found.source, caps };
  cache.set(key, built);
  await storage.writeJson(rel, {
    at: nowUtc, members: found.members, source: found.source, caps: [...caps],
  });
  return built;
}

/** NDX seed'indeki sirket adlari — S&P/Dow uyeleri icin de cogu tutar. */
let nameMap = null;
function getNames() {
  if (!nameMap) {
    try {
      const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'holdings.seed.json'), 'utf8'));
      nameMap = new Map(seed.holdings.map((h) => [h.s, h.n]));
    } catch { nameMap = new Map(); }
  }
  return nameMap;
}

/**
 * Bir endeksin ham satirlarini kurar (buildSnapshot ile ayni sekil).
 *
 * @param {string} key
 * @param {number} nowUtc
 * @returns {Promise<any|null>} kurulamazsa null
 */
export async function fetchIndexRows(key, nowUtc = Date.now()) {
  const def = indexDef(key);
  const uni = await getUniverse(key, nowUtc);
  if (!uni?.members?.length) return null;

  const symbols = uni.members.map((m) => m.symbol);
  const { map, extended } = await fetchTradingView(symbols);
  if (map.size === 0) return null;

  const st = sessionState(nowUtc);
  const hasTrading = tsiDayHasTrading(st.tsiDate);
  const names = getNames();

  const rows = [];
  /** @type {string[]} */
  const missing = [];

  for (const m of uni.members) {
    const rec = map.get(m.symbol);
    if (!rec) { missing.push(m.symbol); continue; }
    const sr = toSessionRow(rec, st.phase, hasTrading);
    if (!sr) { missing.push(m.symbol); continue; }

    // Agirlik icin "pay adedi": fiyat agirlikli endekste 1, kap agirliklida
    // gercek adet ya da piyasaDegeri/fiyat.
    const shares = weightShares(def.weighting, {
      shares: m.shares,
      marketCap: uni.caps.get(m.symbol) ?? rec.marketCap ?? null,
      price: sr.baseline,
    });
    if (!(shares > 0)) { missing.push(m.symbol); continue; }

    rows.push({
      symbol: m.symbol,
      name: names.get(m.symbol) ?? m.symbol,
      sector: null,
      shares,
      baseline: sr.baseline,
      price: sr.price,
      open: sr.open,
      lastTradeAtUtc: sr.traded ? nowUtc : st.sessionStartUtc - 3600_000,
      baselineAtUtc: null,
      baselineSource: st.phase === 'REGULAR' || st.phase === 'AFTER_HOURS'
        ? 'tv-prevclose' : 'tv-lastclose',
    });
  }

  if (rows.length < def.minMembers) {
    log.warn('endeks icin yeterli satir kurulamadi', {
      endeks: key, satir: rows.length, esik: def.minMembers,
    });
    return null;
  }

  const warnings = [];
  if (!extended) warnings.push('no-extended-hours');
  // Kap agirlikli endekste agirlik piyasa degerinden turetildiyse: bu deger
  // serbest dolasim duzeltmeli DEGIL, sapma olur. Gizlenmez.
  if (def.weighting === 'cap' && !uni.members.some((m) => m.shares > 0)) {
    warnings.push('weights-from-marketcap');
  }

  return {
    rows,
    // Seviye bilinmiyor: puan gosterimi kapanir, yuzdeler tam dogru kalir.
    ndxBase: 0,
    nowUtc,
    observedAt: nowUtc,
    officialRegularPct: null,
    officialRegularLevel: null,
    minConstituents: def.minMembers,
    quality: {
      source: 'tradingview',
      weightsSource: uni.source,
      weightsAsOf: new Date(uni.at).toISOString(),
      missing,
      warnings,
    },
  };
}
