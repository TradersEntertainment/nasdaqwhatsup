/**
 * Veri dongusu.
 *
 * Iki zamanlayici:
 *  1. Sabit aralikli poll (varsayilan 5 dk) — guncel fiyatlar.
 *  2. TSI gun devrinde tetiklenen KENDINI YENIDEN ZAMANLAYAN timeout —
 *     baz fiyatlarin yeniden cekilmesi. Cron ifadesi degil hesaplanmis an;
 *     interval kaymasina ve surec yeniden baslamalarina bagisik.
 */

import { config } from './config.js';
import { log } from './lib/log.js';
import * as store from './store.js';
import * as history from './history.js';
import * as storage from './storage.js';
import { buildSnapshot } from './pipeline/build-snapshot.js';
import { fetchFixture } from './sources/fixture.js';
import { sessionEndUtc } from '../shared/session.js';

let inFlight = false;
let tick = 0;
/** @type {NodeJS.Timeout|null} */
let intervalTimer = null;
/** @type {NodeJS.Timeout|null} */
let rolloverTimer = null;
/** Bir sonraki poll'da bazlarin yeniden cekilmesi gerektigini isaretler. */
let needBaselineRefresh = true;

/**
 * @param {string} reason
 */
export async function runOnce(reason = 'manual', { fast = false } = {}) {
  if (inFlight) {
    log.debug('poll atlandi — onceki tur devam ediyor', { reason });
    return;
  }
  inFlight = true;
  const t0 = Date.now();

  try {
    const raw = config.fixtureMode
      ? fetchFixture(tick++)
      : await fetchLive(needBaselineRefresh, fast);

    const { snapshot, errors } = buildSnapshot({
      rows: raw.rows,
      ndxBase: raw.ndxBase,
      nowUtc: raw.nowUtc,
      officialRegularPct: raw.officialRegularPct,
      officialRegularLevel: raw.officialRegularLevel,
      quality: {
        ...raw.quality,
        consecutiveFailures: store.health().consecutiveFailures,
        // Fixture modunda saat sabitlenmis olabilir; on yuz gercek saati
        // kullanirsa faz ile saat celisir ve geri sayim 24 saati asar.
        clockPinned: config.fixtureMode && config.fixturePinClock,
      },
      // Fixture'da varyantlar bilincli olarak eksik hisseli olabiliyor.
      minConstituents: config.fixtureMode ? 50 : 85,
    });

    if (errors.length) {
      store.recordFailure(errors);
      return;
    }

    // TSI gunu degistiyse onceki gunu kapat (gecmise yaz).
    const prev = store.get();
    if (prev && prev.tsiDay !== snapshot.tsiDay) {
      await history.closeDay(prev);
      await storage.prune();
    }

    // Bu TSI gununde hic islem yoksa (hafta sonu / tatil / gece), son
    // kapanmis seansi ilistir — kullanici sifir duvari yerine "dun kim
    // tasidi" cevabini gorsun.
    if (snapshot.index.breadth.traded === 0) {
      snapshot.lastSession = await history.getLastClosedSession(snapshot.tsiDay);
    }

    store.set(snapshot);
    // Hizli gecis gercek bazlari cekmedi; bayragi DUSURME, rafine tur yapsin.
    if (!fast) needBaselineRefresh = false;
    await history.recordIntraday(snapshot);

    log.info('poll tamam', {
      reason,
      ms: Date.now() - t0,
      phase: snapshot.session.phase,
      idx: snapshot.index.changePct,
      ew: snapshot.index.equalWeightPct,
      n: snapshot.constituents.length,
      src: snapshot.quality.source,
    });
  } catch (err) {
    store.recordFailure([String(err?.message ?? err)]);
    log.error('poll hatasi', { reason, err: String(err?.stack ?? err) });
  } finally {
    inFlight = false;
    scheduleRollover();
  }
}

/**
 * Canli yol. Bu container'dan test EDILEMEZ (piyasa host'lari 403); yalnizca
 * Railway'de calisir. Bu yuzden savunmaci yazildi ve her hata yukari tasinir —
 * poller bunu yakalayip onceki goruntuyu servis etmeye devam eder.
 * @param {boolean} refreshBaselines
 */
async function fetchLive(refreshBaselines, fast) {
  const { fetchLiveRows } = await import('./pipeline/live.js');
  return fetchLiveRows({ refreshBaselines, fast });
}

/** TSI gun devrinde bazlari yeniden cekmek uzere kendini yeniden zamanlar. */
function scheduleRollover() {
  if (rolloverTimer) clearTimeout(rolloverTimer);
  const now = Date.now();
  const fireAt = sessionEndUtc(now) + 30_000; // devirden 30 sn sonra
  const delay = Math.max(1000, fireAt - now);
  rolloverTimer = setTimeout(() => {
    log.info('TSI gun devri — bazlar yeniden cekilecek');
    needBaselineRefresh = true;
    runOnce('rollover');
  }, delay);
  // Timer surecin kapanmasini engellemesin.
  rolloverTimer.unref?.();
}

export function start() {
  log.info('poller basliyor', {
    intervalMs: config.pollIntervalMs,
    mode: config.fixtureMode ? `fixture:${config.fixtureVariant}` : 'live',
  });

  // Iki asamali acilis. Baz fan-out'u 101 istek ve 30-60 sn suruyor; once
  // yalnizca kotasyonlarla (3 istek, ~2 sn) yayina cikip siteyi doldur,
  // sonra gercek bazlarla arka planda rafine et.
  if (config.fixtureMode) {
    runOnce('boot');
  } else {
    runOnce('boot-fast', { fast: true }).then(() => runOnce('boot-refine'));
  }

  intervalTimer = setInterval(() => runOnce('interval'), config.pollIntervalMs);
  intervalTimer.unref?.();
  scheduleRollover();
}

export function stop() {
  if (intervalTimer) clearInterval(intervalTimer);
  if (rolloverTimer) clearTimeout(rolloverTimer);
  intervalTimer = null;
  rolloverTimer = null;
}
