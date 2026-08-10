/**
 * Fiyat bandi — "son N dakikada ne oldu" sorusunun hafizasi.
 *
 * Her poll'da tum sembollerin fiyati tek bir KARE olarak eklenir. Pencere
 * hesaplari (shared/windows.js) bu kareleri geriye dogru okur.
 *
 * Neden ayri bir katman: `intraday` serisi yalnizca AGREGA tutuyor (endeks %,
 * genislik, ilk 3) — bilesen bazli gun ici seri bilincli olarak saklanmiyordu
 * cunku 365 gun x 101 sembol faydasiz bir maliyet. Bant ise SADECE son ~5
 * saati tutar ve iki gunden eskisi budanir; boylece maliyet sabit kalir
 * (~2 MB/gun) ama pencere sorusu cevaplanabilir hale gelir.
 *
 * Dayaniklilik: bant diskteyse yeniden baslatma sonrasi geri yuklenir. Disk
 * yoksa bant yalnizca bellekte yasar — site calisir, pencereler surec
 * ayakta kaldigi surece dolar. Depolama katmaninin genel kurali burada da
 * gecerli: BURADAKI HICBIR HATA SUREYI DUSURMEZ.
 */

import * as storage from './storage.js';
import { paths } from './storage.js';
import { log } from './lib/log.js';
import { MAX_WINDOW_MS } from '../shared/windows.js';
import { tsiDate } from '../shared/session.js';

/** En uzun pencere + emniyet payi. */
const RETAIN_MS = MAX_WINDOW_MS + 45 * 60_000;

/**
 * Ust sinir: 60 sn'lik poll'da ~5 saat = 300 kare. 900, poll araligi 20 sn'ye
 * inse bile tasmayi engelleyen bir emniyet supabi (bellek kacagi olmasin).
 */
const MAX_FRAMES = 900;

/** @type {{t: number, p: Record<string, number>}[]} artan zaman sirasinda */
let frames = [];

/** @param {number} nowMs */
function trim(nowMs) {
  const cutoff = nowMs - RETAIN_MS;
  let i = 0;
  while (i < frames.length && frames[i].t < cutoff) i++;
  if (i > 0) frames = frames.slice(i);
  if (frames.length > MAX_FRAMES) frames = frames.slice(frames.length - MAX_FRAMES);
}

/**
 * Diskten geri yukle. Bugun VE dunku dosya okunur: TSI gunu 21:00 UTC'de
 * doner, 4 saatlik pencere bu siniri asar.
 * @param {number} [nowMs]
 */
export async function init(nowMs = Date.now()) {
  if (!storage.isAvailable()) return 0;
  const days = [tsiDate(nowMs - 86400_000), tsiDate(nowMs)];
  /** @type {any[]} */
  const all = [];
  for (const day of days) {
    try {
      for (const row of await storage.readJsonl(paths.tape(day))) {
        if (Number.isFinite(row?.t) && row?.p) all.push(row);
      }
    } catch { /* dosya yok — sorun degil */ }
  }
  all.sort((a, b) => a.t - b.t);
  frames = all;
  trim(nowMs);
  if (frames.length) {
    log.info('fiyat bandi geri yuklendi', {
      kare: frames.length,
      kapsamDk: Math.round((nowMs - frames[0].t) / 60000),
    });
  }
  return frames.length;
}

/**
 * Yeni kare ekle. Ayni ana denk gelen tekrar kare YAZILMAZ (aciliсtaki
 * hizli+rafine cift turu banda iki ayni kare koymasin).
 *
 * @param {{symbol: string, price: number}[]} rows
 * @param {number} nowMs
 * @param {string} tsiDay
 */
export async function push(rows, nowMs, tsiDay) {
  /** @type {Record<string, number>} */
  const p = {};
  for (const r of rows) {
    if (r?.symbol && r.price > 0) p[r.symbol] = +r.price.toFixed(4);
  }
  if (Object.keys(p).length === 0) return;

  const last = frames[frames.length - 1];
  // 5 sn'den yakin iki kare ayni andir; ikincisi oncekini GUNCELLER.
  if (last && nowMs - last.t < 5000) {
    frames[frames.length - 1] = { t: nowMs, p };
    return;
  }

  const frame = { t: nowMs, p };
  frames.push(frame);
  trim(nowMs);
  await storage.appendJsonl(paths.tape(tsiDay), frame);
}

/** @returns {{t: number, p: Record<string, number>}[]} */
export function getFrames() {
  return frames;
}

/** Teshis. */
export function info(nowMs = Date.now()) {
  return {
    frames: frames.length,
    oldestUtc: frames[0]?.t ?? null,
    newestUtc: frames[frames.length - 1]?.t ?? null,
    spanMin: frames.length ? Math.round((nowMs - frames[0].t) / 60000) : 0,
    persisted: storage.isAvailable(),
  };
}

/** Testler icin. */
export function _reset(next = []) {
  frames = next;
}
