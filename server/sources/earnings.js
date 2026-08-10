/**
 * Bilanco (earnings) takvimi — "yakinda bilanco var" uyarisi icin.
 *
 * Neden AYRI bir istek: takvim gunde bir degisir, fiyat her dakika. Takvim
 * kolonlarini fiyat istegine eklemek, gecersiz TEK bir kolon adinin butun
 * fiyat yolunu 400'e dusurmesi demekti. Ayirinca takvim en kotu ihtimalle
 * eksik kalir; fiyatlar akmaya devam eder.
 *
 * Kaynak sirasi:
 *   1) TradingView screener — `earnings_release_next_date` unix damgasi verir,
 *      saat ipucuyla birlikte. Tek istek, anahtarsiz.
 *   2) api.nasdaq.com takvimi — gun gun, 14 is gunu ileri. Tarayici
 *      User-Agent'i sart.
 *
 * Sonuc 12 saat onbelleklenir (volume'da da saklanir): bilanco tarihi bir
 * poll'dan digerine degismez.
 *
 * ⚠ Bu dosya bu container'dan test edilemez (403). Saf ayristiricilar
 * test/earnings.test.js ile kapsanir.
 */

import { fetchWithTimeout, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';
import * as storage from '../storage.js';
import { BROWSER_HEADERS } from './nasdaq.js';

const TTL_MS = 12 * 3600_000;
const HORIZON_DAYS = 21;

const TV_URL = 'https://scanner.tradingview.com/america/scan';
const TV_COLUMNS = ['name', 'earnings_release_next_date', 'earnings_release_next_time'];
const TV_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
};

/** TradingView saat enum'u. */
const TV_TIME = { 1: 'bmo', 2: 'amc' };
/** nasdaq.com saat etiketleri. */
const NASDAQ_TIME = { 'time-after-hours': 'amc', 'time-pre-market': 'bmo' };

/** @typedef {{dateEt: string, hint: 'bmo'|'amc'|'unknown', exactTs: number|null, source: string}} Earning */

/**
 * Unix saniyeden ET takvim tarihi. Bilanco tarihleri ABD borsa gunudur;
 * UTC'ye gore hesaplamak aksam duyurularini bir gun ileri kaydirir.
 * @param {number} sec
 */
export function etDateOf(sec) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(sec * 1000));
}

/**
 * ET duvar saatinden bmo/amc cikarimi. 09:30 ve oncesi acilis oncesi,
 * 15:00 ve sonrasi kapanis sonrasi; arasi belirsiz (yer tutucu saat olabilir).
 * @param {number} sec
 */
export function hintFromTs(sec) {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(sec * 1000));
  const [h, m] = hhmm.split(':').map(Number);
  if (h === 0 && m === 0) return 'unknown';        // yer tutucu
  const mins = h * 60 + m;
  if (mins <= 9 * 60 + 30) return 'bmo';
  if (mins >= 15 * 60) return 'amc';
  return 'unknown';
}

/**
 * TradingView cevabini takvime cevirir.
 * @param {any} json
 * @param {string} todayEt bugunun ET tarihi (YYYY-MM-DD)
 * @returns {Record<string, Earning>}
 */
export function parseTvEarnings(json, todayEt) {
  /** @type {Record<string, Earning>} */
  const out = {};
  for (const row of Array.isArray(json?.data) ? json.data : []) {
    const d = row?.d;
    if (!Array.isArray(d)) continue;
    const sym = String(d[0] ?? '').trim().toUpperCase();
    const ts = Number(d[1]);
    if (!sym || !Number.isFinite(ts) || ts <= 0) continue;

    const dateEt = etDateOf(ts);
    // Gecmis duyurular elenir; ufkun otesi "yakin" degildir.
    if (dateEt < todayEt) continue;

    const raw = Number(d[2]);
    let hint = 'unknown';
    let exactTs = null;
    if (Number.isFinite(raw) && raw > 100000) {
      // 3. kolon zaman damgasi olarak da gelebiliyor — dakikasi dakikasina.
      exactTs = raw;
      hint = hintFromTs(raw);
    } else if (Number.isFinite(raw) && TV_TIME[raw]) {
      hint = TV_TIME[raw];
    } else {
      hint = hintFromTs(ts);
    }
    out[sym] = { dateEt, hint, exactTs, source: 'tradingview' };
  }
  return out;
}

/**
 * nasdaq.com gunluk takvim cevabi.
 * @param {any} json
 * @param {string} dateEt
 * @param {Set<string>} want
 * @returns {Record<string, Earning>}
 */
export function parseNasdaqEarnings(json, dateEt, want) {
  /** @type {Record<string, Earning>} */
  const out = {};
  const rows = json?.data?.rows ?? json?.data?.data?.rows;
  for (const r of Array.isArray(rows) ? rows : []) {
    const sym = String(r?.symbol ?? '').trim().toUpperCase();
    if (!sym || !want.has(sym)) continue;
    out[sym] = {
      dateEt,
      hint: NASDAQ_TIME[r?.time ?? ''] ?? 'unknown',
      exactTs: null,
      source: 'nasdaq',
    };
  }
  return out;
}

/**
 * Bir bilancoya kalan gun sayisi ve insan diliyle ifadesi.
 *
 * @param {Earning} e
 * @param {string} todayEt bugunun ET tarihi
 * @returns {{inDays: number, dateEt: string, hint: string, text: string}|null}
 */
export function describe(e, todayEt) {
  if (!e?.dateEt) return null;
  const days = Math.round(
    (Date.parse(`${e.dateEt}T00:00:00Z`) - Date.parse(`${todayEt}T00:00:00Z`)) / 86400_000
  );
  if (!Number.isFinite(days) || days < 0 || days > HORIZON_DAYS) return null;

  const when = e.hint === 'bmo' ? 'açılış öncesi'
    : e.hint === 'amc' ? 'kapanış sonrası' : '';
  const day = days === 0 ? 'bugün' : days === 1 ? 'yarın' : `${days} gün sonra`;
  return {
    inDays: days,
    dateEt: e.dateEt,
    hint: e.hint,
    text: when ? `Bilanço ${day}, ${when}` : `Bilanço ${day}`,
  };
}

/* ------------------------------------------------------------------ */
/* Ag katmani                                                          */
/* ------------------------------------------------------------------ */

/** @type {{at: number, map: Record<string, Earning>, source: string}|null} */
let cache = null;

async function fetchFromTv(symbols, todayEt) {
  const res = await fetchWithTimeout(TV_URL, {
    method: 'POST',
    timeoutMs: 20_000,
    headers: TV_HEADERS,
    body: JSON.stringify({
      filter: [{ left: 'name', operation: 'in_range', right: symbols.slice(0, 500) }],
      options: { lang: 'en' },
      markets: ['america'],
      symbols: { query: { types: [] }, tickers: [] },
      columns: TV_COLUMNS,
      range: [0, 600],
    }),
  });
  assertOk(res, 'tradingview earnings');
  return parseTvEarnings(await res.json(), todayEt);
}

async function fetchFromNasdaq(symbols, todayEt) {
  const want = new Set(symbols);
  /** @type {Record<string, Earning>} */
  const out = {};
  const start = Date.parse(`${todayEt}T00:00:00Z`);

  for (let i = 0; i <= 14; i++) {
    const d = new Date(start + i * 86400_000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;            // hafta sonu duyuru yok
    const ds = d.toISOString().slice(0, 10);
    try {
      const res = await fetchWithTimeout(
        `https://api.nasdaq.com/api/calendar/earnings?date=${ds}`,
        { timeoutMs: 15_000, headers: BROWSER_HEADERS }
      );
      if (res.status !== 200) continue;
      // Ilk gelen kazanir: gunler artan sirada gezildigi icin bu, sembolun
      // EN YAKIN bilancosu demektir.
      for (const [sym, e] of Object.entries(parseNasdaqEarnings(await res.json(), ds, want))) {
        if (!out[sym]) out[sym] = e;
      }
    } catch { /* o gunu atla */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

/**
 * Takvimi getir (12 sa onbellekli, volume destekli).
 *
 * Hicbir kaynak calismazsa BOS harita doner ve hata FIRLATMAZ: bilanco
 * rozeti bir suslemedir, fiyat akisini dusurmemeli.
 *
 * @param {string[]} symbols
 * @param {string} todayEt
 * @returns {Promise<{map: Record<string, Earning>, source: string, asOf: number}>}
 */
export async function getEarnings(symbols, todayEt) {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return { ...cache, asOf: cache.at };

  const saved = await storage.readJson('earnings.json');
  if (saved?.at && now - saved.at < TTL_MS && saved.map) {
    cache = { at: saved.at, map: saved.map, source: saved.source ?? 'cache' };
    return { ...cache, asOf: cache.at };
  }

  for (const [name, fn] of [['tradingview', fetchFromTv], ['nasdaq', fetchFromNasdaq]]) {
    try {
      const map = await fn(symbols, todayEt);
      const n = Object.keys(map).length;
      if (n > 0) {
        cache = { at: now, map, source: name };
        await storage.writeJson('earnings.json', { at: now, map, source: name });
        log.info('bilanco takvimi', { kaynak: name, sembol: n });
        return { ...cache, asOf: now };
      }
      log.debug('bilanco takvimi bos', { kaynak: name });
    } catch (err) {
      log.debug('bilanco takvimi alinamadi', { kaynak: name, err: String(err?.message ?? err) });
    }
  }

  // Hepsi dustuyse: eski onbellek bos haritadan iyidir (tarihler yavas eskir).
  if (saved?.map) {
    cache = { at: saved.at ?? 0, map: saved.map, source: 'stale-cache' };
    return { ...cache, asOf: cache.at };
  }
  cache = { at: now, map: {}, source: 'yok' };
  return { ...cache, asOf: now };
}

export function _resetCache() { cache = null; }
