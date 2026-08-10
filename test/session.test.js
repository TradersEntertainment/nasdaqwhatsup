import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionStartUtc,
  sessionEndUtc,
  tsiDate,
  tsiClock,
  etOffsetHours,
  etWallClockToUtc,
  sessionState,
  phaseBoundaries,
  tsiDayHasTrading,
  startOfTsiDate,
  DAY_MS,
} from '../shared/session.js';
import { previousTradingDay, isHalfDay } from '../shared/holidays.js';

const at = (iso) => Date.parse(iso);

// TSI = UTC+3, DST yok. Testleri okunur tutmak icin kucuk yardimci.
const tsi = (isoDate, hhmm) => at(`${isoDate}T${hhmm}:00+03:00`);

test('TSI gece yarisi her zaman 21:00 UTC', () => {
  assert.equal(sessionStartUtc(at('2026-08-11T20:59:00Z')), at('2026-08-10T21:00:00Z'));
  assert.equal(tsiDate(at('2026-08-11T20:59:00Z')), '2026-08-11');

  // Bir dakika sonra pencere devrediyor.
  assert.equal(sessionStartUtc(at('2026-08-11T21:00:00Z')), at('2026-08-11T21:00:00Z'));
  assert.equal(tsiDate(at('2026-08-11T21:00:00Z')), '2026-08-12');

  // Kis da ayni — Turkiye'de DST yok.
  assert.equal(sessionStartUtc(at('2026-01-15T20:59:00Z')), at('2026-01-14T21:00:00Z'));
  assert.equal(tsiDate(at('2026-01-15T21:00:00Z')), '2026-01-16');
});

test('seans penceresi tam 24 saat', () => {
  const n = at('2026-08-11T12:00:00Z');
  assert.equal(sessionEndUtc(n) - sessionStartUtc(n), DAY_MS);
});

test('startOfTsiDate ile sessionStartUtc tutarli', () => {
  const n = at('2026-08-11T12:00:00Z');
  assert.equal(startOfTsiDate(tsiDate(n)), sessionStartUtc(n));
});

test('ET ofseti Intl uzerinden cozulur, sabit kodlanmaz', () => {
  assert.equal(etOffsetHours(at('2026-08-11T12:00:00Z')), -4); // EDT
  assert.equal(etOffsetHours(at('2026-01-15T12:00:00Z')), -5); // EST
});

test('TSI siniri yazin 17:00 ET, kisin 16:00 ET', () => {
  // Yaz: TSI gece yarisi after-hours'in ortasina duser.
  assert.equal(etWallClockToUtc('2026-08-11', '17:00'), at('2026-08-11T21:00:00Z'));
  // Kis: TSI gece yarisi TAM olarak resmi kapanistir.
  assert.equal(etWallClockToUtc('2026-01-15', '16:00'), at('2026-01-15T21:00:00Z'));
});

test('kisin TSI gunu kapanis-kapanis ile ortusur', () => {
  const b = phaseBoundaries('2026-01-15');
  // Ana seans kapanisi, o TSI gununun bitisiyle ayni an.
  assert.equal(b.regClose, sessionEndUtc(tsi('2026-01-15', '12:00')));
});

test('yaz gunu faz merdiveni (2026-08-11 Sali, EDT)', () => {
  const day = '2026-08-11';
  const p = (hhmm) => sessionState(tsi(day, hhmm)).phase;

  assert.equal(p('01:00'), 'CARRY_AFTER_HOURS'); // 10  Agu 18:00 ET
  assert.equal(p('02:59'), 'CARRY_AFTER_HOURS');
  assert.equal(p('03:00'), 'OVERNIGHT');         // 10 Agu 20:00 ET — after-hours bitti
  assert.equal(p('10:59'), 'OVERNIGHT');
  assert.equal(p('11:00'), 'PRE');               // 04:00 ET
  assert.equal(p('16:29'), 'PRE');
  assert.equal(p('16:30'), 'REGULAR');           // 09:30 ET
  assert.equal(p('22:59'), 'REGULAR');
  assert.equal(p('23:00'), 'AFTER_HOURS');       // 16:00 ET
  assert.equal(p('23:59'), 'AFTER_HOURS');
});

test('kis gunu faz merdiveni (2026-01-15 Persembe, EST)', () => {
  const day = '2026-01-15';
  const p = (hhmm) => sessionState(tsi(day, hhmm)).phase;

  assert.equal(p('01:00'), 'CARRY_AFTER_HOURS'); // 14 Oca 17:00 ET
  assert.equal(p('03:59'), 'CARRY_AFTER_HOURS');
  assert.equal(p('04:00'), 'OVERNIGHT');         // 14 Oca 20:00 ET
  assert.equal(p('11:59'), 'OVERNIGHT');
  assert.equal(p('12:00'), 'PRE');               // 04:00 ET
  assert.equal(p('17:29'), 'PRE');
  assert.equal(p('17:30'), 'REGULAR');           // 09:30 ET
  assert.equal(p('23:59'), 'REGULAR');           // kisin kapanis TSI 24:00'te
});

test('devir penceresinde usDate onceki islem gunudur', () => {
  const s = sessionState(tsi('2026-08-11', '01:00'));
  assert.equal(s.phase, 'CARRY_AFTER_HOURS');
  assert.equal(s.tsiDate, '2026-08-11');
  assert.equal(s.usDate, '2026-08-10');
});

test('TSI Cumartesi Cuma aksaminin after-hours kuyrugunu tasir', () => {
  // 2026-08-15 Cumartesi; 2026-08-14 Cuma.
  assert.equal(sessionState(tsi('2026-08-15', '01:00')).phase, 'CARRY_AFTER_HOURS');
  assert.equal(sessionState(tsi('2026-08-15', '02:59')).phase, 'CARRY_AFTER_HOURS');
  assert.equal(sessionState(tsi('2026-08-15', '10:00')).phase, 'WEEKEND');
  assert.equal(tsiDayHasTrading('2026-08-15'), true);
});

test('TSI Pazar tamamen bos — hicbir islem penceresi yok', () => {
  assert.equal(sessionState(tsi('2026-08-16', '01:00')).phase, 'WEEKEND');
  assert.equal(sessionState(tsi('2026-08-16', '18:00')).phase, 'WEEKEND');
  assert.equal(tsiDayHasTrading('2026-08-16'), false);
});

test('Pazartesi TSI gununde devir yok (araya hafta sonu giriyor)', () => {
  // 2026-08-17 Pazartesi: onceki islem gunu Cuma 14 Agu, onun post-market'i
  // cok geride kaldi — devir dali dogal olarak atlanmali.
  assert.equal(sessionState(tsi('2026-08-17', '01:00')).phase, 'OVERNIGHT');
});

test('resmi tatil etiketlenir', () => {
  // 2026-01-01 Yilbasi (Persembe).
  assert.equal(sessionState(tsi('2026-01-01', '18:00')).phase, 'HOLIDAY');
  assert.equal(sessionState(tsi('2026-01-01', '18:00')).isTradingDay, false);
});

test('yarim gun ana seansi 13:00 ET kapatir', () => {
  assert.ok(isHalfDay('2026-11-27'), 'Sukran Gunu ertesi yarim gun');
  const b = phaseBoundaries('2026-11-27');
  assert.equal(b.regClose, etWallClockToUtc('2026-11-27', '13:00'));
  assert.equal(b.postClose, etWallClockToUtc('2026-11-27', '17:00'));
  // 13:00 ET = TSI 21:00 (EST) → hemen sonrasi after-hours.
  assert.equal(sessionState(tsi('2026-11-27', '21:30')).phase, 'AFTER_HOURS');
});

test('onceki islem gunu tatilleri ve hafta sonlarini atlar', () => {
  assert.equal(previousTradingDay('2026-08-17'), '2026-08-14'); // Pzt → Cuma
  assert.equal(previousTradingDay('2026-01-02'), '2025-12-31'); // Yilbasini atla
  assert.equal(previousTradingDay('2026-11-27'), '2026-11-25'); // Sukran Gununu atla
});

test('ABD DST gecis gunlerinde hicbir faz belirsiz degil', () => {
  // ABD DST gecisleri 02:00 ET'de olur — en erken piyasa fazi (04:00 ET
  // pre-market) ONCESINDE. Bu yuzden hicbir faz ani yok olmaz ya da tekrarlamaz.
  for (const day of ['2026-03-08', '2026-11-01', '2027-03-14', '2027-11-07']) {
    const b = phaseBoundaries(day);
    assert.ok(b.preOpen < b.regOpen, `${day}: preOpen < regOpen`);
    assert.ok(b.regOpen < b.regClose, `${day}: regOpen < regClose`);
    assert.ok(b.regClose < b.postClose, `${day}: regClose < postClose`);
  }
});

test('faz merdiveni gun boyunca monoton ilerler', () => {
  const day = '2026-08-11';
  const seen = [];
  for (let m = 0; m < 24 * 60; m += 5) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const s = sessionState(tsi(day, `${hh}:${mm}`));
    // Her ornek ayni TSI gunune ait olmali.
    assert.equal(s.tsiDate, day, `${hh}:${mm} yanlis TSI gunune dustu`);
    if (seen.at(-1) !== s.phase) seen.push(s.phase);
  }
  assert.deepEqual(seen, [
    'CARRY_AFTER_HOURS', 'OVERNIGHT', 'PRE', 'REGULAR', 'AFTER_HOURS',
  ]);
});

test('tsiClock TSI duvar saatini verir', () => {
  assert.equal(tsiClock(at('2026-08-11T21:00:00Z')), '00:00');
  assert.equal(tsiClock(at('2026-08-11T12:00:00Z')), '15:00');
});

test('sonraki faz zamani ileride ve etiketli', () => {
  const s = sessionState(tsi('2026-08-11', '18:00'));
  assert.equal(s.phase, 'REGULAR');
  assert.ok(s.nextPhaseAtUtc > tsi('2026-08-11', '18:00'));
  assert.equal(s.nextPhaseLabel, 'Kapanis sonrasi (after-hours)');
  assert.equal(s.resetAtUtc, sessionEndUtc(tsi('2026-08-11', '18:00')));
});
