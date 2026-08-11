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

/* ------------------------------------------------------------------ */
/* Wikipedia                                                           */
/* ------------------------------------------------------------------ */

/**
 * "constituents" tablosundan sembol sutununu cikarir.
 *
 * Sutun SIRASI sayfadan sayfaya degisiyor: S&P sayfasinda Symbol ILK sutun,
 * Dow sayfasinda UCUNCU. Bu yuzden sabit indeks kullanilmaz — baslik satirinda
 * "Symbol"/"Ticker" yazan sutunun indeksi bulunur.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function parseWikiConstituents(html) {
  if (typeof html !== 'string') return [];

  // id="constituents" tasiyan tabloyu bul; yoksa ilk wikitable'a dus.
  let start = html.search(/<table[^>]*id\s*=\s*["']constituents["']/i);
  if (start < 0) start = html.search(/<table[^>]*class\s*=\s*["'][^"']*wikitable/i);
  if (start < 0) return [];
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? html.length : end);

  const rows = table.split(/<tr[^>]*>/i).slice(1);
  if (rows.length === 0) return [];

  // Baslik satiri: "Symbol" / "Ticker" hangi sutunda?
  let symCol = -1;
  for (const row of rows) {
    const heads = [...row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1]));
    if (heads.length < 2) continue;
    const i = heads.findIndex((h) => /^(symbol|ticker)\b/i.test(h));
    if (i >= 0) { symCol = i; break; }
  }

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (cells.length === 0) continue;

    // Baslik bulunamadiysa: satirdaki ILK sembol-bicimli hucre.
    const raw = symCol >= 0 && symCol < cells.length
      ? cells[symCol]
      : cells.find((c) => TICKER.test(c.toUpperCase())) ?? '';

    const sym = raw.toUpperCase().replace(/\s+/g, '');
    if (!TICKER.test(sym) || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

/**
 * @param {'spx'|'dji'} key
 * @returns {Promise<string[]>}
 */
export async function fetchWikiMembers(key) {
  const page = WIKI_PAGES[key];
  if (!page) return [];
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
  return parseWikiConstituents(html);
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

/** Makul uye sayisi araliklari — kaba bir kaynak bozulmasi bunlara takilir. */
export const EXPECTED = {
  spx: [400, 520],
  dji: [25, 35],
  ndx: [85, 110],
};

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
