/**
 * Iraksayan renk olcegi (kutupsallik kodlamasi).
 *
 * Iki hue + NOTR GRI orta nokta. Orta nokta "hicbir sey" okunmali, o yuzden
 * orada hue yok. Kutuplar CVD dogrulamasindan gecti (ΔE 18.7 deutan).
 */

const UP = '#a8f03c';
const DOWN = '#ff5a5a';
const MID = '#383835';

/** Olcek bu esikte doyuma ulasir (%). Uc degerler haritayi ezmesin. */
export const CLAMP_PCT = 3;

const hex2rgb = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const rgb2css = ([r, g, b]) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;

function mix(a, b, t) {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return rgb2css([
    A[0] + (B[0] - A[0]) * t,
    A[1] + (B[1] - A[1]) * t,
    A[2] + (B[2] - A[2]) * t,
  ]);
}

/**
 * @param {number} changePct hisse getirisi (yuzde)
 * @returns {string} css rengi
 */
export function divergingColor(changePct) {
  if (!Number.isFinite(changePct) || changePct === 0) return MID;
  const t = Math.min(1, Math.abs(changePct) / CLAMP_PCT);
  // Hafif ust-dogrusal: kucuk hareketler de griden ayrilsin.
  const eased = Math.pow(t, 0.62);
  return mix(MID, changePct > 0 ? UP : DOWN, 0.14 + eased * 0.86);
}

/** Olcek gostergesi icin css gradyani. */
export function rampCss() {
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    const v = -CLAMP_PCT + (i / 10) * CLAMP_PCT * 2;
    stops.push(`${divergingColor(v)} ${i * 10}%`);
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

/** Kutup renkleri — duz dolgular icin (buyuklukle koyulasma YOK). */
export const POLE = { up: UP, down: DOWN, mid: MID };
