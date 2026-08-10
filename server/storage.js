/**
 * Kalici disk katmani (Railway volume).
 *
 * Tasarim kurali: BURADAKI HICBIR HATA SUREYI DUSURMEZ. Volume bir
 * hizlandirma; tek dayanak noktasi degil. Disk yoksa/bozuksa site calismaya
 * devam eder, sadece gecmis ve acilistaki baz onbellegi kaybolur.
 *
 * Yazmalar atomik: once `.tmp` dosyaya yazilir, sonra `rename` edilir. Boylece
 * yarim yazilmis JSON asla okunmaz (surec ortasinda yeniden baslasa bile).
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.js';
import { log } from './lib/log.js';

/** Sema surumu. Kirici degisiklikte v2 acilir, eski klasor olduguyla kalir. */
export const SCHEMA_VERSION = 'v1';

const base = () => join(config.dataDir, SCHEMA_VERSION);

let available = false;
let lastError = null;

export function isAvailable() {
  return available;
}
export function lastStorageError() {
  return lastError;
}

export async function init() {
  try {
    for (const d of ['baseline', 'intraday', 'daily']) {
      await fs.mkdir(join(base(), d), { recursive: true });
    }
    // Yazilabilirligi gercekten dene — mkdir basarili olup yazma reddedilebilir.
    const probe = join(base(), '.probe');
    await fs.writeFile(probe, String(Date.now()));
    await fs.unlink(probe);
    available = true;
    lastError = null;
    log.info('depolama hazir', { dir: base() });
  } catch (err) {
    available = false;
    lastError = String(err?.message ?? err);
    log.warn('depolama kullanilamiyor — gecmis ve baz onbellegi devre disi', {
      dir: base(), err: lastError,
    });
  }
  return available;
}

/**
 * @param {string} rel
 * @param {unknown} data
 */
export async function writeJson(rel, data) {
  if (!available) return false;
  const full = join(base(), rel);
  const tmp = `${full}.${process.pid}.tmp`;
  try {
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, full);
    return true;
  } catch (err) {
    log.warn('yazma basarisiz', { rel, err: String(err?.message ?? err) });
    await fs.unlink(tmp).catch(() => {});
    return false;
  }
}

/**
 * @param {string} rel
 * @returns {Promise<any|null>}
 */
export async function readJson(rel) {
  if (!available) return null;
  try {
    const raw = await fs.readFile(join(base(), rel), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // ENOENT normal; parse hatasi bozuk dosya demek — sil ki bir daha denenmesin.
    if (err?.code !== 'ENOENT') {
      log.warn('okuma/ayristirma basarisiz, dosya siliniyor', {
        rel, err: String(err?.message ?? err),
      });
      await fs.unlink(join(base(), rel)).catch(() => {});
    }
    return null;
  }
}

/**
 * Append-only satir. Gun ici agrega serisi icin.
 * @param {string} rel
 * @param {unknown} row
 */
export async function appendJsonl(rel, row) {
  if (!available) return false;
  const full = join(base(), rel);
  try {
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.appendFile(full, JSON.stringify(row) + '\n');
    return true;
  } catch (err) {
    log.warn('jsonl ekleme basarisiz', { rel, err: String(err?.message ?? err) });
    return false;
  }
}

/**
 * @param {string} rel
 * @returns {Promise<any[]>}
 */
export async function readJsonl(rel) {
  if (!available) return [];
  try {
    const raw = await fs.readFile(join(base(), rel), 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      // Bozuk tek satir tum dosyayi cope atmasin.
      try { out.push(JSON.parse(line)); } catch { /* satiri atla */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @param {'baseline'|'intraday'|'daily'} kind
 * @returns {Promise<string[]>} TSI gunleri, artan sirada
 */
export async function listDays(kind) {
  if (!available) return [];
  try {
    const files = await fs.readdir(join(base(), kind));
    return files
      .map((f) => f.replace(/\.(json|jsonl)$/, ''))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch {
    return [];
  }
}

/** Saklama suresini asan dosyalari siler. */
export async function prune() {
  if (!available) return;
  const cutoff = (days) =>
    new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const jobs = [
    { kind: 'intraday', ext: '.jsonl', before: cutoff(config.retainIntradayDays) },
    { kind: 'daily', ext: '.json', before: cutoff(config.retainDailyDays) },
    // Baz dosyalari sadece acilis onarimi icin lazim; kisa tutulur.
    { kind: 'baseline', ext: '.json', before: cutoff(7) },
  ];

  let removed = 0;
  for (const j of jobs) {
    for (const day of await listDays(/** @type {any} */ (j.kind))) {
      if (day >= j.before) continue;
      try {
        await fs.unlink(join(base(), j.kind, day + j.ext));
        removed++;
      } catch { /* zaten yok */ }
    }
  }
  if (removed) log.info('eski dosyalar budandi', { removed });
}

/** Healthcheck icin kaba disk kullanimi. */
export async function stats() {
  if (!available) return { ok: false, error: lastError, usedMB: null, days: 0 };
  let bytes = 0;
  let days = 0;
  try {
    for (const kind of ['baseline', 'intraday', 'daily']) {
      const dir = join(base(), kind);
      for (const f of await fs.readdir(dir)) {
        const st = await fs.stat(join(dir, f)).catch(() => null);
        if (st?.isFile()) bytes += st.size;
      }
    }
    days = (await listDays('daily')).length;
  } catch { /* kismi sonuc yeterli */ }
  return { ok: true, error: null, usedMB: +(bytes / 1048576).toFixed(2), days };
}

export const paths = {
  weights: () => 'weights.json',
  baseline: (day) => `baseline/${day}.json`,
  intraday: (day) => `intraday/${day}.jsonl`,
  daily: (day) => `daily/${day}.json`,
};
