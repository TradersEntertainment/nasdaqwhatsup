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
import { fetchFixture, fixtureTape, fixtureEarnings, fixtureIndexRows } from './sources/fixture.js';
import * as tape from './pricetape.js';
import { getEarnings } from './sources/earnings.js';
import { sessionEndUtc, sessionState } from '../shared/session.js';
import { fetchIndexRows } from './pipeline/index-rows.js';
import { INDEX_KEYS, DEFAULT_INDEX, indexDef } from '../shared/indices.js';

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

    // Bilanco takvimi: 12 sa onbellekli ve HATA FIRLATMAZ — rozet bir
    // suslemedir, fiyat akisini dusuremez.
    const earnings = config.fixtureMode
      ? fixtureEarnings(raw.rows, sessionState(raw.nowUtc).usDate)
      : await collectEarnings(raw);

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
      coverage: raw.coverage ?? null,
      // Kaynak kendi esigini soyleyebilir (kripto kismi-kapsam: 5).
      minConstituents: raw.minConstituents ?? (config.fixtureMode ? 50 : 85),
      // Fixture modunda bant anlik goruntuden TURETILIR: pencere panelinin
      // dolmasi icin dakikalarca beklenmesin (ekran goruntusu / gorsel denetim).
      tape: config.fixtureMode ? fixtureTape(raw.rows, raw.nowUtc) : tape.getFrames(),
      tapePersisted: storage.isAvailable(),
      earnings,
    });

    if (errors.length) {
      store.recordFailure(errors);
      return;
    }

    // TSI gunu degistiyse onceki gunu kapat (gecmise yaz). Kismi-kapsam
    // gunleri YAZILMAZ: 12 hisselik bir gunun "genisligi" liderlik tablosunu
    // ve iraksama gecmisini zehirler.
    const prev = store.get();
    if (prev && prev.tsiDay !== snapshot.tsiDay) {
      if (!prev.coverage?.partial) await history.closeDay(prev);
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
    if (!snapshot.coverage?.partial) await history.recordIntraday(snapshot);

    // Ikincil endeksler (S&P 500, Dow 30). Her biri BAGIMSIZ: biri duserse
    // digerleri ve ana endeks etkilenmez. Hatalari `recordFailure`'a da
    // yazilmaz — o sayac Railway healthcheck'ini besliyor ve yan endeksin
    // sorunu ana replica'yi oldurmemeli.
    const yanRows = await runSecondary(raw, snapshot);

    // Fiyat bandi TUM endekslerin sembollerini kapsar; sembol bazli oldugu
    // icin tek bant ucune de hizmet eder (AAPL her ucunde ayni).
    await tape.push(
      dedupeBySymbol([raw.rows, ...yanRows]),
      snapshot.generatedAtMs, snapshot.tsiDay, raw.observedAt,
    );

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
 * Ikincil endeksleri kurar ve store'a yazar. HICBIR hata yukari tasinmaz:
 * S&P/Dow bir turda gelmezse site ana endeksle calismaya devam eder.
 *
 * @param {any} raw ana endeksin ham verisi (bant ve saat referansi icin)
 * @param {any} primary ana anlik goruntu (bilanco/bant paylasimi icin)
 * @returns {Promise<any[][]>} her endeksin satirlari (bant birlesimi icin)
 */
async function runSecondary(raw, primary) {
  const out = [];
  for (const key of INDEX_KEYS) {
    if (key === DEFAULT_INDEX) continue;
    try {
      const r = config.fixtureMode
        ? {
          ...raw,
          rows: fixtureIndexRows(raw.rows, /** @type {any} */ (key)),
          // Seviye yalnizca NDX icin biliniyor; yan endekslerde puan kapali.
          ndxBase: 0,
          officialRegularPct: null,
          minConstituents: key === 'dji' ? 25 : 50,
          quality: { ...raw.quality, weightsSource: 'fixture' },
        }
        : await fetchIndexRows(key, raw.nowUtc);
      if (!r) continue;

      const { snapshot, errors } = buildSnapshot({
        ...r,
        quality: { ...r.quality, clockPinned: false },
        tape: config.fixtureMode
          ? fixtureTape(r.rows, raw.nowUtc)
          : tape.getFrames(),
        tapePersisted: storage.isAvailable(),
        // Bilanco takvimi ana endeksle ayni cagridan geliyor; sembol bazli
        // oldugu icin yan endekslerde de dogru calisir.
        earnings: primary.constituents.reduce((acc, c) => {
          if (c.earn) acc[c.s] = c.earn;
          return acc;
        }, /** @type {Record<string, any>} */ ({})),
      });

      if (errors.length) {
        log.warn('ikincil endeks degismez kontrolunden gecemedi', { endeks: key, errors });
        continue;
      }
      snapshot.indexKey = key;
      snapshot.indexLabel = indexDef(key).label;
      snapshot.indexNote = indexDef(key).note;
      store.setIndex(key, snapshot);
      out.push(r.rows);
    } catch (err) {
      log.warn('ikincil endeks atlandi', { endeks: key, err: String(err?.message ?? err).slice(0, 120) });
    }
  }
  return out;
}

/** Bant icin sembol bazli birlesim — ayni sembol birden fazla endekste olabilir. */
function dedupeBySymbol(lists) {
  /** @type {Map<string, any>} */
  const m = new Map();
  for (const list of lists) {
    for (const r of list ?? []) if (r?.symbol && !m.has(r.symbol)) m.set(r.symbol, r);
  }
  return [...m.values()];
}

/**
 * Bilanco takvimini getirip "kalan gun" gosterimine cevirir. Her hata
 * yutulur: takvim yoksa rozet cikmaz, baska hicbir sey degismez.
 * @param {any} raw
 */
async function collectEarnings(raw) {
  try {
    const symbols = raw.rows.map((r) => r.symbol);
    if (symbols.length === 0) return {};
    const todayEt = sessionState(raw.nowUtc).usDate;
    const { map } = await getEarnings(symbols, todayEt);
    const { describe } = await import('./sources/earnings.js');
    /** @type {Record<string, any>} */
    const out = {};
    for (const s of symbols) {
      const d = map[s] && describe(map[s], todayEt);
      if (d) out[s] = d;
    }
    return out;
  } catch (err) {
    log.debug('bilanco takvimi atlandi', { err: String(err?.message ?? err) });
    return {};
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

export async function start() {
  // Fiyat bandini diskten geri yukle: yeniden baslatma pencereleri
  // sifirlamasin (4 saatlik pencere yeniden dolmasi 4 saat surerdi).
  await tape.init().catch(() => 0);

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
