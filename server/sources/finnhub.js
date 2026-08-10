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

import { fetchWithTimeout, withRetry, assertOk, pool } from '../lib/retry.js';
import { log } from '../lib/log.js';

const BASE = 'https://finnhub.io/api/v1';

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
 * Tam tarama. 60/dk sinirina saygi: eszamanlilik 1, ~1,05 sn aralik.
 * @param {string[]} symbols
 * @param {string} key
 * @returns {Promise<{map: Map<string, any>, reasons: string[]}>}
 */
export async function fetchFinnhubQuotes(symbols, key) {
  const t0 = Date.now();
  /** @type {Map<string, any>} */
  const out = new Map();
  const errs = new Map();

  const settled = await pool(symbols, 1, async (sym) => {
    const url = `${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${key}`;
    const json = await withRetry(async () => {
      const res = await fetchWithTimeout(url, { timeoutMs: 10_000 });
      assertOk(res, `finnhub:${sym}`);
      return res.json();
    }, { tries: 2, label: `fh:${sym}` });
    const q = parseFinnhubQuote(json);
    if (!q) throw new Error('bos kotasyon');
    return q;
  }, { spacingMs: 1050 });

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out.set(symbols[i], r.value);
    else {
      const w = String(r.reason?.message ?? r.reason).slice(0, 60);
      errs.set(w, (errs.get(w) ?? 0) + 1);
    }
  });

  const reasons = [...errs].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([w, n]) => `${n}x ${w}`);
  log.info('finnhub taramasi', {
    ok: out.size, toplam: symbols.length,
    sn: Math.round((Date.now() - t0) / 1000), sebepler: reasons,
  });
  return { map: out, reasons };
}
