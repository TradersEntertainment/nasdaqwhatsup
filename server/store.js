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

/** @type {Set<(snap: any) => void>} */
const subscribers = new Set();

export function get() {
  return current;
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
    try { fn(snapshot); } catch (err) {
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
 * @param {(snap: any) => void} fn
 * @returns {() => void} aboneligi biten fonksiyon
 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount() {
  return subscribers.size;
}

export function health() {
  const age = ageSec();
  return {
    ok: current != null,
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
