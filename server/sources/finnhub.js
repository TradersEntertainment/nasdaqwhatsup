/**
 * Finnhub — ANAHTARLI ve GUVENILIR yol.
 *
 * Anahtarsiz kaynaklarin hepsi (Yahoo, Stooq) veri merkezi IP'lerine karsi
 * savunma yapiyor; Railway'de ucu ucuna calisiyorlar ya da hic calismiyorlar.
 * Finnhub bunun tam tersi: resmi, belgeli, ucretsiz katmani bu is icin
 * fazlasiyla yeterli bir API.
 *
 * Ucretsiz anahtar: https://finnhub.io → Register → API key.
 * Railway'de FINNHUB_KEY ortam degiskeni olarak eklenir; kod varligini
 * gorunce bu yolu BIRINCIL yapar.
 *
 * Hiz siniri (ucretsiz): 60 istek/dk. 102 sembollu tam tarama, tekli
 * eszamanlilik + ~1,05 sn aralikla ~2 dakika surer — 5 dakikalik poll
 * kadansina rahat sigar (inFlight kilidi ust uste binmeyi zaten engelliyor).
 *
 * /quote cevabi: { c: guncel, pc: onceki kapanis, o: acilis, t: son islem
 * (saniye), dp: gunluk % }. Baz = pc — kisin TSI taniminda birebir dogru,
 * yazin ~1 saatlik after-hours farki tasir (prev-close sinifi).
 */

import { fetchWithTimeout, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';

const BASE = 'https://finnhub.io/api/v1';

/** Ucretsiz katman 60 istek/dk. Guvenli taban: istekler arasi >=1,1 sn. */
const MIN_GAP_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {any} json
 * @returns {{price: number, prevClose: number, open: number|null, at: number|null, dp: number|null}|null}
 */
export function parseFinnhubQuote(json) {
  const c = Number(json?.c);
  const pc = Number(json?.pc);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(pc) || pc <= 0) return null;
  const o = Number(json?.o);
  const t = Number(json?.t);
  const dp = Number(json?.dp);
  return {
    price: c,
    prevClose: pc,
    open: Number.isFinite(o) && o > 0 ? o : null,
    at: Number.isFinite(t) && t > 0 ? t * 1000 : null,
    dp: Number.isFinite(dp) ? dp : null,
  };
}

/**
 * Tam tarama. KESIN sirali: her istegin BASLANGICI bir oncekinden >=1,1 sn
 * sonra. Havuz-jitter'i erken isteklerde 525 ms'ye kadar inip 60/dk'yi anlik
 * asabiliyordu — bu dogrudan 429 riski. Burada gap sabit ve garanti.
 *
 * 401/403 (gecersiz/eksik anahtar) hemen durdurur: 102 istegi bosuna atma,
 * net tek bir sebep dondur. 429 gorunurse 15 sn bekleyip o sembolu bir kez
 * daha dener (rolling pencere gecsin).
 *
 * @param {string[]} symbols
 * @param {string} key
 * @returns {Promise<{map: Map<string, any>, reasons: string[]}>}
 */
export async function fetchFinnhubQuotes(symbols, key) {
  const t0 = Date.now();
  /** @type {Map<string, any>} */
  const out = new Map();
  /** @type {Map<string, number>} */
  const errs = new Map();
  const note = (w) => errs.set(w, (errs.get(w) ?? 0) + 1);

  let nextAllowedAt = 0;

  for (const sym of symbols) {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAllowedAt = Date.now() + MIN_GAP_MS;

    const url = `${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${key}`;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const res = await fetchWithTimeout(url, { timeoutMs: 10_000 });
        if (res.status === 401 || res.status === 403) {
          // Anahtar gecersiz/eksik — 102 istegi bosa atma.
          const err = new Error(`gecersiz anahtar (HTTP ${res.status})`);
          log.warn('finnhub anahtari reddedildi', { status: res.status });
          return { map: out, reasons: [`finnhub: ${err.message}`] };
        }
        if (res.status === 429) {
          note('429 hiz siniri');
          await sleep(15_000);          // rolling pencere gecsin, bir kez daha
          nextAllowedAt = Date.now() + MIN_GAP_MS;
          continue;
        }
        assertOk(res, `finnhub:${sym}`);
        const q = parseFinnhubQuote(await res.json());
        if (q) { out.set(sym, q); ok = true; }
        else note('bos kotasyon (bilinmeyen sembol?)');
      } catch (err) {
        note(String(err?.message ?? err).slice(0, 50));
      }
    }
  }

  const reasons = [...errs].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([w, n]) => `${n}x ${w}`);
  log.info('finnhub taramasi', {
    ok: out.size, toplam: symbols.length,
    sn: Math.round((Date.now() - t0) / 1000), sebepler: reasons,
  });
  return { map: out, reasons };
}
