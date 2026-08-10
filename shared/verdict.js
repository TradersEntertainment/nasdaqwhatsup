/**
 * Teshis: endeksin bugunku hareketi "genis" mi yoksa birkac hissenin sirtinda mi?
 *
 * Sitenin varlik sebebi bu siniflandirma. Kullanicinin sorusu ("Nasdaq yesil
 * ama benim hisselerim kirmizi, kim tasiyor?") tam olarak MASKED_WEAKNESS
 * durumuna karsilik geliyor.
 */

/** Iraksamanin "anlamli" sayilmaya basladigi esik (yuzde puan). */
export const DIVERGENCE_PP = 0.25;

/** Endeksin "yatay" sayildigi esik (yuzde). */
export const FLAT_PCT = 0.08;

/** Genislik istatistiginin anlamli olmasi icin gereken en az islem goren hisse. */
export const MIN_TRADED = 20;

/** @typedef {'MASKED_WEAKNESS'|'MASKED_STRENGTH'|'BROAD_RALLY'|'BROAD_SELLOFF'|'MIXED'|'FLAT'|'QUIET'|'PARTIAL'} Verdict */

/** @type {Record<Verdict, {title: string, tone: 'up'|'down'|'neutral'}>} */
export const VERDICT_META = {
  MASKED_WEAKNESS: { title: 'Endeksi birkaç hisse taşıyor', tone: 'up' },
  MASKED_STRENGTH: { title: 'Endeksi birkaç hisse aşağı çekiyor', tone: 'down' },
  BROAD_RALLY: { title: 'Yükseliş genişe yayılmış', tone: 'up' },
  BROAD_SELLOFF: { title: 'Satış genişe yayılmış', tone: 'down' },
  MIXED: { title: 'Karışık seyir', tone: 'neutral' },
  FLAT: { title: 'Endeks yatay', tone: 'neutral' },
  QUIET: { title: 'İşlem yok denecek kadar az', tone: 'neutral' },
  // Kismi kapsam: veri kaynagi endeksin tamamini veremiyor. Genislik ve esit
  // agirlik istatistikleri bu modda HESAPLANMAZ — 12 hisseyle "%62 kirmizi"
  // demek yanlis bir sayiyi dogru gibi gostermek olur.
  PARTIAL: { title: 'Kısmi kapsam — büyük hisseler görünümü', tone: 'neutral' },
};

/**
 * @param {any} index buildIndexMetrics().index
 * @returns {{verdict: Verdict, title: string, tone: 'up'|'down'|'neutral'}}
 */
export function classify(index) {
  const b = index.breadth;

  // Seans disinda baskilar seyrek; genislik istatistigi anlamsizlasir.
  if (b.traded < MIN_TRADED) return mk('QUIET');

  const idx = index.changePct;
  const div = index.divergencePp;
  const declinersMajority = b.declinersPctOfTraded > 50;
  const advancersMajority = b.advancersPctOfTraded > 50;

  if (idx > FLAT_PCT && div > DIVERGENCE_PP && declinersMajority) return mk('MASKED_WEAKNESS');
  if (idx < -FLAT_PCT && div < -DIVERGENCE_PP && advancersMajority) return mk('MASKED_STRENGTH');
  if (idx > FLAT_PCT && advancersMajority) return mk('BROAD_RALLY');
  if (idx < -FLAT_PCT && declinersMajority) return mk('BROAD_SELLOFF');
  if (Math.abs(idx) <= FLAT_PCT) return mk('FLAT');
  return mk('MIXED');
}

/** @param {Verdict} v */
function mk(v) {
  return { verdict: v, ...VERDICT_META[v] };
}
