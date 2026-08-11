/**
 * Bellek ici durum. Tek yazar (poller), cok okuyucu (HTTP).
 *
 * Anlik goruntu ATOMIK takas edilir: yeni goruntu tamamen kurulup dogrulandiktan
 * sonra referans degistirilir. Okuyucular hicbir zaman yari kurulmus veri gormez.
 */

import { log } from './lib/log.js';

/** @type {any|null} */
let current = null;
let lastPollAt = 0;
let lastSuccessAt = 0;
let consecutiveFailures = 0;
/** @type {string[]} */
let lastErrors = [];

/**
 * Ikincil endeksler (spx, dji). Birincil (ndx) `current`'ta kalir: onun
 * saglik/hata muhasebesi Railway healthcheck'ini besliyor ve yan endekslerin
 * basarisizligi ana sinyali kirletmemeli.
 * @type {Map<string, any>}
 */
const others = new Map();

/** @type {Set<(snap: any) => void>} */
const subscribers = new Set();

export function get() {
  return current;
}

/**
 * @param {string} key
 * @returns {any|null}
 */
export function getIndex(key) {
  if (!key || key === 'ndx') return current;
  return others.get(key) ?? null;
}

/** Hangi endeksler su an servis edilebiliyor. */
export function availableIndices() {
  return ['ndx', ...[...others.keys()]].filter((k) => getIndex(k) != null);
}

/**
 * Ikincil endeks goruntusu. Aboneleri de tetikler ki SSE dinleyicileri
 * kendi endekslerini alsin.
 * @param {string} key
 * @param {any} snapshot
 */
export function setIndex(key, snapshot) {
  if (key === 'ndx') return set(snapshot);
  others.set(key, snapshot);
  for (const fn of subscribers) {
    try { fn(snapshot, key); } catch (err) {
      log.warn('abone bildirimi basarisiz', { err: String(err?.message ?? err) });
    }
  }
}

export function ageSec() {
  return lastSuccessAt ? Math.round((Date.now() - lastSuccessAt) / 1000) : null;
}

/** @param {any} snapshot */
export function set(snapshot) {
  current = snapshot;
  lastPollAt = Date.now();
  lastSuccessAt = lastPollAt;
  consecutiveFailures = 0;
  lastErrors = [];
  for (const fn of subscribers) {
    try { fn(snapshot, 'ndx'); } catch (err) {
      log.warn('abone bildirimi basarisiz', { err: String(err?.message ?? err) });
    }
  }
}

/** @param {string[]} errors */
export function recordFailure(errors) {
  lastPollAt = Date.now();
  consecutiveFailures++;
  lastErrors = errors;
  log.warn('poll basarisiz — onceki goruntu servis edilmeye devam ediyor', {
    consecutiveFailures, errors,
  });
}

/**
 * @param {(snap: any, indexKey: string) => void} fn
 * @returns {() => void} aboneligi biten fonksiyon
 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount() {
  return subscribers.size;
}

/** Surecin ayaga kalktigi an — "acilis payi" hesabi icin. */
const bootedAt = Date.now();

/**
 * Kurtarilamaz sayilma esikleri. Yalnizca bu ucu de saglayan durumda 503
 * dondurulur, cunku 503 Railway'e "bu replica'yi oldur" demektir ve yeniden
 * baslatmak Yahoo kesintisini COZMEZ — kotayi yakip durumu kotulestirir.
 */
const FATAL_AFTER_MS = 10 * 60_000;
const FATAL_AFTER_FAILURES = 5;

export function health() {
  const age = ageSec();
  const ready = current != null;
  const sinceBoot = Date.now() - bootedAt;

  // Süreç sağlığı ≠ veri hazırlığı. Ilk anlik goruntu 101 chart istegi
  // beklerken (30-60 sn) surec gayet saglikli; oyle isaretlenmezse Railway
  // healthcheck'i replica'yi hic ayaga kaldirmaz.
  const fatal =
    !ready &&
    sinceBoot > FATAL_AFTER_MS &&
    consecutiveFailures >= FATAL_AFTER_FAILURES;

  return {
    ok: !fatal,
    ready,
    fatal,
    uptimeSec: Math.round(sinceBoot / 1000),
    phase: current?.session?.phase ?? null,
    tsiDay: current?.tsiDay ?? null,
    source: current?.quality?.source ?? null,
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    ageSec: age,
    degraded: consecutiveFailures > 0,
    consecutiveFailures,
    lastErrors,
    subscribers: subscribers.size,
  };
}
