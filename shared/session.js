/**
 * TSI seans modeli — "TSI 00:00–24:00, seans disi dahil".
 *
 * Turkiye 2016'dan beri sabit UTC+3 (DST yok). Dolayisiyla tek bir sabit her
 * seyi tanimliyor:
 *
 *     TSI gece yarisi ≡ HER ZAMAN 21:00:00 UTC
 *
 * Beklenmedik sonuc: bu sinir ABD'de yazin 17:00 ET'ye, kisin 16:00 ET'ye
 * dusuyor. Yani KISIN TSI gunu tam olarak kapanis-kapanis; yazin pencere
 * after-hours'a bir saat kayiyor ve TSI gunu onceki gunun post-market
 * kuyrugunu icine aliyor.
 */

import {
  isTradingDay,
  isWeekend,
  isHoliday,
  isHalfDay,
  previousTradingDay,
} from './holidays.js';

export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;

/** TSI gece yarisinin UTC saat karsiligi. Turkiye'de DST olmadigi icin sabit. */
export const TSI_MIDNIGHT_UTC_HOUR = 21;

/** TSI = UTC+3. */
export const TSI_OFFSET_MS = 3 * HOUR_MS;

/** @typedef {'CARRY_AFTER_HOURS'|'OVERNIGHT'|'PRE'|'REGULAR'|'AFTER_HOURS'|'WEEKEND'|'HOLIDAY'} SessionPhase */

/** @type {Record<SessionPhase, string>} */
export const PHASE_LABELS_TR = {
  CARRY_AFTER_HOURS: 'Önceki seansın uzatılmış işlemleri',
  OVERNIGHT: 'Piyasa kapalı',
  PRE: 'Açılış öncesi (pre-market)',
  REGULAR: 'Ana seans',
  AFTER_HOURS: 'Kapanış sonrası (after-hours)',
  WEEKEND: 'Hafta sonu',
  HOLIDAY: 'Resmî tatil',
};

/** @type {Record<SessionPhase, boolean>} */
export const PHASE_IS_LIVE = {
  CARRY_AFTER_HOURS: true,
  OVERNIGHT: false,
  PRE: true,
  REGULAR: true,
  AFTER_HOURS: true,
  WEEKEND: false,
  HOLIDAY: false,
};

/**
 * Bir an icin New York'un UTC ofseti (saat cinsinden, -4 veya -5).
 * DST kurallari sabit kodlanmiyor — Intl'e soruluyor.
 * @param {number} ms
 * @returns {number}
 */
export function etOffsetHours(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(ms));
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return -5;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  return h + (h < 0 ? -min / 60 : min / 60);
}

/**
 * ABD takvim tarihindeki bir duvar saatini UTC ms'e cevirir.
 *
 * ABD DST gecisleri 02:00 ET'de olur — yani her piyasa fazindan (en erken
 * 04:00 ET pre-market) ONCE. Bu yuzden hicbir faz ani belirsiz ya da yok
 * degildir; iki turluk yakinsama daima yeter.
 *
 * @param {string} isoDate YYYY-MM-DD (ABD takvimi)
 * @param {string} hhmm 'HH:MM'
 * @returns {number} ms epoch
 */
export function etWallClockToUtc(isoDate, hhmm) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const [H, M] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, H, M, 0, 0);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const off = etOffsetHours(guess);
    const next = naive - off * HOUR_MS;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/**
 * Simdiki ana denk gelen TSI seansinin baslangici (UTC ms).
 * @param {number} nowMs
 */
export function sessionStartUtc(nowMs) {
  const d = new Date(nowMs);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = utcMidnight + TSI_MIDNIGHT_UTC_HOUR * HOUR_MS;
  return start > nowMs ? start - DAY_MS : start;
}

/** @param {number} nowMs */
export function sessionEndUtc(nowMs) {
  return sessionStartUtc(nowMs) + DAY_MS;
}

/**
 * TSI takvim tarihi. Ayni zamanda o seansin ana ABD islem gunudur.
 * @param {number} ms
 * @returns {string} YYYY-MM-DD
 */
export function tsiDate(ms) {
  return new Date(ms + TSI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Bir TSI gununun baslangic anini verir (o gunun 00:00 TSI'si).
 * @param {string} isoTsiDate
 */
export function startOfTsiDate(isoTsiDate) {
  const [y, m, d] = isoTsiDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - TSI_OFFSET_MS;
}

/**
 * TSI duvar saati 'HH:MM'.
 * @param {number} ms
 */
export function tsiClock(ms) {
  const d = new Date(ms + TSI_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Bir ABD islem gununun faz sinirlari (UTC ms).
 * @param {string} usDate
 */
export function phaseBoundaries(usDate) {
  const half = isHalfDay(usDate);
  return {
    preOpen: etWallClockToUtc(usDate, '04:00'),
    regOpen: etWallClockToUtc(usDate, '09:30'),
    regClose: etWallClockToUtc(usDate, half ? '13:00' : '16:00'),
    postClose: etWallClockToUtc(usDate, half ? '17:00' : '20:00'),
    half,
  };
}

/**
 * Seansin tam durumu.
 *
 * @param {number} nowMs
 * @returns {{
 *   phase: SessionPhase, label: string, live: boolean,
 *   tsiDate: string, usDate: string, isTradingDay: boolean, halfDay: boolean,
 *   sessionStartUtc: number, sessionEndUtc: number, resetAtUtc: number,
 *   nextPhaseAtUtc: number|null, nextPhaseLabel: string|null,
 *   etOffsetHours: number, tsiClock: string
 * }}
 */
export function sessionState(nowMs) {
  const start = sessionStartUtc(nowMs);
  const end = start + DAY_MS;
  const day = tsiDate(nowMs);
  const prevTd = previousTradingDay(day);
  const prevPostClose = phaseBoundaries(prevTd).postClose;

  const base = {
    tsiDate: day,
    usDate: day,
    isTradingDay: isTradingDay(day),
    halfDay: isHalfDay(day),
    sessionStartUtc: start,
    sessionEndUtc: end,
    resetAtUtc: end,
    etOffsetHours: etOffsetHours(nowMs),
    tsiClock: tsiClock(nowMs),
  };

  /**
   * @param {SessionPhase} phase
   * @param {number|null} nextAt
   * @param {SessionPhase|null} nextPhase
   */
  const mk = (phase, nextAt, nextPhase) => ({
    ...base,
    phase,
    label: PHASE_LABELS_TR[phase],
    live: PHASE_IS_LIVE[phase],
    nextPhaseAtUtc: nextAt,
    nextPhaseLabel: nextPhase ? PHASE_LABELS_TR[nextPhase] : null,
  });

  // 1) Devir: TSI gece yarisi ABD'de after-hours'in ortasina dustugu icin
  //    her TSI gunu ONCEKI islem gununun uzatilmis islemleriyle basliyor.
  //    Yazin bu 00:00–03:00 TSI, kisin 00:00–04:00 TSI.
  //    (Pazartesi gibi araya hafta sonu giren gunlerde prevPostClose cok
  //    geride kalir ve bu dal dogal olarak atlanir.)
  if (nowMs < prevPostClose) {
    /** @type {SessionPhase} */
    const after = isTradingDay(day) ? 'OVERNIGHT' : isWeekend(day) ? 'WEEKEND' : 'HOLIDAY';
    return { ...mk('CARRY_AFTER_HOURS', prevPostClose, after), usDate: prevTd };
  }

  // 2) Bugun islem gunu degilse: devir penceresi bittikten sonra hicbir sey olmaz.
  if (!isTradingDay(day)) {
    return mk(isWeekend(day) ? 'WEEKEND' : 'HOLIDAY', end, null);
  }

  // 3) Normal faz merdiveni.
  const b = phaseBoundaries(day);
  if (nowMs < b.preOpen) return mk('OVERNIGHT', b.preOpen, 'PRE');
  if (nowMs < b.regOpen) return mk('PRE', b.regOpen, 'REGULAR');
  if (nowMs < b.regClose) return mk('REGULAR', b.regClose, 'AFTER_HOURS');
  if (nowMs < b.postClose) return mk('AFTER_HOURS', b.postClose, 'OVERNIGHT');
  return mk('OVERNIGHT', end, null);
}

/**
 * Bir TSI gununde hic islem yapilabilir zaman var mi?
 * TSI Pazar'da yok (Cuma'nin after-hours'i Cumartesi'ye dusuyor, Pazar bos).
 * @param {string} isoTsiDate
 */
export function tsiDayHasTrading(isoTsiDate) {
  if (isTradingDay(isoTsiDate)) return true;
  // Devir penceresi: onceki islem gununun post-market'i bu TSI gunune tasiyor mu?
  const start = startOfTsiDate(isoTsiDate);
  const prevPostClose = phaseBoundaries(previousTradingDay(isoTsiDate)).postClose;
  return prevPostClose > start;
}

export { isTradingDay, isWeekend, isHoliday, isHalfDay, previousTradingDay };
