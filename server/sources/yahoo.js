/**
 * Yahoo Finance istemcisi — anahtarsiz, sifir bagimlilik.
 *
 * ⚠ BU DOSYA BU CONTAINER'DAN TEST EDILEMEZ. Cikis politikasi
 * query1/query2.finance.yahoo.com'u 403'le engelliyor. Dogrulamasi yalnizca
 * Railway'de yapilabilir (`node scripts/doctor.js` erisimi raporlar).
 * Bu yuzden her cagri zaman asimli, sarmalanmis ve yedekli yazildi.
 *
 * Iki katmanli tasarim — 5 dakikalik kadansi surdurulebilir kilan sey bu:
 *   BAZLAR   v8/chart, sembol basina, GUNDE BIR (acilis + TSI devri)  → ~101 istek
 *   KOTASYON v7/quote, 40'lik gruplar, HER 5 DAKIKA                   → 3 istek
 */

import { fetchWithTimeout, withRetry, assertOk, pool } from '../lib/retry.js';
import { log } from '../lib/log.js';

const Q1 = 'https://query1.finance.yahoo.com';
const Q2 = 'https://query2.finance.yahoo.com';

/* ------------------------------------------------------------------ */
/* Hiz siniri devre kesicisi                                           */
/*                                                                     */
/* Uretimde ogrenilen ders: 429 alinca YENIDEN DENEMEK felaket. Eski   */
/* kod tek poll dongusunde 321 istek atiyordu (5 spark parcasi x 3     */
/* deneme + 102 chart x 3 deneme) — yani hiz siniri hatasini kendi     */
/* kendine ateslenen bir sele ceviriyordu. 429 "bekle" demektir,       */
/* "tekrar dene" degil.                                                */
/* ------------------------------------------------------------------ */

let rateLimitedUntil = 0;
let strikes = 0;
const COOLDOWN_MIN = [5, 15, 30, 60, 120];

export function isRateLimited() {
  return Date.now() < rateLimitedUntil;
}

export function rateLimitInfo() {
  return {
    limited: isRateLimited(),
    remainingSec: Math.max(0, Math.round((rateLimitedUntil - Date.now()) / 1000)),
    strikes,
  };
}

function noteRateLimit() {
  strikes = Math.min(strikes + 1, COOLDOWN_MIN.length);
  const mins = COOLDOWN_MIN[strikes - 1];
  rateLimitedUntil = Date.now() + mins * 60_000;
  log.warn('Yahoo hiz siniri — tum istekler durduruluyor', { dakika: mins, strike: strikes });
}

function noteSuccess() {
  if (strikes) log.info('Yahoo yeniden calisiyor', { oncekiStrike: strikes });
  strikes = 0;
  rateLimitedUntil = 0;
}

/** @param {unknown} err */
const is429 = (err) => /** @type {any} */ (err)?.status === 429;

/* ------------------------------------------------------------------ */
/* Cookie kavanozu — Headers.getSetCookie() Node 22'de yerlesik.       */
/* ------------------------------------------------------------------ */

/** @type {Map<string, string>} */
const jar = new Map();

/** @param {Response} res */
function harvestCookies(res) {
  const list = res.headers.getSetCookie?.() ?? [];
  for (const line of list) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Cerez basligi YALNIZCA doluysa gonderilir.
 *
 * Onceden kosulsuz `Cookie: cookieHeader()` yaziliyordu; el sikismasi
 * basarisiz olunca kavanoz bos kaliyor ve istekler bos bir `Cookie:` basligi
 * tasiyordu. Bu anormal bir imza ve WAF'lar reddedebiliyor — yani crumb
 * yolunun cokusu, ondan BAGIMSIZ olmasi gereken chart yolunu da zehirliyordu.
 */
function authHeaders() {
  const c = cookieHeader();
  return c ? { Cookie: c } : {};
}

/**
 * Zaman serisinden baz / guncel fiyat / acilis cikarir.
 * chart ve spark uclari ayni sekli paylastigi icin tek yerde.
 *
 * @param {number[]} ts saniye cinsinden zaman damgalari
 * @param {(number|null)[]} close
 * @param {number} sessionStartUtc
 * @param {number|null} regOpenUtc
 */
function extractSeries(ts, close, sessionStartUtc, regOpenUtc) {
  const cutoff = Math.floor(sessionStartUtc / 1000);
  const openCut = regOpenUtc == null ? null : Math.floor(regOpenUtc / 1000);

  let baseline = null, baselineAt = null;
  let price = null, priceAt = null, open = null;

  for (let k = 0; k < ts.length; k++) {
    const c = close[k];
    if (!Number.isFinite(c) || c <= 0) continue;
    if (ts[k] < cutoff) {
      // Seanstan ONCEKI son gecerli bar bazdir (kosul `<`, `<=` degil).
      baseline = c;
      baselineAt = ts[k] * 1000;
    } else {
      price = c;
      priceAt = ts[k] * 1000;
      if (openCut != null && open === null && ts[k] >= openCut) open = c;
    }
  }
  return { baseline, baselineAt, price, priceAt, open };
}

/* ------------------------------------------------------------------ */
/* Crumb el sikismasi                                                  */
/* ------------------------------------------------------------------ */

/** @type {{crumb: string, at: number}|null} */
let session = null;
const CRUMB_TTL_MS = 6 * 3600_000;

async function handshake() {
  jar.clear();

  // 1) Cookie al. fc.yahoo.com 404 doner ama A1/A3 cookie'lerini set eder.
  for (const url of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
      harvestCookies(res);
      // AB cikis IP'si onay ekranina yonlendirir ve crumb akisini kirar.
      if (/guce\.yahoo|consent\.yahoo/.test(res.url)) {
        throw Object.assign(
          new Error(
            'Yahoo onay ekranina yonlendirdi (guce/consent). Bu, dagitimin AB ' +
            'bolgesinde oldugunun isaretidir — Railway servisini ABD bolgesine alin.'
          ),
          { permanent: true }
        );
      }
      if (jar.size) break;
    } catch (err) {
      if (err?.permanent) throw err;
      log.debug('cookie alinamadi', { url, err: String(err?.message ?? err) });
    }
  }
  if (jar.size === 0) throw new Error('Yahoo cookie alinamadi');

  // 2) Crumb al.
  const res = await fetchWithTimeout(`${Q1}/v1/test/getcrumb`, {
    timeoutMs: 8000,
    headers: authHeaders(),
  });
  assertOk(res, 'getcrumb');
  const crumb = (await res.text()).trim();
  if (!crumb || crumb.length > 32 || /[<>{}]/.test(crumb)) {
    throw new Error(`gecersiz crumb: ${JSON.stringify(crumb.slice(0, 40))}`);
  }

  session = { crumb, at: Date.now() };
  log.info('Yahoo crumb alindi');
  return session;
}

async function ensureSession() {
  if (session && Date.now() - session.at < CRUMB_TTL_MS) return session;
  // El sikismasi withRetry ICINDE olmali. Disarida kaldiginda 429 aninda
  // pes ediyordu (uretimde 53 ms'de) — oysa 429 tam olarak beklenip yeniden
  // denenmesi gereken hata.
  return withRetry(() => handshake(), { tries: 3, label: 'crumb' });
}

/* ------------------------------------------------------------------ */
/* v7 toplu kotasyon                                                   */
/* ------------------------------------------------------------------ */

const BATCH = 40;

/**
 * @param {string[]} symbols
 * @returns {Promise<Map<string, any>>}
 */
export async function fetchQuotes(symbols) {
  const s = await ensureSession();
  /** @type {Map<string, any>} */
  const out = new Map();

  const chunks = [];
  for (let i = 0; i < symbols.length; i += BATCH) chunks.push(symbols.slice(i, i + BATCH));

  for (const [ci, chunk] of chunks.entries()) {
    if (ci > 0) await new Promise((r) => setTimeout(r, 200));

    const url = `${Q1}/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(','))}` +
      `&crumb=${encodeURIComponent(s.crumb)}`;

    try {
      const json = await withRetry(async () => {
        const res = await fetchWithTimeout(url, {
          timeoutMs: 10_000,
          headers: authHeaders(),
        });
        // Crumb suresi dolduysa BIR KEZ yenile ve tekrar dene.
        if (res.status === 401 || res.status === 403) {
          await handshake();
          const s2 = /** @type {{crumb: string}} */ (session);
          const retryUrl = url.replace(/crumb=[^&]*/, `crumb=${encodeURIComponent(s2.crumb)}`);
          const res2 = await fetchWithTimeout(retryUrl, {
            timeoutMs: 10_000,
            headers: authHeaders(),
          });
          assertOk(res2, retryUrl);
          return res2.json();
        }
        assertOk(res, url);
        return res.json();
      }, { label: `quote[${ci}]` });

      for (const r of json?.quoteResponse?.result ?? []) {
        if (r?.symbol) out.set(r.symbol, r);
      }
    } catch (err) {
      log.warn('kotasyon grubu basarisiz', {
        grup: ci, adet: chunk.length, err: String(err?.message ?? err),
      });
    }
  }

  return out;
}

/**
 * Guncel fiyati secer — seans disi baskilar DAHIL.
 *
 * `marketState`'e gore DALLANMAZ: alan belgelenmemis degerler aliyor
 * (POSTPOST, PREPRE, CLOSED...). Bunun yerine aday ucluler kurulup en YENISI
 * seciliyor, sonra seans oncesine ait olanlar eleniyor.
 *
 * Sarkma reddi kritik: `postMarketPrice` sabah pre-market sirasinda sik sik
 * ONCEKI aksamdan kalir; elenmezse seans getirisi yanlis cikar.
 *
 * @param {any} q v7 kotasyon kaydi
 * @param {number} sessionStartUtc
 * @returns {{price: number, at: number, kind: string}|null}
 */
export function pickCurrent(q, sessionStartUtc) {
  const cands = [
    { price: q?.regularMarketPrice, t: q?.regularMarketTime, kind: 'REGULAR' },
    { price: q?.preMarketPrice, t: q?.preMarketTime, kind: 'PRE' },
    { price: q?.postMarketPrice, t: q?.postMarketTime, kind: 'POST' },
  ]
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && Number.isFinite(c.t) && c.t > 0)
    .map((c) => ({ ...c, at: c.t * 1000 }));

  if (cands.length === 0) return null;
  const best = cands.reduce((a, b) => (b.at > a.at ? b : a));
  if (best.at < sessionStartUtc) return null; // onceki gunden sarkiyor
  return { price: best.price, at: best.at, kind: best.kind };
}

/* ------------------------------------------------------------------ */
/* v8 chart — baz fiyatlar                                             */
/* ------------------------------------------------------------------ */

/**
 * Bir sembolun bazi: sessionStart'tan KESINLIKLE onceki son kapanis bari.
 *
 * Katilik onemli: 20:55Z damgali 5 dakikalik bar 21:00Z'de kapanir ve dogru
 * bazdir; 21:00Z damgali bar YENI seansin ilk baridir. Kosul `<`, `<=` degil.
 *
 * @param {string} symbol
 * @param {number} sessionStartUtc
 * @returns {Promise<{baseline: number, at: number, source: string}|null>}
 */
export async function fetchBaseline(symbol, sessionStartUtc) {
  const url = `${Q2}/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5d&interval=5m&includePrePost=true`;

  const json = await withRetry(async () => {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 12_000,
      headers: authHeaders(),
    });
    assertOk(res, url);
    return res.json();
  }, { tries: 1, label: `chart:${symbol}` });

  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const close = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close)) return null;

  const cutoffSec = Math.floor(sessionStartUtc / 1000);
  for (let k = ts.length - 1; k >= 0; k--) {
    if (ts[k] < cutoffSec && Number.isFinite(close[k]) && close[k] > 0) {
      return { baseline: close[k], at: ts[k] * 1000, source: 'chart-bar' };
    }
  }
  return null;
}

/**
 * CRUMB'SIZ TAM YOL. Tek bir chart cagrisindan hem bazi hem guncel fiyati
 * hem de acilis fiyatini cikarir.
 *
 * Bu, crumb el sikismasi 429 yedigi zamanki yedek yol. v8/chart crumb
 * gerektirmiyor, o yuzden getcrumb hiz sinirindan bagimsiz calisabiliyor.
 * Maliyeti yuksek (sembol basina bir istek) ama site karanlikta kalmiyor.
 *
 * @param {string} symbol
 * @param {number} sessionStartUtc
 * @param {number|null} regOpenUtc bugunun ana seans acilisi (bosluk ayrimi icin)
 */
export async function fetchChartSeries(symbol, sessionStartUtc, regOpenUtc = null) {
  const url = `${Q2}/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5d&interval=5m&includePrePost=true`;

  const json = await withRetry(async () => {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 12_000,
      headers: authHeaders(),
    });
    assertOk(res, url);
    return res.json();
  }, { tries: 1, label: `chart:${symbol}` });

  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const close = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close)) return null;

  const out = extractSeries(ts, close, sessionStartUtc, regOpenUtc);

  // meta.regularMarketPrice 5 dakikalik bardan daha taze olabiliyor.
  const mt = r?.meta?.regularMarketTime;
  const mp = r?.meta?.regularMarketPrice;
  if (Number.isFinite(mp) && mp > 0 && Number.isFinite(mt)) {
    const mAt = mt * 1000;
    if (mAt >= sessionStartUtc && (out.priceAt == null || mAt > out.priceAt)) {
      out.price = mp;
      out.priceAt = mAt;
    }
  }

  out.prevClose = r?.meta?.chartPreviousClose ?? r?.meta?.previousClose ?? null;
  return out;
}

/* ------------------------------------------------------------------ */
/* v8 spark — ANAHTARSIZ ve TOPLU. Birincil yol.                       */
/* ------------------------------------------------------------------ */

// 102 sembol tek URL'de ~670 karakter — parcalamaya gerek yok. Parcalamak
// istek sayisini bosuna bes katina cikariyordu.
const SPARK_URL_LIMIT = 6000;

/**
 * Spark cevabini normalize eder. Uc, zaman icinde iki farkli sekil dondurdu;
 * ikisini de destekliyoruz ve tanimadigimiz sekilde sessizce cokmuyoruz.
 * @param {any} json
 * @returns {Map<string, {ts: number[], close: number[], prevClose: number|null}>}
 */
export function normalizeSpark(json) {
  /** @type {Map<string, any>} */
  const out = new Map();
  if (!json || typeof json !== 'object') return out;

  // Sekil A: { AAPL: {symbol, timestamp, close, chartPreviousClose}, ... }
  for (const [key, v] of Object.entries(json)) {
    if (key === 'spark' || !v || typeof v !== 'object') continue;
    const ts = /** @type {any} */ (v).timestamp;
    const close = /** @type {any} */ (v).close;
    if (Array.isArray(ts) && Array.isArray(close)) {
      out.set(/** @type {any} */ (v).symbol ?? key, {
        ts, close,
        prevClose: /** @type {any} */ (v).chartPreviousClose
          ?? /** @type {any} */ (v).previousClose ?? null,
      });
    }
  }
  if (out.size) return out;

  // Sekil B: { spark: { result: [ {symbol, response:[{meta, timestamp, indicators}]} ] } }
  for (const r of json?.spark?.result ?? []) {
    const resp = r?.response?.[0];
    const ts = resp?.timestamp;
    const close = resp?.indicators?.quote?.[0]?.close;
    if (Array.isArray(ts) && Array.isArray(close)) {
      out.set(r.symbol, {
        ts, close,
        prevClose: resp?.meta?.chartPreviousClose ?? resp?.meta?.previousClose ?? null,
      });
    }
  }
  return out;
}

/**
 * BIRINCIL YOL: tek istekte onlarca sembol, crumb YOK, cerez YOK.
 *
 * Neden birincil: `v1/test/getcrumb` Yahoo'nun en agresif kisitlanan ucu.
 * Onunla baslamak IP'yi isaretletip ondan bagimsiz olmasi gereken uclari da
 * zehirliyor. Spark ise anahtarsiz ve toplu — "Yahoo'dan kolayca veri
 * cekiyorduk" denen yol tam olarak burasi.
 *
 * @param {string[]} symbols
 * @param {number} sessionStartUtc
 * @param {number|null} regOpenUtc
 */
export async function fetchSparkAll(symbols, sessionStartUtc, regOpenUtc = null) {
  const t0 = Date.now();
  /** @type {Map<string, any>} */
  const out = new Map();
  const reasons = new Map();

  if (isRateLimited()) {
    const { remainingSec } = rateLimitInfo();
    return { series: out, reasons: [`hiz siniri sogumasi: ${remainingSec} sn kaldi`] };
  }

  // Semboller tek URL'ye sigiyorsa TEK istek. Sigmazsa en az sayida parca.
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const sym of symbols) {
    if (len + sym.length + 1 > SPARK_URL_LIMIT && cur.length) {
      chunks.push(cur); cur = []; len = 0;
    }
    cur.push(sym); len += sym.length + 1;
  }
  if (cur.length) chunks.push(cur);

  for (const [ci, chunk] of chunks.entries()) {
    if (ci > 0) await new Promise((r) => setTimeout(r, 500));
    const url = `${Q1}/v8/finance/spark` +
      `?symbols=${encodeURIComponent(chunk.join(','))}` +
      `&range=2d&interval=5m&includePrePost=true`;
    try {
      // tries:1 — 429'u yeniden denemek sorunu buyutuyor.
      const json = await withRetry(async () => {
        const res = await fetchWithTimeout(url, { timeoutMs: 20_000, headers: authHeaders() });
        assertOk(res, url);
        return res.json();
      }, { tries: 1, label: `spark[${ci}]` });

      const norm = normalizeSpark(json);
      if (norm.size === 0) {
        reasons.set('spark cevabi taninmadi (sekil degismis olabilir)',
          (reasons.get('spark cevabi taninmadi (sekil degismis olabilir)') ?? 0) + 1);
        continue;
      }
      for (const [sym, v] of norm) {
        const e = extractSeries(v.ts, v.close, sessionStartUtc, regOpenUtc);
        e.prevClose = v.prevClose;
        if (e.baseline > 0 || e.price > 0) out.set(sym, e);
      }
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 90);
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
      if (is429(err)) { noteRateLimit(); break; }  // kalan parcalari deneme
    }
  }

  if (out.size) noteSuccess();

  const topReasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([why, n]) => `${n}x ${why}`);

  log.info('spark yolu tamamlandi', {
    ok: out.size, istek: chunks.length, ms: Date.now() - t0, sebepler: topReasons,
  });
  return { series: out, reasons: topReasons };
}

/**
 * Crumb'siz yol, tum semboller icin.
 * @param {string[]} symbols
 * @param {number} sessionStartUtc
 * @param {number|null} regOpenUtc
 */
export async function fetchChartAll(symbols, sessionStartUtc, regOpenUtc = null) {
  const t0 = Date.now();
  // Crumb yolu zaten hiz sinirina takildigi icin buraya gelindi — daha
  // temkinli bir havuz ve daha genis aralik kullan.
  if (isRateLimited()) {
    const { remainingSec } = rateLimitInfo();
    return { series: new Map(), failed: symbols, reasons: [`hiz siniri sogumasi: ${remainingSec} sn kaldi`] };
  }

  // Ilk 429'da TUM fan-out iptal edilir. Aksi halde 102 sembol x 3 deneme =
  // 306 istek gidiyor ve hiz sinirini derinlestiriyor.
  let aborted = false;
  const settled = await pool(
    symbols, 3,
    async (sym) => {
      if (aborted || isRateLimited()) throw new Error('hiz siniri — tur iptal edildi');
      try {
        return await fetchChartSeries(sym, sessionStartUtc, regOpenUtc);
      } catch (err) {
        if (is429(err)) { aborted = true; noteRateLimit(); }
        throw err;
      }
    },
    { spacingMs: 400 }
  );

  /** @type {Map<string, any>} */
  const out = new Map();
  const failed = [];
  /** Hata SEBEPLERI de toplaniyor — "calismadi" demek teshis icin yetersiz. */
  const reasons = new Map();
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      out.set(symbols[i], r.value);
      return;
    }
    failed.push(symbols[i]);
    const why = r.status === 'rejected'
      ? String(r.reason?.message ?? r.reason).slice(0, 90)
      : 'bos sonuc (bar yok)';
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  });

  const topReasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([why, n]) => `${n}x ${why}`);

  if (out.size) noteSuccess();
  log.info('chart-only yol tamamlandi', {
    ok: out.size, basarisiz: failed.length, ms: Date.now() - t0,
    sebepler: topReasons,
  });
  return { series: out, failed, reasons: topReasons };
}

/**
 * Tum semboller icin baz cek. Havuzlu ve araliklandirilmis.
 * @param {string[]} symbols
 * @param {number} sessionStartUtc
 */
export async function fetchBaselines(symbols, sessionStartUtc) {
  const t0 = Date.now();
  if (isRateLimited()) {
    return { baselines: new Map(), failed: symbols };
  }

  // Bu da 101'lik bir fan-out; ilk 429'da iptal edilmeli.
  let aborted = false;
  const settled = await pool(
    symbols, 4,
    async (sym) => {
      if (aborted || isRateLimited()) throw new Error('hiz siniri — tur iptal edildi');
      try {
        return await fetchBaseline(sym, sessionStartUtc);
      } catch (err) {
        if (is429(err)) { aborted = true; noteRateLimit(); }
        throw err;
      }
    },
    { spacingMs: 300 }
  );

  /** @type {Map<string, {baseline: number, at: number, source: string}>} */
  const out = new Map();
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) out.set(symbols[i], r.value);
    else failed.push(symbols[i]);
  });

  log.info('bazlar cekildi', {
    ok: out.size, basarisiz: failed.length, ms: Date.now() - t0,
    eksik: failed.slice(0, 10),
  });
  return { baselines: out, failed };
}

/** Teshis icin: el sikismasini sifirla. */
export function resetSession() {
  session = null;
  jar.clear();
}
