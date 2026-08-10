/**
 * Stooq — anahtarsiz, veri merkezi IP'lerine gorece dost, GECIKMELI (~15 dk).
 *
 * Merdivendeki yeri: Yahoo'dan sonra, kripto kismi-kapsamindan ONCE. Cunku
 * Stooq TAM KAPSAM verir: 101 sembol tek istekte. Gecikmeli veri, 12 perp'ten
 * iyidir — genislik istatistigi ("hisselerin %62'si kirmizi") ancak tam
 * kapsamla hesaplanabilir.
 *
 * Bilinen sinirlar:
 * - Fiyatlar ~15 dk gecikmeli; UI bunu soyler.
 * - Gunluk istek limiti var (IP basina). Asilirsa duz metin bir uyari doner;
 *   yakalayip 6 saat sogumaya gecilir. Kotasyonlar bu yuzden 9 dakikalik
 *   onbellekle cekilir (limit butcesi: ~150 istek/gun + gunde 102 baz).
 * - Baz fiyat onceki gun kapanisidir: kisin TSI taniminda TAM DOGRU, yazin
 *   ~1 saatlik after-hours farki tasir (prev-close-approx ile ayni sinif).
 * - ^NDX icin onceki kapanis, NDX_base tanimimizin ("son ana seansin resmi
 *   kapanisi") birebir kendisidir.
 *
 * ⚠ Bu container'dan test edilemez (cikis politikasi 403). Ayristiricilar
 * test/stooq.test.js ile kapsanir; ag katmani Railway'de dogrulanir.
 */

import { fetchWithTimeout, withRetry, assertOk, pool } from '../lib/retry.js';
import { log } from '../lib/log.js';

const BASE = 'https://stooq.com';

/* ---------------- limit devre kesicisi ---------------- */

let blockedUntil = 0;

export function stooqBlocked() {
  return Date.now() < blockedUntil;
}

export function stooqInfo() {
  return {
    blocked: stooqBlocked(),
    remainingSec: Math.max(0, Math.round((blockedUntil - Date.now()) / 1000)),
  };
}

function noteHitLimit() {
  blockedUntil = Date.now() + 6 * 3600_000;
  log.warn('Stooq gunluk istek limiti — 6 saat sogumada');
}

async function getText(url, { timeoutMs = 15_000 } = {}) {
  const res = await fetchWithTimeout(url, { timeoutMs });
  assertOk(res, url);
  const text = await res.text();
  // Limit asiminda CSV yerine duz metin uyari doner.
  if (/exceeded the daily hits limit/i.test(text)) {
    noteHitLimit();
    throw Object.assign(new Error('stooq gunluk istek limiti asildi'), { permanent: true });
  }
  return text;
}

/* ---------------- saf ayristiricilar ---------------- */

/** @param {string} sym */
export function toStooqSymbol(sym) {
  return sym === '^NDX' ? '^ndx' : `${sym.toLowerCase()}.us`;
}

/** @param {string} s */
export function fromStooqSymbol(s) {
  const u = String(s).toUpperCase().trim();
  return u === '^NDX' ? '^NDX' : u.replace(/\.US$/, '');
}

/**
 * Kotasyon CSV'si: SYMBOL,DATE,TIME,OPEN,HIGH,LOW,CLOSE,VOLUME.
 * Bilinmeyen alanlar "N/D" gelir ve satir elenir.
 * @param {string} text
 * @returns {Map<string, {price: number, date: string, open: number|null}>}
 */
export function parseQuoteCsv(text) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || /^symbol[,;]/i.test(t)) continue;
    const f = t.split(',');
    if (f.length < 7) continue;
    const close = Number(f[6]);
    if (!Number.isFinite(close) || close <= 0) continue;
    const open = Number(f[3]);
    out.set(fromStooqSymbol(f[0]), {
      price: close,
      date: f[1],                          // YYYY-MM-DD (borsa gunu)
      open: Number.isFinite(open) && open > 0 ? open : null,
    });
  }
  return out;
}

/**
 * Gunluk seri CSV'si: Date,Open,High,Low,Close,Volume.
 * @param {string} text
 * @returns {{date: string, close: number}[]}
 */
export function parseDailyCsv(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || /^date[,;]/i.test(t)) continue;
    const f = t.split(',');
    if (f.length < 5) continue;
    const close = Number(f[4]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f[0]) && close > 0) rows.push({ date: f[0], close });
  }
  return rows;
}

/**
 * usDate'ten ONCEKI son islem gununun kapanisi — TSI bazi.
 * @param {{date: string, close: number}[]} rows
 * @param {string} usDate YYYY-MM-DD
 */
export function pickPrevClose(rows, usDate) {
  let best = null;
  for (const r of rows) {
    if (r.date < usDate && (!best || r.date > best.date)) best = r;
  }
  return best;
}

/* ---------------- ag katmani ---------------- */

/**
 * Kotasyon URL'si. Virguller LITERAL kalir: encodeURIComponent tum listeyi
 * %2C'lerle tek dev "sembole" ceviriyordu ve stooq 404 donuyordu — uretimde
 * yasandi. Sembol karakter kumesi ([a-z0-9.^-]) URL sorgusunda zaten guvenli.
 * @param {string[]} symbols
 */
export function buildQuoteUrl(symbols) {
  return `${BASE}/q/l/?s=${symbols.map(toStooqSymbol).join(',')}&f=sd2t2ohlcv&h&e=csv`;
}

/** Ise yaradigi bilinen parca boyutu — ilk basarida ogrenilir, sonra sabit. */
let preferredChunk = Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kotasyonlar — UYARLANIR parcalama.
 *
 * Stooq'un tek istekte kac sembol kabul ettigi belgelenmemis. Once tam liste
 * denenir; 404/bos gelirse 20'lik, sonra 10'luk parcalara dusulur ve calisan
 * boyut ezberlenir. Boylece format tahminine kod baglanmiyor — dogrulama
 * calisma zamaninda, bir kez.
 *
 * @param {string[]} symbols '^NDX' dahil olabilir
 * @returns {Promise<{map: Map<string, any>, requests: number}>}
 */
export async function fetchStooqQuotes(symbols) {
  if (stooqBlocked()) {
    throw Object.assign(new Error('stooq sogumada'), { permanent: true });
  }
  const SIZES = [Infinity, 20, 10];
  let lastErr = null;

  for (let si = Math.max(0, SIZES.indexOf(preferredChunk)); si < SIZES.length; si++) {
    const size = SIZES[si];
    const chunks = [];
    if (size === Infinity) chunks.push(symbols);
    else for (let i = 0; i < symbols.length; i += size) chunks.push(symbols.slice(i, i + size));

    try {
      /** @type {Map<string, any>} */
      const map = new Map();
      for (const [ci, ch] of chunks.entries()) {
        if (ci > 0) await sleep(250);
        const text = await withRetry(() => getText(buildQuoteUrl(ch)), {
          tries: 1, label: `stooq:q[${size === Infinity ? 'tum' : size}:${ci}]`,
        });
        for (const [k, v] of parseQuoteCsv(text)) map.set(k, v);
      }
      if (map.size === 0) throw new Error('bos/taninmayan CSV');
      if (preferredChunk !== size) {
        log.info('stooq parca boyutu ogrenildi', { boyut: size === Infinity ? 'tum-liste' : size });
        preferredChunk = size;
      }
      return { map, requests: chunks.length };
    } catch (err) {
      // Gunluk limit → daha kucuk parca denemek anlamsiz, hemen cik.
      if (/gunluk istek limiti/.test(String(err?.message))) throw err;
      lastErr = err;
      log.debug('stooq boyut denemesi basarisiz, kuculuyor', {
        boyut: size === Infinity ? 'tum' : size, err: String(err?.message ?? err).slice(0, 80),
      });
    }
  }
  throw lastErr ?? new Error('stooq kotasyon alinamadi');
}

/**
 * Bir sembolun onceki kapanisi (gunluk seriden, dar tarih penceresi).
 * @param {string} sym
 * @param {string} usDate seansin ABD islem gunu (YYYY-MM-DD)
 */
export async function fetchStooqPrevClose(sym, usDate) {
  if (stooqBlocked()) return null;
  const ymd = (iso) => iso.replaceAll('-', '');
  const from = new Date(Date.parse(usDate) - 14 * 86400_000).toISOString().slice(0, 10);
  const url = `${BASE}/q/d/l/?s=${encodeURIComponent(toStooqSymbol(sym))}` +
    `&d1=${ymd(from)}&d2=${ymd(usDate)}&i=d`;
  try {
    const text = await withRetry(() => getText(url), { tries: 1, label: `stooq:d:${sym}` });
    const prev = pickPrevClose(parseDailyCsv(text), usDate);
    return prev ? { baseline: prev.close, date: prev.date, source: 'stooq-prevclose' } : null;
  } catch {
    return null;
  }
}

/**
 * Tum semboller icin bazlar — gunde bir cagrilir, cagiran onbellekler.
 * @param {string[]} symbols
 * @param {string} usDate
 */
export async function fetchStooqBaselines(symbols, usDate) {
  const t0 = Date.now();
  const settled = await pool(symbols, 4, (sym) => fetchStooqPrevClose(sym, usDate), { spacingMs: 150 });
  /** @type {Map<string, any>} */
  const out = new Map();
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) out.set(symbols[i], r.value);
  });
  log.info('stooq bazlar', { ok: out.size, toplam: symbols.length, ms: Date.now() - t0 });
  return out;
}
