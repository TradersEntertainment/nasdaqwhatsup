/**
 * api.nasdaq.com — ANAHTARSIZ, TEK ISTEKTE tum NASDAQ-100.
 *
 * Neden en iyi anahtarsiz secenek: liste ucu 100 hissenin GUNCEL FIYATINI ve
 * NET DEGISIMINI tek cagrida veriyor. Net degisimden baz turetiliyor:
 *   baz = fiyat − netDegisim   (yani onceki kapanis)
 * Boylece tek istekle tam anlik goruntu: kotasyon + baz, sifir ek istek,
 * sifir anahtar.
 *
 * Yahoo/Stooq'un aksine bu bir SCRAPING ucu degil, nasdaq.com'un kendi
 * genel API'si — Invesco holdings gibi, tarayici basliklariyla erisiliyor.
 * Datamerkezi IP'lerine Yahoo kadar sert davranmiyor (ayni sirket-sitesi
 * deseni Invesco'da calisti).
 *
 * Sinir: fiyat "en son satis" — seans disi baskilari icermeyebilir (ana
 * seans odakli). Yani "seans disi dahil" ozelligi bu kaynakta yaklasik.
 * Kapsamin tamligi (genislik istatistigi) bundan cok daha onemli.
 *
 * ⚠ Bu container'dan test edilemez (403). Ayristirici test/nasdaq.test.js.
 */

import { fetchWithTimeout, withRetry, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';

const LIST_URL = 'https://api.nasdaq.com/api/quote/list-type/nasdaq100';

const BROWSER_HEADERS = {
  // User-Agent SART: bu uc, UA'siz istekleri (Node'un varsayilani gibi)
  // dogrudan 403'e dusuruyor. Kullanicinin uretimde calisan projesi ayni
  // basligi kullaniyor — orada yillardir sorunsuz.
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

/**
 * "$1,234.56" → 1234.56 ; "N/A"/"" → null. Isaret ve virguller temizlenir.
 * @param {unknown} v
 * @returns {number|null}
 */
export function parseMoney(v) {
  if (v == null) return null;
  const cleaned = String(v).replace(/[$,%\s]/g, '').replace(/[()]/g, '');
  // Number('') === 0 — bos string 0'a dusmesin; en az bir rakam sart.
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Liste cevabini normalize eder. nasdaq.com iç içe zarf kullaniyor
 * (data.data.rows) ve alan adlari zamanla degisebiliyor; tolere edilir.
 *
 * @param {any} json
 * @returns {{symbol: string, name: string, price: number, prevClose: number, pct: number|null}[]}
 */
export function parseNasdaqList(json) {
  const rows = json?.data?.data?.rows ?? json?.data?.rows ?? json?.rows;
  if (!Array.isArray(rows)) return [];

  const out = [];
  for (const r of rows) {
    const symbol = String(r?.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,5}$/.test(symbol)) continue;

    const price = parseMoney(r?.lastSalePrice ?? r?.lastsale ?? r?.lastSale);
    if (!(price > 0)) continue;

    // Net degisim → onceki kapanis. Alan adi surumler arasi degisebiliyor.
    const net = parseMoney(r?.netChange ?? r?.netchange ?? r?.change);
    let prevClose = Number.isFinite(net) ? price - net : null;

    // netChange yoksa yuzdeden turet: prev = price / (1 + pct/100)
    const pct = parseMoney(r?.percentageChange ?? r?.pctchange ?? r?.percentchange);
    if (!(prevClose > 0) && Number.isFinite(pct)) {
      prevClose = pct === -100 ? null : price / (1 + pct / 100);
    }
    if (!(prevClose > 0)) prevClose = price; // son care: degismemis say

    out.push({
      symbol,
      name: String(r?.companyName ?? r?.name ?? symbol).replace(/ Common Stock.*$/i, '').trim(),
      price,
      prevClose,
      pct: Number.isFinite(pct) ? pct : null,
    });
  }
  return out;
}

/**
 * Tek istekte tum NASDAQ-100.
 * @returns {Promise<{rows: ReturnType<typeof parseNasdaqList>, fetchedAt: number}>}
 */
export async function fetchNasdaq100() {
  const json = await withRetry(async () => {
    const res = await fetchWithTimeout(`${LIST_URL}?limit=110`, {
      timeoutMs: 15_000,
      headers: BROWSER_HEADERS,
    });
    assertOk(res, LIST_URL);
    return res.json();
  }, { tries: 2, label: 'nasdaq-list' });

  const rows = parseNasdaqList(json);
  if (rows.length < 85) {
    // Sekil degismis olabilir — ham anahtarlari logla (probe ucu detay verir).
    throw new Error(
      `nasdaq listesi ${rows.length} satir (<85). Ust anahtarlar: ` +
      Object.keys(json ?? {}).join(',') + ' / data: ' +
      Object.keys(json?.data ?? {}).join(',')
    );
  }
  log.info('nasdaq.com listesi', { adet: rows.length });
  return { rows, fetchedAt: Date.now() };
}
