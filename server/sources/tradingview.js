/**
 * TradingView screener (scanner.tradingview.com) — ANAHTARSIZ, TEK ISTEKTE
 * 100 hisse, UZATILMIS SEANS DAHIL.
 *
 * Neden bu kaynak: kullanicinin kendi calisan projesi (hlearninginsiders)
 * bilanco takvimini yillardir bu uctan cekiyor ve Railway'den sorunsuz
 * calisiyor. Yani bu uc, Yahoo/Stooq'un aksine veri merkezi IP'lerini
 * cezalandirmiyor. Ayni tarayici basliklari burada da kullaniliyor.
 *
 * ⇒ Tek POST ile:  fiyat + net degisim + PRE-MARKET + AFTER-HOURS + hacim.
 * Yahoo'nun crumb/spark/chart ucgeninin tamamini tek istek kapsiyor.
 *
 * ── TSI bazinin faza gore turetilmesi (bu dosyanin tek kritik fikri) ──
 * TradingView'in `close` alani DAIMA "en son TAMAMLANMIS ya da SUREN ana
 * seansin kapanisi"dir. Bu yuzden TSI bazi faza gore iki farkli yerden gelir:
 *
 *   REGULAR / AFTER_HOURS   → `close` BUGUNUN seansi ⇒ baz = close − change_abs
 *   CARRY / OVERNIGHT / PRE → `close` ONCEKI seansin kapanisi ⇒ baz = close
 *
 * Ikisini karistirmak bir gunluk kaymaya yol acar (pre-market'te "bugun"
 * yerine dunku hareketi gostermek gibi) — sessiz ve zehirli bir hata.
 *
 * ⚠ Bu dosya bu container'dan test edilemez (cikis politikasi 403 veriyor).
 * Saf ayristirma + faz mantigi test/tradingview.test.js ile kapsanir; ag
 * tarafi Railway'de /api/tv-probe ile dogrulanir.
 */

import { fetchWithTimeout, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';

const SCAN_URLS = [
  'https://scanner.tradingview.com/america/scan',
  'https://scanner.tradingview.com/america/scan?label-product=screener-stock',
];

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
};

/**
 * Tam kolon seti — uzatilmis seans dahil. Gecersiz TEK bir kolon adi tum
 * istegi 400'e dusurdugu icin ikinci (asgari) set yedek olarak duruyor:
 * uzatilmis seans bir BONUS, tek basarisizlik noktasi degil.
 */
export const COLUMNS_FULL = [
  'name', 'close', 'change', 'change_abs', 'open', 'volume',
  'premarket_close', 'premarket_change', 'premarket_volume',
  'postmarket_close', 'postmarket_change', 'postmarket_volume',
];
export const COLUMNS_MIN = ['name', 'close', 'change', 'change_abs', 'open', 'volume'];

/** Hangi borsalar kabul edilir — ayni kisaltmanin OTC kopyasi elenir. */
const GOOD_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'BATS']);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Scanner cevabini {sembol -> alanlar} haritasina cevirir.
 *
 * Cevap sekli: { totalCount, data: [ { s: "NASDAQ:AAPL", d: [...] } ] }
 * `d` dizisi istenen `columns` sirasiyla birebir hizalidir.
 *
 * @param {any} json
 * @param {string[]} columns istekte gonderilen kolon sirasi
 * @returns {Map<string, Record<string, number|null>>}
 */
export function parseScan(json, columns) {
  /** @type {Map<string, any>} */
  const out = new Map();
  const rows = json?.data;
  if (!Array.isArray(rows)) return out;

  const idx = new Map(columns.map((c, i) => [c, i]));
  const at = (d, c) => (idx.has(c) ? num(d[idx.get(c)]) : null);

  for (const r of rows) {
    const d = r?.d;
    if (!Array.isArray(d)) continue;

    const ticker = String(r?.s ?? '');
    const [exch, tail] = ticker.includes(':') ? ticker.split(':') : ['', ticker];
    if (exch && !GOOD_EXCHANGES.has(exch)) continue;

    const nameIdx = idx.get('name');
    const symbol = String(
      (nameIdx != null ? d[nameIdx] : null) ?? tail ?? ''
    ).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,5}$/.test(symbol)) continue;

    const close = at(d, 'close');
    if (!(close > 0)) continue;

    const rec = {
      close,
      change: at(d, 'change'),
      changeAbs: at(d, 'change_abs'),
      open: at(d, 'open'),
      volume: at(d, 'volume'),
      preClose: at(d, 'premarket_close'),
      preChange: at(d, 'premarket_change'),
      preVolume: at(d, 'premarket_volume'),
      postClose: at(d, 'postmarket_close'),
      postChange: at(d, 'postmarket_change'),
      postVolume: at(d, 'postmarket_volume'),
      marketCap: at(d, 'market_cap_basic'),
    };

    // Ayni kisaltma birden fazla borsada donerse en hacimlisi kazanir.
    const cur = out.get(symbol);
    if (!cur || (rec.volume ?? 0) > (cur.volume ?? 0)) out.set(symbol, rec);
  }
  return out;
}

/**
 * Bir TradingView kaydini TSI seans modeline oturtur.
 *
 * @param {Record<string, number|null>} r parseScan kaydi
 * @param {import('../../shared/session.js').SessionPhase} phase
 * @param {boolean} tsiDayHasTrading TSI gununde hic islem penceresi var mi
 * @returns {{price: number, baseline: number, open: number|null, traded: boolean}|null}
 */
export function toSessionRow(r, phase, tsiDayHasTrading = true) {
  const close = r?.close;
  if (!(close > 0)) return null;

  // 1) Baz. `close`'un HANGI seansa ait oldugu faza baglidir.
  const closeIsToday = phase === 'REGULAR' || phase === 'AFTER_HOURS';
  let baseline;
  if (closeIsToday) {
    if (Number.isFinite(r.changeAbs)) baseline = close - r.changeAbs;
    else if (Number.isFinite(r.change) && r.change !== -100) baseline = close / (1 + r.change / 100);
    else baseline = close;                 // degisim bilgisi yok: duz say
  } else {
    baseline = close;                      // onceki kapanis = TSI bazi
  }
  if (!(baseline > 0)) return null;

  // 2) Fiyat + "bugun islem gordu mu". Uzatilmis seans hacmi, seyrek baskilari
  //    dogru sekilde "islemYok" kovasindan ayirir — fiyatin baza esit olmasi
  //    tek basina yeterli bir sinyal degil.
  let price = close;
  let traded;
  switch (phase) {
    case 'REGULAR':
      traded = true;                       // ana seansta duz kapanis da islemdir
      break;
    case 'PRE':
      if (r.preClose > 0) price = r.preClose;
      traded = Number.isFinite(r.preVolume) ? r.preVolume > 0 : price !== baseline;
      break;
    case 'AFTER_HOURS':
    case 'CARRY_AFTER_HOURS':
    case 'OVERNIGHT':
      if (r.postClose > 0) price = r.postClose;
      traded = phase === 'AFTER_HOURS'
        ? true                             // ana seans bu TSI gunu icinde bitti
        : (Number.isFinite(r.postVolume) ? r.postVolume > 0 : price !== baseline);
      break;
    default:                               // WEEKEND | HOLIDAY
      // Cuma'nin after-hours'i Cumartesi TSI gunune tasiyor: o gun icin donmus
      // post-market fiyati DOGRU sonuctur. Pazar gibi hic islem penceresi
      // olmayan gunlerde ise fiyat baza esitlenir — dunku hareketi bugunmus
      // gibi gostermek yalan olur.
      if (tsiDayHasTrading && r.postClose > 0) { price = r.postClose; traded = price !== baseline; }
      else { price = baseline; traded = false; }
  }

  if (!(price > 0)) price = baseline;
  return { price, baseline, open: r.open > 0 ? r.open : null, traded };
}

/**
 * Tek POST — tum semboller. Once tam kolon seti, 400 alirsa asgari set.
 *
 * @param {string[]} symbols
 * @returns {Promise<{map: Map<string, any>, columns: string[], extended: boolean, url: string}>}
 */
export async function fetchTradingView(symbols) {
  const errs = [];
  for (const columns of [COLUMNS_FULL, COLUMNS_MIN]) {
    for (const url of SCAN_URLS) {
      try {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          timeoutMs: 20_000,
          headers: HEADERS,
          body: JSON.stringify({
            filter: [{ left: 'name', operation: 'in_range', right: symbols.slice(0, 500) }],
            options: { lang: 'en' },
            markets: ['america'],
            symbols: { query: { types: [] }, tickers: [] },
            columns,
            sort: { sortBy: 'name', sortOrder: 'asc' },
            range: [0, 600],
          }),
        });
        assertOk(res, `tradingview ${columns.length} kolon`);
        const map = parseScan(await res.json(), columns);
        if (map.size === 0) throw new Error('cevap ayristirildi ama 0 satir');
        log.info('tradingview taramasi', {
          adet: map.size, istenen: symbols.length, uzatilmis: columns === COLUMNS_FULL,
        });
        return { map, columns, extended: columns === COLUMNS_FULL, url };
      } catch (err) {
        errs.push(`${columns.length}k/${url.includes('?') ? 'label' : 'duz'}: ${String(err?.message ?? err).slice(0, 70)}`);
      }
    }
  }
  throw new Error(`tradingview: ${errs.join(' | ')}`);
}

/* ------------------------------------------------------------------ */
/* Piyasa degerleri — kap-agirlikli endeksler icin                     */
/* ------------------------------------------------------------------ */

/**
 * S&P 500 gibi kap-agirlikli bir endekste GERCEK pay adedi elde yoksa
 * agirlik piyasa degerinden turetilir: payAdedi = piyasaDegeri / fiyat.
 *
 * Neden AYRI ve YAVAS bir istek: piyasa degeri gun icinde fiyatla birlikte
 * oynar ama AGIRLIK icin onemli olan pay adedi — o yalnizca yeniden
 * dengelemede degisir. 12 saatte bir yeter. Ayrica `market_cap_basic`
 * kolonunun reddedilmesi ihtimaline karsi fiyat istegiyle AYNI cagriya
 * konmuyor: gecersiz tek bir kolon adi tum fiyat yolunu 400'e dusururdu.
 *
 * ⚠ Sinir: bu deger genelde TOPLAM piyasa degeri, serbest dolasim
 * duzeltmeli degil. S&P resmi agirliklari serbest dolasima gore hesaplaniyor,
 * bu yuzden dusuk halka aciklik oranli sirketlerde sapma olur. Arayuz bunu
 * soyler; trackingErrorPp de sapmayi olcer.
 *
 * @param {string[]} symbols
 * @returns {Promise<Map<string, number>>} sembol -> piyasa degeri
 */
export async function fetchMarketCaps(symbols) {
  const columns = ['name', 'market_cap_basic', 'close'];
  const errs = [];
  for (const url of SCAN_URLS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        timeoutMs: 25_000,
        headers: HEADERS,
        body: JSON.stringify({
          filter: [{ left: 'name', operation: 'in_range', right: symbols.slice(0, 600) }],
          options: { lang: 'en' },
          markets: ['america'],
          symbols: { query: { types: [] }, tickers: [] },
          columns,
          range: [0, 700],
        }),
      });
      assertOk(res, 'tradingview market cap');
      const map = parseScan(await res.json(), columns);
      /** @type {Map<string, number>} */
      const out = new Map();
      for (const [sym, rec] of map) {
        // parseScan bilinmeyen kolonlari null birakir; burada ham degere
        // erisim icin `close` uzerinden dogrulama yapiliyor.
        const mc = rec.marketCap ?? null;
        if (mc > 0) out.set(sym, mc);
      }
      if (out.size === 0) throw new Error('piyasa degeri kolonu bos dondu');
      log.info('tradingview piyasa degerleri', { adet: out.size, istenen: symbols.length });
      return out;
    } catch (err) {
      errs.push(String(err?.message ?? err).slice(0, 70));
    }
  }
  throw new Error(`tradingview piyasa degeri: ${errs.join(' | ')}`);
}
