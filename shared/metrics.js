/**
 * Endeks katki matematigi. Saf fonksiyonlar — I/O yok, zaman yok, global yok.
 * Hem sunucu (node) hem tarayici (`/shared/metrics.js`) tarafindan import edilir.
 *
 * Temel ozdeslik (NDX gun ici sabit bolenli modifiye kap-agirlikli bir endekstir):
 *
 *     NDX_t / NDX_base = Σ(MVi,base·(1+ri)) / Σ MVi,base = 1 + Σ wi·ri
 *
 * `^NDX` seans disinda tik atmadigi icin TSI-seans endeks hareketi bu
 * ozdeslikten sentezlenir. Bu bir yaklasim degil — endeksin kendi tanimi,
 * seans disi fiyatlarla degerlendirilmis hali.
 */

/**
 * @typedef {object} QuoteRow
 * @property {string}  symbol
 * @property {string}  [name]
 * @property {string}  [sector]
 * @property {number}  shares          Endeks pay adedi (Invesco "Shares/Par").
 * @property {number}  baseline        sessionStart'tan KESINLIKLE once son baski.
 * @property {number}  price           En guncel baski (seans disi dahil).
 * @property {number|null} [open]      regularMarketOpen — bosluk ayrimi icin.
 * @property {number|null} [lastTradeAtUtc] ms epoch.
 * @property {number|null} [baselineAtUtc]  ms epoch.
 * @property {string}  [baselineSource]
 */

/** Katki hesabinda anlamli kabul edilen en kucuk net endeks hareketi (yuzde puan). */
export const NET_SHARE_MIN_PP = 0.05;

/** Karsi-olgu kaydiricisinin ust siniri. */
export const COUNTERFACTUAL_MAX = 10;

/**
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * @param {number[]} xs
 * @returns {number}
 */
export function median(xs) {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Bir satirin hesaba girebilecek kadar saglam olup olmadigi.
 * @param {QuoteRow} r
 */
export function isUsable(r) {
  return (
    r != null &&
    typeof r.symbol === 'string' &&
    Number.isFinite(r.shares) && r.shares > 0 &&
    Number.isFinite(r.baseline) && r.baseline > 0 &&
    Number.isFinite(r.price) && r.price > 0
  );
}

/**
 * Agirliklar BAZ FIYATLA hesaplanir, onceki ana seans kapanisiyla degil.
 * Boylece seans basinda Σwi = 1 olur ve ozdeslik TSI penceresi boyunca tam kalir.
 * Yazin (EDT) TSI siniri 17:00 ET'ye dustugu icin onceki kapanisi kullanmak
 * ozdesligi sessizce bozardi.
 *
 * @param {QuoteRow[]} rows
 * @returns {{weights: number[], totalMarketValue: number}}
 */
export function computeWeights(rows) {
  const mv = rows.map((r) => r.shares * r.baseline);
  let total = 0;
  for (const v of mv) total += v;
  if (total <= 0) return { weights: rows.map(() => 0), totalMarketValue: 0 };
  return { weights: mv.map((v) => v / total), totalMarketValue: total };
}

/**
 * Karsi-olgu: en cok tasiyan N hisseyi endeksten CIKAR.
 *
 * Kalan agirliklar YENIDEN NORMALIZE edilir. Naif `idxPct − Σ_{i∈T} ci` baska
 * bir soruyu cevaplar (cikarilan agirligi %0 getiriyle yerinde birakir) ve
 * etkiyi oldugundan kucuk gosterir.
 *
 *     r_excl(N) = Σ_{i∉T} wi·ri / Σ_{i∉T} wi
 *
 * @param {{w: number, r: number}[]} items
 * @param {number} maxN
 * @returns {{removeTop: number, changePct: number, naivePct: number}[]}
 */
export function counterfactualCurve(items, maxN = COUNTERFACTUAL_MAX) {
  // Sadece POZITIF katkililar cikarilabilir: "tasiyanlari cikar" sorusu bu.
  const contribs = items.map((it, i) => ({ i, c: it.w * it.r }));
  const positives = contribs.filter((x) => x.c > 0).sort((a, b) => b.c - a.c);

  let totalWr = 0;
  let totalW = 0;
  for (const it of items) {
    totalWr += it.w * it.r;
    totalW += it.w;
  }

  const out = [];
  const removed = new Set();
  let removedWr = 0;
  let removedW = 0;

  const cap = Math.min(maxN, positives.length);
  for (let n = 0; n <= maxN; n++) {
    if (n > 0) {
      if (n <= cap) {
        const pick = positives[n - 1];
        removed.add(pick.i);
        removedWr += items[pick.i].w * items[pick.i].r;
        removedW += items[pick.i].w;
      }
      // n > cap ise cikaracak pozitif katkili kalmamistir; egri duzlesir.
    }
    const remW = totalW - removedW;
    const changePct = remW > 1e-12 ? ((totalWr - removedWr) / remW) * 100 : 0;
    out.push({
      removeTop: n,
      changePct,
      naivePct: (totalWr - removedWr) * 100,
    });
  }
  return out;
}

/**
 * Tum endeks metriklerini kurar.
 *
 * @param {object} input
 * @param {QuoteRow[]} input.rows
 * @param {number} input.ndxBase        Puan cevrimi icin son resmi ^NDX kapanisi.
 * @param {number} input.sessionStartUtc ms epoch — TSI gece yarisi.
 * @param {number|null} [input.officialRegularPct] ^NDX'in canli ana seans %'si.
 * @param {number|null} [input.officialRegularLevel]
 */
export function buildIndexMetrics({
  rows,
  ndxBase,
  sessionStartUtc,
  officialRegularPct = null,
  officialRegularLevel = null,
}) {
  const usable = rows.filter(isUsable);
  const dropped = rows.filter((r) => !isUsable(r)).map((r) => r?.symbol ?? '?');

  const { weights } = computeWeights(usable);

  /** @type {any[]} */
  const constituents = [];
  const returns = [];
  let idxWr = 0;          // Σ wi·ri
  let grossUp = 0;        // Σ max(ci,0)  (yuzde puan)
  let grossDown = 0;      // Σ min(ci,0)
  let upWeight = 0;
  let gapWr = 0;
  let rthWr = 0;
  let gapDefinedWeight = 0;

  let advancers = 0, decliners = 0, unchanged = 0, noTrade = 0;

  for (let i = 0; i < usable.length; i++) {
    const row = usable[i];
    const w = weights[i];
    const r = row.price / row.baseline - 1;
    const contribPp = w * r * 100;
    const contribPts = w * r * ndxBase;

    idxWr += w * r;
    if (contribPp > 0) grossUp += contribPp;
    else if (contribPp < 0) grossDown += contribPp;
    if (r > 0) upWeight += w;
    returns.push(r);

    // Seans basindan beri hic baski gelmediyse bu hisse "islem yok" kovasinda.
    // Seans disi baskilar seyrek oldugu icin gece bu kova cogunlugu olusturur;
    // onlari "degismedi" saymak paneli bozuk gosterir.
    const traded =
      Number.isFinite(row.lastTradeAtUtc) &&
      /** @type {number} */ (row.lastTradeAtUtc) >= sessionStartUtc;

    if (!traded) noTrade++;
    else if (r > 0) advancers++;
    else if (r < 0) decliners++;
    else unchanged++;

    // Bosluk (TSI gece yarisi -> bugunku acilis) ve ana seans (acilis -> simdi)
    // ayrimi: "gece mi tasindi, seans icinde mi?" sorusunu cevaplar.
    let gapPct = null;
    let rthPct = null;
    if (Number.isFinite(row.open) && /** @type {number} */ (row.open) > 0) {
      const open = /** @type {number} */ (row.open);
      const rGap = open / row.baseline - 1;
      const rRth = row.price / open - 1;
      gapPct = rGap * 100;
      rthPct = rRth * 100;
      gapWr += w * rGap;
      rthWr += w * rRth;
      gapDefinedWeight += w;
    }

    constituents.push({
      s: row.symbol,
      n: row.name ?? row.symbol,
      sector: row.sector ?? null,
      w,
      price: row.price,
      baseline: row.baseline,
      changePct: r * 100,
      contribPp,
      contribPts,
      gapPct,
      rthPct,
      traded,
      lastTradeAtUtc: row.lastTradeAtUtc ?? null,
      baselineAtUtc: row.baselineAtUtc ?? null,
      baselineSource: row.baselineSource ?? null,
      // sharePct asagida doldurulur (grossUp/grossDown tamamlandiktan sonra).
      sharePct: 0,
      shareOfNetPct: null,
    });
  }

  const idxPct = idxWr * 100;

  // Pay: her hisse KENDI tarafinin brut havuzuna oranlanir. `ci/idxPct`
  // cazip ama idxPct ~ 0 iken patlar; brut havuz her zaman tanimli.
  for (const c of constituents) {
    if (c.contribPp > 0) {
      c.sharePct = grossUp > 0 ? (c.contribPp / grossUp) * 100 : 0;
    } else if (c.contribPp < 0) {
      c.sharePct = grossDown < 0 ? (c.contribPp / grossDown) * 100 : 0;
    } else {
      c.sharePct = 0;
    }
    c.shareOfNetPct =
      Math.abs(idxPct) >= NET_SHARE_MIN_PP ? (c.contribPp / idxPct) * 100 : null;
  }

  const byContrib = [...constituents].sort((a, b) => b.contribPp - a.contribPp);
  const carriers = byContrib.filter((c) => c.contribPp > 0);
  const draggers = byContrib.filter((c) => c.contribPp < 0).reverse();

  const equalWeightPct = mean(returns) * 100;
  const medianPct = median(returns) * 100;

  const counterfactual = counterfactualCurve(
    constituents.map((c) => ({ w: c.w, r: c.changePct / 100 }))
  );

  // Ilk 5 tasiyicinin brut yukselisteki payi — konsantrasyon olcusu.
  const top5UpShare = grossUp > 0
    ? (carriers.slice(0, 5).reduce((s, c) => s + c.contribPp, 0) / grossUp) * 100
    : 0;

  // "Yukselisin yarisini kac hisse yapiyor?" — konsantrasyonun en sezgisel hali.
  let namesToHalfOfUp = 0;
  if (grossUp > 0) {
    let acc = 0;
    for (const c of carriers) {
      acc += c.contribPp;
      namesToHalfOfUp++;
      if (acc >= grossUp / 2) break;
    }
  }

  // Agirlik eskimesi alarmi: yalniz-ana-seans sentetik vs resmi ^NDX.
  let trackingErrorPp = null;
  if (Number.isFinite(officialRegularPct) && gapDefinedWeight > 0.5) {
    trackingErrorPp = rthWr * 100 - /** @type {number} */ (officialRegularPct);
  }

  const traded = advancers + decliners + unchanged;

  return {
    index: {
      ndxBase,
      syntheticLevel: ndxBase * (1 + idxWr),
      changePct: idxPct,
      changePts: idxWr * ndxBase,
      officialRegularPct,
      officialRegularLevel,
      trackingErrorPp,
      equalWeightPct,
      medianPct,
      divergencePp: idxPct - equalWeightPct,
      grossUpPp: grossUp,
      grossDownPp: grossDown,
      upWeight,
      top5UpShare,
      namesToHalfOfUp,
      gapPct: gapDefinedWeight > 0 ? gapWr * 100 : null,
      rthPct: gapDefinedWeight > 0 ? rthWr * 100 : null,
      breadth: {
        advancers,
        decliners,
        unchanged,
        noTrade,
        traded,
        declinersPctOfTraded: traded > 0 ? (decliners / traded) * 100 : 0,
        advancersPctOfTraded: traded > 0 ? (advancers / traded) * 100 : 0,
      },
    },
    constituents,
    carriers,
    draggers,
    counterfactual,
    dropped,
  };
}

/**
 * Yayin oncesi degismez kontrolleri. Bozuk anlik goruntu ASLA store'a girmez.
 * @param {ReturnType<typeof buildIndexMetrics>} m
 * @param {{minConstituents?: number}} [opts]
 * @returns {string[]} bos dizi => saglikli
 */
export function checkInvariants(m, { minConstituents = 85 } = {}) {
  const errs = [];
  const n = m.constituents.length;
  if (n < minConstituents) errs.push(`cok az hisse: ${n} < ${minConstituents}`);

  const wSum = m.constituents.reduce((s, c) => s + c.w, 0);
  if (Math.abs(wSum - 1) > 1e-6) errs.push(`Σw = ${wSum}, 1 olmali`);

  const ppSum = m.constituents.reduce((s, c) => s + c.contribPp, 0);
  if (Math.abs(ppSum - m.index.changePct) > 1e-6) {
    errs.push(`Σ katkiPp (${ppSum}) ≠ endeks % (${m.index.changePct})`);
  }

  const ptsSum = m.constituents.reduce((s, c) => s + c.contribPts, 0);
  const ptsExpected = m.index.syntheticLevel - m.index.ndxBase;
  if (m.index.ndxBase > 0 &&
      Math.abs(ptsSum - ptsExpected) / m.index.ndxBase > 1e-9) {
    errs.push(`Σ katkiPuan (${ptsSum}) ≠ seviye farki (${ptsExpected})`);
  }

  for (const c of m.constituents) {
    if (!(c.price > 0) || !(c.baseline > 0)) {
      errs.push(`${c.s}: gecersiz fiyat/baz`);
      break;
    }
  }
  return errs;
}
