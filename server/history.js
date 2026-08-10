/**
 * Gecmis: gun ici agrega serisi, gunluk ozetler ve "en cok tasiyanlar" tablosu.
 *
 * Boyut butcesi: agrega satiri ~200 bayt, 5 dakikada bir => gunde ~60 KB.
 * Gunluk tam ozet ~15 KB. Yilda ~30 MB. Bilesen bazli gun ici seri (100 kat
 * daha buyuk) BILINCLI olarak saklanmiyor — faydasi maliyetini karsilamiyor.
 */

import * as storage from './storage.js';
import { paths } from './storage.js';
import { log } from './lib/log.js';

/**
 * Anlik goruntuden tek satirlik agrega cikarir.
 * @param {any} snap
 */
export function intradayRow(snap) {
  const i = snap.index;
  const top3 = snap.constituents
    .filter((c) => c.contribPp > 0)
    .sort((a, b) => b.contribPp - a.contribPp)
    .slice(0, 3)
    .map((c) => [c.s, +c.contribPp.toFixed(4)]);

  return {
    t: snap.generatedAt,
    idx: +i.changePct.toFixed(4),
    ew: +i.equalWeightPct.toFixed(4),
    med: +i.medianPct.toFixed(4),
    up: i.breadth.advancers,
    dn: i.breadth.decliners,
    nt: i.breadth.noTrade,
    upW: +i.upWeight.toFixed(4),
    top3,
  };
}

/**
 * @param {any} snap
 */
export async function recordIntraday(snap) {
  if (!storage.isAvailable()) return;
  await storage.appendJsonl(paths.intraday(snap.tsiDay), intradayRow(snap));
}

/**
 * Gunu kapat: o TSI gununun son hali gunluk ozet olarak yazilir.
 * Idempotent — ayni gun icin tekrar cagrilirsa uzerine yazar.
 * @param {any} snap
 */
export async function closeDay(snap) {
  if (!storage.isAvailable()) return;
  const i = snap.index;
  const summary = {
    tsiDay: snap.tsiDay,
    closedAt: snap.generatedAt,
    index: {
      changePct: i.changePct,
      changePts: i.changePts,
      equalWeightPct: i.equalWeightPct,
      medianPct: i.medianPct,
      divergencePp: i.divergencePp,
      upWeight: i.upWeight,
      top5UpShare: i.top5UpShare,
      breadth: i.breadth,
    },
    // Tam bilesen listesi degil, sadece katki siralamasi — boyut icin.
    contributions: snap.constituents
      .map((c) => ({ s: c.s, w: +c.w.toFixed(6), chg: +c.changePct.toFixed(4), pp: +c.contribPp.toFixed(5) }))
      .sort((a, b) => b.pp - a.pp),
  };
  const ok = await storage.writeJson(paths.daily(snap.tsiDay), summary);
  if (ok) log.info('gun kapatildi', { day: snap.tsiDay, idx: i.changePct });
}

/**
 * @param {string} day
 */
export async function getIntraday(day) {
  return storage.readJsonl(paths.intraday(day));
}

/**
 * Verilen gunden ONCEKI en son kapanmis seans.
 *
 * Hafta sonu / tatil icin: kullanici siteye Pazar gunu girdiginde sifir duvari
 * degil, "Cuma'yi kim tasidi" cevabini gormeli.
 *
 * @param {string} beforeDay TSI gunu (YYYY-MM-DD)
 */
export async function getLastClosedSession(beforeDay) {
  const days = (await storage.listDays('daily')).filter((d) => d < beforeDay);
  for (const day of days.reverse()) {
    const d = await storage.readJson(paths.daily(day));
    if (!d?.index) continue;
    return {
      tsiDay: d.tsiDay,
      changePct: d.index.changePct,
      equalWeightPct: d.index.equalWeightPct,
      divergencePp: d.index.divergencePp,
      breadth: d.index.breadth,
      top3: (d.contributions ?? []).slice(0, 3),
    };
  }
  return null;
}

/**
 * Son N gunun ozeti + tasiyici liderlik tablosu.
 * @param {number} days
 */
export async function getHistory(days = 30) {
  const all = await storage.listDays('daily');
  const picked = all.slice(-days);

  const summaries = [];
  /** @type {Map<string, {s: string, top3: number, top1: number, cumPp: number, days: number}>} */
  const board = new Map();

  for (const day of picked) {
    const d = await storage.readJson(paths.daily(day));
    if (!d) continue;
    summaries.push({
      tsiDay: d.tsiDay,
      changePct: d.index.changePct,
      equalWeightPct: d.index.equalWeightPct,
      divergencePp: d.index.divergencePp,
      breadth: d.index.breadth,
      top3: (d.contributions ?? []).slice(0, 3).map((c) => c.s),
    });

    const contribs = d.contributions ?? [];
    contribs.forEach((c, rank) => {
      const e = board.get(c.s) ?? { s: c.s, top3: 0, top1: 0, cumPp: 0, days: 0 };
      e.cumPp += c.pp;
      e.days++;
      if (rank === 0) e.top1++;
      if (rank < 3) e.top3++;
      board.set(c.s, e);
    });
  }

  const leaderboard = [...board.values()]
    .sort((a, b) => b.cumPp - a.cumPp)
    .slice(0, 20);

  return { days: summaries.length, summaries, leaderboard };
}
