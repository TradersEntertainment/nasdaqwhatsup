/**
 * NYSE / Nasdaq tatil takvimi.
 *
 * BAKIM NOTU: bu liste elle tutulur ve 2028 sonunda tukenir. Tukendiginde
 * `isTradingDay` sadece hafta sonlarini eler; tatil gunleri "islem gunu"
 * sanilir. Sonuc olumcul degil (fiyatlar zaten gelmez, hepsi `noTrade`
 * kovasina duser) ama etiket yanlis olur. Yeni yillar eklenmeli.
 */

/** Tam kapali gunler (ISO YYYY-MM-DD, ABD takvimi). */
export const MARKET_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // Yilbasi
  '2026-01-19', // Martin Luther King Jr.
  '2026-02-16', // Baskanlar Gunu
  '2026-04-03', // Kutsal Cuma
  '2026-05-25', // Anma Gunu
  '2026-06-19', // Juneteenth
  '2026-07-03', // 4 Temmuz (Cumartesi'ye denk geldi, Cuma tatil)
  '2026-09-07', // Isci Bayrami
  '2026-11-26', // Sukran Gunu
  '2026-12-25', // Noel

  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26', // Kutsal Cuma
  '2027-05-31',
  '2027-06-18', // Juneteenth Cumartesi'ye denk geldi
  '2027-07-05', // 4 Temmuz Pazar'a denk geldi
  '2027-09-06',
  '2027-11-25',
  '2027-12-24', // Noel Cumartesi'ye denk geldi

  // 2028
  '2028-01-17',
  '2028-02-21',
  '2028-04-14', // Kutsal Cuma
  '2028-05-29',
  '2028-06-19',
  '2028-07-04',
  '2028-09-04',
  '2028-11-23',
  '2028-12-25',
]);

/** Yarim gunler — ana seans 13:00 ET'de kapanir, uzatilmis islem 17:00 ET. */
export const HALF_DAYS = new Set([
  '2026-11-27', // Sukran Gunu ertesi
  '2026-12-24', // Noel arifesi
  '2027-07-02', // 4 Temmuz oncesi
  '2027-11-26',
  '2028-07-03',
  '2028-11-24',
]);

/**
 * @param {string} isoDate YYYY-MM-DD
 * @returns {number} 0=Pazar … 6=Cumartesi
 */
export function dayOfWeek(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** @param {string} isoDate */
export function isWeekend(isoDate) {
  const dow = dayOfWeek(isoDate);
  return dow === 0 || dow === 6;
}

/** @param {string} isoDate */
export function isHoliday(isoDate) {
  return MARKET_HOLIDAYS.has(isoDate);
}

/** @param {string} isoDate */
export function isHalfDay(isoDate) {
  return HALF_DAYS.has(isoDate);
}

/** @param {string} isoDate */
export function isTradingDay(isoDate) {
  return !isWeekend(isoDate) && !isHoliday(isoDate);
}

/**
 * @param {string} isoDate
 * @param {number} deltaDays
 * @returns {string}
 */
export function addDays(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Verilen tarihten onceki en yakin islem gunu (tarih dahil degil).
 * @param {string} isoDate
 * @returns {string}
 */
export function previousTradingDay(isoDate) {
  let cur = addDays(isoDate, -1);
  // 10 gun geriye bakmak her tatil kumesi icin fazlasiyla yeter.
  for (let i = 0; i < 10; i++) {
    if (isTradingDay(cur)) return cur;
    cur = addDays(cur, -1);
  }
  return cur;
}
