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
    headers: { Cookie: cookieHeader() },
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
          headers: { Cookie: cookieHeader() },
        });
        // Crumb suresi dolduysa BIR KEZ yenile ve tekrar dene.
        if (res.status === 401 || res.status === 403) {
          await handshake();
          const s2 = /** @type {{crumb: string}} */ (session);
          const retryUrl = url.replace(/crumb=[^&]*/, `crumb=${encodeURIComponent(s2.crumb)}`);
          const res2 = await fetchWithTimeout(retryUrl, {
            timeoutMs: 10_000,
            headers: { Cookie: cookieHeader() },
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
      headers: { Cookie: cookieHeader() },
    });
    assertOk(res, url);
    return res.json();
  }, { label: `chart:${symbol}` });

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
      headers: { Cookie: cookieHeader() },
    });
    assertOk(res, url);
    return res.json();
  }, { label: `chart:${symbol}` });

  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const close = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close)) return null;

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

  // meta.regularMarketPrice 5 dakikalik bardan daha taze olabiliyor.
  const mt = r?.meta?.regularMarketTime;
  const mp = r?.meta?.regularMarketPrice;
  if (Number.isFinite(mp) && mp > 0 && Number.isFinite(mt)) {
    const mAt = mt * 1000;
    if (mAt >= sessionStartUtc && (priceAt == null || mAt > priceAt)) {
      price = mp;
      priceAt = mAt;
    }
  }

  return {
    baseline, baselineAt, price, priceAt, open,
    prevClose: r?.meta?.chartPreviousClose ?? r?.meta?.previousClose ?? null,
  };
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
  const settled = await pool(
    symbols, 4,
    (sym) => fetchChartSeries(sym, sessionStartUtc, regOpenUtc),
    { spacingMs: 250 }
  );

  /** @type {Map<string, any>} */
  const out = new Map();
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) out.set(symbols[i], r.value);
    else failed.push(symbols[i]);
  });

  log.info('chart-only yol tamamlandi', {
    ok: out.size, basarisiz: failed.length, ms: Date.now() - t0,
    eksik: failed.slice(0, 10),
  });
  return { series: out, failed };
}

/**
 * Tum semboller icin baz cek. Havuzlu ve araliklandirilmis.
 * @param {string[]} symbols
 * @param {number} sessionStartUtc
 */
export async function fetchBaselines(symbols, sessionStartUtc) {
  const t0 = Date.now();
  const settled = await pool(
    symbols, 6,
    (sym) => fetchBaseline(sym, sessionStartUtc),
    { spacingMs: 120 }
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
