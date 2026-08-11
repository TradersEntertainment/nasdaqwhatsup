/**
 * Endeks UYE LISTELERI.
 *
 * ── Neden ayri bir dosya ──
 * api.nasdaq.com'un `list-type` ucu OLCULDU: yalnizca `nasdaq100` calisiyor
 * (102 uye, piyasa degeri dahil). `sp500`, `spx`, `dowjones`, `dow-jones`,
 * `djia` sluglarinin hepsi 0 satir donuyor. Dolayisiyla S&P 500 ve Dow 30
 * uyeligi baska bir kaynaktan gelmek zorunda.
 *
 * ── Degismez kural ──
 * Uye listeleri MODEL BILGISINDEN YAZILMAZ. 503 sembollük bir listeyi
 * ezberden dokmek dogrulanamaz bir hata kaynagidir — endeks agirliklarini
 * uydurmakla ayni sinif hata. Liste gercek bir kaynaktan gelmezse o endeks
 * ACILMAZ; eksik/yanlis bir endeks gostermektense hic gostermemek dogru.
 *
 * ── Kaynak merdiveni ──
 *  1) iShares IVV holdings CSV — S&P 500 icin EN IYI kaynak: uye listesi VE
 *     GERCEK PAY ADETLERI birlikte geliyor. Pay adedi elde olunca agirlik
 *     piyasa degerinden turetilmek zorunda kalmiyor (serbest dolasim hatasi
 *     ortadan kalkar).
 *  2) Wikipedia "constituents" tablosu — hem S&P hem Dow icin; yalnizca
 *     semboller. Dow icin bu YETER, cunku Dow fiyat agirlikli (pay adedi = 1).
 *
 * ⚠ Bu dosya bu container'dan test edilemez (cikis politikasi 403 veriyor).
 * Saf ayristiricilar test/members.test.js ile kapsanir; ag tarafi Railway'de
 * /api/members-probe ile dogrulanir.
 */

import { fetchWithTimeout, withRetry, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const WIKI_PAGES = {
  spx: 'List_of_S%26P_500_companies',
  dji: 'Dow_Jones_Industrial_Average',
};

const IVV_CSV =
  'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/' +
  '1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund';

/** Kabul edilebilir sembol bicimi (BRK.B, BF.B gibi noktalilar dahil). */
const TICKER = /^[A-Z][A-Z.\-]{0,5}$/;

const stripTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Makul uye sayisi araliklari — kaba bir kaynak bozulmasi bunlara takilir. */
export const EXPECTED = {
  spx: [400, 520],
  dji: [25, 35],
  ndx: [85, 110],
};

/* ------------------------------------------------------------------ */
/* Wikipedia                                                           */
/* ------------------------------------------------------------------ */

/**
 * Borsa adlari sembol bicimine uyuyor ("NYSE", "NASDAQ"). Dow sayfasinda bunlar
 * ayri bir sutunda ve basliksiz ayristirmada sembol sanilabiliyorlardi.
 */
const NOT_TICKER = new Set([
  // Borsa adlari
  'NYSE', 'NASDAQ', 'AMEX', 'CBOE', 'BATS', 'ARCA', 'OTC', 'N/A',
  // Tablo BASLIKLARI: "SYMBOL" alti harf ve sembol bicimine uyuyor. Hucre
  // toplamaya <th>'ler dahil edilince baslik satiri kendini uye sanmisti.
  'SYMBOL', 'TICKER', 'COMPANY', 'SECTOR', 'NOTES', 'DATE', 'ADDED', 'NAME',
  'INDEX', 'WEIGHT', 'PRICE', 'SHARES', 'CUSIP', 'ISIN', 'GICS', 'GICSSUB',
]);

/**
 * TEK bir HTML tablosundan sembol sutununu cikarir.
 *
 * Sutun SIRASI sayfadan sayfaya degisiyor: S&P sayfasinda Symbol ILK sutun,
 * Dow sayfasinda UCUNCU. Bu yuzden sabit indeks kullanilmaz — baslik satirinda
 * "Symbol"/"Ticker" yazan sutunun indeksi bulunur.
 *
 * @param {string} table tek bir <table> govdesi
 * @returns {string[]}
 */
function tableCandidates(table) {
  const rows = table.split(/<tr[^>]*>/i).slice(1);
  if (rows.length === 0) return [];

  // Hucreler TH VE TD birlikte, BELGE SIRASINDA toplanir.
  //
  // Kritik: Wikipedia satir basligi sutunlarini <th scope="row"> yapiyor.
  // Yalnizca <td> toplayip basligi tum sutunlar uzerinden saymak, boyle bir
  // tabloda indeksi bir kaydirir — Dow sayfasinda "Symbol" yerine "Industry"
  // okunuyordu ve uretimde Dow tam bu yuzden hic acilmadi.
  const cellsOf = (row, both) => [
    ...row.matchAll(both ? /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi : /<td[^>]*>([\s\S]*?)<\/td>/gi),
  ].map((m) => stripTags(m[1]));

  const clean = (c) => String(c).toUpperCase().replace(/\s+/g, '');
  const usable = (u) => TICKER.test(u) && !NOT_TICKER.has(u);

  /**
   * @param {(row: string) => string} pick
   *
   * Yalnizca VERI satirlari gezilir: icinde hic <td> olmayan satir baslik
   * satiridir ve degeri hucre olarak okunmamalidir.
   */
  const collect = (pick) => {
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      if (!/<td[\s>]/i.test(row)) continue;
      const sym = clean(pick(row));
      if (!usable(sym) || seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
    }
    return out;
  };

  // Baslik satirinda "Symbol"/"Ticker" hangi sirada?
  let symCol = -1;
  for (const row of rows) {
    const heads = [...row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1]));
    if (heads.length < 2) continue;
    const i = heads.findIndex((h) => /^(symbol|ticker)\b/i.test(h));
    if (i >= 0) { symCol = i; break; }
  }

  const adaylar = [];
  if (symCol >= 0) {
    // a) th+td birlikte sayilarak (satir basligi <th> olan tablolar)
    adaylar.push(collect((row) => cellsOf(row, true)[symCol] ?? ''));
    // b) yalnizca td sayilarak (tum hucreleri td olan tablolar)
    adaylar.push(collect((row) => cellsOf(row, false)[symCol] ?? ''));
  }
  // c) baslik yoksa/tutmazsa: satirdaki ilk sembol-bicimli VERI hucresi.
  //    Satir basligi <th> sirket adi tasir, sembol degil — o yuzden td-only.
  adaylar.push(collect((row) => cellsOf(row, false).find((c) => usable(clean(c))) ?? ''));

  return adaylar.filter((x) => x.length > 0);
}

/**
 * Sayfadaki uye tablosunu BULUR.
 *
 * Onceki surum `id="constituents"`e guveniyor, bulamazsa SAYFADAKI ILK
 * wikitable'a dusuyordu. Dow sayfasinda o tablo bileşen tablosu degil — ve
 * uretimde tam olarak bu oldu: liste sacmaladi, aralik kontrolune takildi,
 * Dow hic acilmadi.
 *
 * Artik tahmin yok: TUM tablolar x TUM okuma stratejileri denenir ve beklenen
 * uye araligina OTURAN ilk sonuc kabul edilir. Dogru tabloyu ve dogru sutunu
 * VERI secer — isimlendirme ya da varsayim degil.
 *
 * @param {string} html
 * @param {[number, number]} [range] beklenen [en az, en cok] uye
 * @returns {string[]}
 */
export function parseWikiConstituents(html, range) {
  if (typeof html !== 'string') return [];

  const tables = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  for (const m of html.matchAll(re)) tables.push(m[0]);
  if (tables.length === 0) return [];

  // Once id="constituents" varsa o one alinir — dogruysa aralik testini
  // zaten gecer, degilse digerleri denenmeye devam eder.
  tables.sort((a, b) => Number(/id\s*=\s*["']constituents["']/i.test(b)) -
                        Number(/id\s*=\s*["']constituents["']/i.test(a)));

  const adaylar = tables.flatMap(tableCandidates);
  if (adaylar.length === 0) return [];

  if (range) {
    const [lo, hi] = range;
    const uygun = adaylar.find((x) => x.length >= lo && x.length <= hi);
    if (uygun) return uygun;
    return [];
  }
  // Aralik verilmediyse en uzun aday (bileşen tablosu genelde en buyuk olan).
  return adaylar.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * @param {'spx'|'dji'} key
 * @returns {Promise<string[]>}
 */
export async function fetchWikiMembers(key) {
  const page = WIKI_PAGES[key];
  if (!page) return [];
  const range = EXPECTED[key];
  // `action=render` yalnizca govdeyi dondurur — tam sayfa HTML'inden cok
  // daha kucuk ve ayristirmasi daha kararli.
  const url = `https://en.wikipedia.org/w/index.php?title=${page}&action=render`;
  const html = await withRetry(async () => {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 20_000,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    assertOk(res, url);
    return res.text();
  }, { tries: 2, label: `wiki:${key}` });
  return parseWikiConstituents(html, range);
}

/* ------------------------------------------------------------------ */
/* iShares IVV (S&P 500) — uye + GERCEK pay adedi                      */
/* ------------------------------------------------------------------ */

/**
 * Basit CSV satir ayirici: tirnak icindeki virguller korunur.
 * @param {string} line
 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // "" kacisi
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * iShares holdings CSV → {sembol, pay adedi}.
 *
 * Dosyanin basinda ~9 satirlik fon ustbilgisi var; gercek baslik satiri
 * "Ticker" ve "Shares" iceren ilk satirdir. Sabit satir numarasi kullanmak
 * sponsor bicimi degistirdiginde sessizce bos liste uretirdi.
 *
 * @param {string} csv
 * @returns {{symbol: string, shares: number}[]}
 */
export function parseIsharesHoldings(csv) {
  if (typeof csv !== 'string') return [];
  const lines = csv.split(/\r?\n/);

  let head = -1;
  let cols = [];
  for (let i = 0; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]).map((x) => x.toLowerCase());
    if (c.includes('ticker') && c.some((x) => x === 'shares' || x.startsWith('shares'))) {
      head = i; cols = c; break;
    }
  }
  if (head < 0) return [];

  const iSym = cols.indexOf('ticker');
  const iSh = cols.findIndex((x) => x === 'shares' || x.startsWith('shares'));
  const iClass = cols.findIndex((x) => x.includes('asset class'));

  const out = [];
  const seen = new Set();
  for (let i = head + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = splitCsvLine(lines[i]);
    const sym = String(c[iSym] ?? '').toUpperCase().replace(/\s+/g, '');
    if (!TICKER.test(sym) || seen.has(sym)) continue;
    // Nakit / vadeli / FX satirlarini ele — bunlar endeks uyesi degil.
    if (iClass >= 0 && c[iClass] && !/equity/i.test(c[iClass])) continue;
    const shares = Number(String(c[iSh] ?? '').replace(/[",]/g, ''));
    if (!Number.isFinite(shares) || shares <= 0) continue;
    seen.add(sym);
    out.push({ symbol: sym, shares });
  }
  return out;
}

/** @returns {Promise<{symbol: string, shares: number}[]>} */
export async function fetchIsharesSpx() {
  const csv = await withRetry(async () => {
    const res = await fetchWithTimeout(IVV_CSV, {
      timeoutMs: 25_000,
      headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
    });
    assertOk(res, 'ishares IVV');
    return res.text();
  }, { tries: 2, label: 'ishares:ivv' });
  return parseIsharesHoldings(csv);
}

/* ------------------------------------------------------------------ */
/* Merdiven                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bir endeksin uyelerini getirir. Her kaynak denenir, ILK GECERLI sonuc
 * kullanilir; hicbiri gecerli degilse `null` doner (endeks acilmaz).
 *
 * @param {'spx'|'dji'} key
 * @returns {Promise<{members: {symbol: string, shares: number|null}[], source: string}|null>}
 */
export async function fetchMembers(key) {
  const [lo, hi] = EXPECTED[key] ?? [1, 10000];
  const denemeler = [];

  // 1) iShares — yalnizca S&P; pay adetleriyle birlikte gelir.
  if (key === 'spx') {
    denemeler.push(['ishares-ivv', async () => {
      const rows = await fetchIsharesSpx();
      return rows.map((r) => ({ symbol: r.symbol, shares: r.shares }));
    }]);
  }
  // 2) Wikipedia — yalnizca semboller. Dow icin bu yeterli (fiyat agirlikli).
  denemeler.push(['wikipedia', async () => {
    const syms = await fetchWikiMembers(key);
    return syms.map((s) => ({ symbol: s, shares: null }));
  }]);

  for (const [name, fn] of denemeler) {
    try {
      const members = await fn();
      if (members.length < lo || members.length > hi) {
        log.warn('uye listesi makul aralikta degil — atlaniyor', {
          endeks: key, kaynak: name, adet: members.length, beklenen: `${lo}-${hi}`,
        });
        continue;
      }
      log.info('uye listesi', { endeks: key, kaynak: name, adet: members.length });
      return { members, source: name };
    } catch (err) {
      log.warn('uye listesi alinamadi', {
        endeks: key, kaynak: name, err: String(err?.message ?? err).slice(0, 90),
      });
    }
  }
  return null;
}
