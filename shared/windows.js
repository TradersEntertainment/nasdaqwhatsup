/**
 * Pencere bazli katki: "SON 1 dk / 5 dk / 15 dk / 1 sa / 4 sa icinde endeksi
 * ne yukseltti?"
 *
 * Gunluk katkiyla ayni ozdeslik, sadece baz degisir: TSI gece yarisi yerine
 * `t − Δt` anindaki fiyat.
 *
 *     r_pencere(NDX) = Σ wi(t−Δt) · ( pi(t)/pi(t−Δt) − 1 )
 *
 * Agirliklar PENCERE BASINDAKI fiyatla hesaplanir (gun basindakiyle degil) —
 * aksi halde Σ katki ≠ endeks hareketi olur ve "kim tasidi" cevabi sessizce
 * yanlislasir. 4 saatte %5 oynayan bir hissenin agirligi da o kadar oynar.
 *
 * Saf fonksiyonlar: I/O yok, zaman kaynagi yok. Hem sunucu hem tarayici.
 */

import { computeWeights } from './metrics.js';

/** Kullanicinin istedigi pencereler, kisadan uzuna. */
export const WINDOWS = [
  { key: 'm1', ms: 60_000, label: '1 dk' },
  { key: 'm5', ms: 5 * 60_000, label: '5 dk' },
  { key: 'm15', ms: 15 * 60_000, label: '15 dk' },
  { key: 'h1', ms: 60 * 60_000, label: '1 saat' },
  { key: 'h4', ms: 4 * 60 * 60_000, label: '4 saat' },
];

/** En uzun pencere — bant bu kadar geriyi tutmak zorunda. */
export const MAX_WINDOW_MS = Math.max(...WINDOWS.map((w) => w.ms));

/**
 * Hedef ana en yakin GECMIS kareyi secer.
 *
 * Kural: `t <= now − Δt` olan EN YENI kare. Boylece pencere istenenden kisa
 * degil, en fazla bir poll araligi kadar UZUN olur — "son 1 dakika" diye 40
 * saniyelik bir hareketi gostermekten iyidir.
 *
 * Yeterince eski kare yoksa `null` doner: acilistan 2 dakika sonra "son 4
 * saat" diye 2 dakikalik hareketi gostermek yalan olur.
 *
 * @param {{t: number}[]} frames zaman sirasinda artan
 * @param {number} nowMs
 * @param {number} spanMs
 * @param {number} [tolerance] hedeften ne kadar yeni bir kare kabul edilir
 * @returns {{frame: any, actualMs: number, approx: boolean}|null}
 */
export function pickFrame(frames, nowMs, spanMs, tolerance = 0.5) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const target = nowMs - spanMs;

  let chosen = null;
  for (const f of frames) {
    if (f.t <= target) chosen = f;
    else break;
  }

  // Hedeften eski kare yok: elimizdeki en eski kare hedefe yeterince
  // yakinsa (>= %50 kadar geri gidiyorsa) onu kullan, degilse pencereyi ac.
  if (!chosen) {
    const oldest = frames[0];
    if (nowMs - oldest.t >= spanMs * tolerance) chosen = oldest;
    else return null;
  }

  const actualMs = nowMs - chosen.t;
  // Gercek aralik istenenin %25'inden fazla saparsa kullaniciya soylenir.
  const approx = Math.abs(actualMs - spanMs) > Math.max(60_000, spanMs * 0.25);
  return { frame: chosen, actualMs, approx };
}

/**
 * Bir pencere icin katki dagilimi.
 *
 * @param {object} input
 * @param {{symbol: string, name?: string, sector?: string|null, shares: number, price: number}[]} input.rows guncel
 * @param {Map<string, number>} input.past pencere basindaki fiyatlar
 * @param {number} [input.ndxBase] puan cevrimi icin
 * @param {number} [input.topN] listelenecek tasiyici/dusuruсu sayisi
 * @returns {object|null}
 */
export function windowAttribution({ rows, past, ndxBase = 0, topN = 8 }) {
  const items = [];
  for (const r of rows) {
    const b = past?.get?.(r.symbol);
    if (!(b > 0) || !(r.price > 0) || !(r.shares > 0)) continue;
    items.push({ symbol: r.symbol, name: r.name ?? r.symbol, sector: r.sector ?? null,
      shares: r.shares, baseline: b, price: r.price });
  }
  if (items.length === 0) return null;

  const { weights } = computeWeights(items);

  const list = [];
  let idxWr = 0, grossUp = 0, grossDown = 0;
  let up = 0, down = 0, flat = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const w = weights[i];
    const r = it.price / it.baseline - 1;
    const contribPp = w * r * 100;

    idxWr += w * r;
    if (contribPp > 0) grossUp += contribPp;
    else if (contribPp < 0) grossDown += contribPp;

    // Pencere icinde "islem gordu mu" sorusunu ancak fiyat degisiminden
    // cevaplayabiliyoruz — anlik goruntu kaynaklari sembol basina zaman
    // damgasi vermiyor. Bu yuzden kova adi "kipirdamadi", "islem yok" degil.
    if (r > 0) up++;
    else if (r < 0) down++;
    else flat++;

    list.push({
      s: it.symbol, n: it.name, sector: it.sector,
      w, from: it.baseline, price: it.price,
      changePct: r * 100, contribPp, contribPts: w * r * ndxBase,
      sharePct: 0,
    });
  }

  for (const c of list) {
    if (c.contribPp > 0) c.sharePct = grossUp > 0 ? (c.contribPp / grossUp) * 100 : 0;
    else if (c.contribPp < 0) c.sharePct = grossDown < 0 ? (c.contribPp / grossDown) * 100 : 0;
  }

  const sorted = [...list].sort((a, b) => b.contribPp - a.contribPp);
  const carriers = sorted.filter((c) => c.contribPp > 0);
  const draggers = sorted.filter((c) => c.contribPp < 0).reverse();

  // "Yukselisin yarisini kac hisse yapiyor" — konsantrasyonun en sezgisel hali.
  let namesToHalfOfUp = 0;
  if (grossUp > 0) {
    let acc = 0;
    for (const c of carriers) {
      acc += c.contribPp;
      namesToHalfOfUp++;
      if (acc >= grossUp / 2) break;
    }
  }

  return {
    n: items.length,
    changePct: idxWr * 100,
    changePts: idxWr * ndxBase,
    grossUpPp: grossUp,
    grossDownPp: grossDown,
    up, down, flat,
    movers: up + down,
    namesToHalfOfUp,
    top5UpShare: grossUp > 0
      ? (carriers.slice(0, 5).reduce((s, c) => s + c.contribPp, 0) / grossUp) * 100
      : 0,
    carriers: carriers.slice(0, topN),
    draggers: draggers.slice(0, topN),
  };
}

/**
 * Tum pencereleri banttan kurar. Veri yetmeyen pencere `null` kalir —
 * uydurulmaz.
 *
 * @param {object} input
 * @param {{t: number, p: Record<string, number>}[]} input.frames artan zaman
 * @param {any[]} input.rows guncel satirlar
 * @param {number} input.nowMs
 * @param {number} [input.ndxBase]
 * @param {number} [input.topN]
 */
export function buildWindows({ frames, rows, nowMs, ndxBase = 0, topN = 8 }) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const w of WINDOWS) {
    const hit = pickFrame(frames, nowMs, w.ms);
    if (!hit) { out[w.key] = null; continue; }

    const past = new Map(Object.entries(hit.frame.p ?? {}));
    const a = windowAttribution({ rows, past, ndxBase, topN });
    if (!a) { out[w.key] = null; continue; }

    out[w.key] = {
      key: w.key,
      label: w.label,
      spanMs: w.ms,
      actualMs: hit.actualMs,
      approx: hit.approx,
      fromUtc: hit.frame.t,
      ...a,
    };
  }
  return out;
}
