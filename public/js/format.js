/**
 * tr-TR bicimleme.
 *
 * Turkce'de yuzde isareti ONDE gelir (%0,80). Intl bunu dogru yapiyor —
 * `node -e` ile dogrulandi — o yuzden string elle kurulmuyor.
 */

const nf = (opts) => new Intl.NumberFormat('tr-TR', opts);

const PCT = nf({ style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const PCT1 = nf({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const PCT0 = nf({ style: 'percent', maximumFractionDigits: 0 });
const NUM2 = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM2S = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const USD = nf({ style: 'currency', currency: 'USD' });
const INT = nf({ maximumFractionDigits: 0 });

/** Yuzde. Girdi zaten yuzde cinsinden (0,80 => %0,80). */
export const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : PCT.format(v / 100));
export const pct1 = (v) => (v == null || !Number.isFinite(v) ? '—' : PCT1.format(v / 100));
/** Isaretsiz yuzde — "hisselerin %62'si" gibi oranlar icin. */
export const pctPlain = (v) => (v == null || !Number.isFinite(v) ? '—' : PCT0.format(v / 100));

/** Yuzde puan (fark olcusu). */
export const pp = (v) => (v == null || !Number.isFinite(v) ? '—' : NUM2S.format(v) + ' pp');
export const ppPlain = (v) => (v == null || !Number.isFinite(v) ? '—' : NUM2.format(v) + ' pp');

export const pts = (v) => (v == null || !Number.isFinite(v) ? '—' : NUM2S.format(v));
export const usd = (v) => (v == null || !Number.isFinite(v) ? '—' : USD.format(v));
export const int = (v) => (v == null || !Number.isFinite(v) ? '—' : INT.format(v));

/** Yon oku — renk tek sinyal olmasin diye her sayinin yaninda. */
export const arrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '—');
export const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

/** TSI (Europe/Istanbul) duvar saati. */
const TSI_TIME = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false,
});
const TSI_DATE = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', weekday: 'long',
});

export const tsiTime = (ms) => TSI_TIME.format(new Date(ms));
export const tsiDateLong = (ms) => TSI_DATE.format(new Date(ms));

/** "YYYY-MM-DD" -> "11 Agustos Sali" */
export function tsiDayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  // TSI gununun ortasini alarak zaman dilimi kaymalarindan kacin.
  return TSI_DATE.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Kalan sureyi "3sa 12dk" gibi yazar. */
export function until(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}sa ${String(m).padStart(2, '0')}dk`;
  if (m > 0) return `${m}dk`;
  return `${s}sn`;
}

/** Veri yasi. */
export function age(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} sn`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} dk`;
  return `${Math.round(m / 60)} sa`;
}

/**
 * Sembol rozeti icin deterministik renk. Kimlik degil dekorasyon —
 * veri kodlamiyor, o yuzden serbest hue.
 */
export function badgeColor(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 58% 62%)`;
}

/**
 * Sembol normalizasyonu.
 *
 * DIKKAT: toLocaleUpperCase('tr') KULLANILMAZ — 'nvidia' -> 'NVİDİA' yapar
 * (noktali I) ve butun aramalari bozar. Dogrulandi.
 */
export function normalizeSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9.\-]{1,6}$/.test(s) ? s : null;
}
