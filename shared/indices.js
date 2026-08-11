/**
 * Endeks kutugu.
 *
 * ── Neden tek bir matematik yetiyor ──
 * Mevcut katki formulu `w_i = payAdedi_i · baz_i / Σ` seklinde. Ucunun de
 * ayni formulle cikmasinin sebebi, agirlik semasinin YALNIZCA "pay adedi"
 * alanina bakmasi:
 *
 *   NASDAQ-100 / S&P 500 — kap agirlikli:  payAdedi = gercek pay adedi
 *   Dow Jones 30        — FIYAT agirlikli: payAdedi = 1
 *
 * Dow icin ozel bir kod yolu yok. DJIA = ΣP/D oldugundan
 *
 *     getiri = ΔΣP / ΣP = Σ (P_i/ΣP) · (ΔP_i/P_i) = Σ w_i·r_i,   w_i = P_i/ΣP
 *
 * ve `payAdedi = 1` konuldugunda `computeWeights` tam olarak bunu uretir.
 * Bolen (D) sadelesip gittigi icin degerini bilmemize de gerek yok.
 *
 * ── Uye listeleri ──
 * ASLA model bilgisinden yazilmaz. 503 sembollük bir S&P 500 listesini
 * ezberden dokmek, endeks agirliklarini uydurmakla ayni sinif hatadir ve tek
 * tek dogrulanamaz. Liste canli kaynaktan gelmezse o endeks ACILMAZ —
 * eksik/yanlis bir endeks gostermektense hic gostermemek dogru.
 */

/**
 * @typedef {object} IndexDef
 * @property {string} key        ic anahtar (URL parametresi)
 * @property {string} label      tam ad
 * @property {string} short      rozet metni
 * @property {string} slug       api.nasdaq.com list-type slug'i
 * @property {'cap'|'price'} weighting
 * @property {number} minMembers bu sayidan az uye gelirse endeks acilmaz
 * @property {string} note       arayuzde gosterilen tek cumlelik aciklama
 */

/** @type {Record<string, IndexDef>} */
export const INDICES = {
  ndx: {
    key: 'ndx',
    label: 'NASDAQ-100',
    short: 'NDX',
    slug: 'nasdaq100',
    weighting: 'cap',
    minMembers: 85,
    note: 'Piyasa değeri ağırlıklı — birkaç mega-cap endeksin üçte ikisini taşıyor.',
  },
  spx: {
    key: 'spx',
    label: 'S&P 500',
    short: 'SPX',
    slug: 'sp500',
    weighting: 'cap',
    minMembers: 400,
    note: 'Piyasa değeri ağırlıklı — ağırlıklar piyasa değerinden türetiliyor, ' +
      'serbest dolaşım düzeltmesi yapılamadığı için resmî ağırlıktan bir miktar sapar.',
  },
  dji: {
    key: 'dji',
    label: 'Dow Jones 30',
    short: 'DJI',
    slug: 'dowjones',
    weighting: 'price',
    minMembers: 25,
    note: 'FİYAT ağırlıklı — pahalı hisse endeksi daha çok oynatır, şirketin ' +
      'büyüklüğünün hiç önemi yoktur.',
  },
};

/** Varsayilan endeks — sitenin cikis sorusu bunun uzerine kurulu. */
export const DEFAULT_INDEX = 'ndx';

export const INDEX_KEYS = Object.keys(INDICES);

/**
 * @param {string|null|undefined} key
 * @returns {IndexDef}
 */
export function indexDef(key) {
  return INDICES[String(key ?? '').toLowerCase()] ?? INDICES[DEFAULT_INDEX];
}

/**
 * Bir uye satirindan agirlik hesabinda kullanilacak "pay adedi"ni verir.
 *
 * Fiyat agirlikli endekste bu SABIT 1'dir — bu bir kestirme degil, endeksin
 * tanimi (bkz. dosya basi).
 *
 * Kap agirlikli endekste once gercek pay adedi (Invesco/kullanici verisi),
 * yoksa piyasa degerinden turetilir: payAdedi = piyasaDegeri / fiyat.
 *
 * @param {'cap'|'price'} weighting
 * @param {{shares?: number|null, marketCap?: number|null, price?: number|null}} row
 * @returns {number|null} kullanilamazsa null
 */
export function weightShares(weighting, row) {
  if (weighting === 'price') return 1;

  if (Number.isFinite(row?.shares) && /** @type {number} */ (row.shares) > 0) {
    return /** @type {number} */ (row.shares);
  }
  const mc = row?.marketCap;
  const px = row?.price;
  if (Number.isFinite(mc) && /** @type {number} */ (mc) > 0 &&
      Number.isFinite(px) && /** @type {number} */ (px) > 0) {
    return /** @type {number} */ (mc) / /** @type {number} */ (px);
  }
  return null;
}
