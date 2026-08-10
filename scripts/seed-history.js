#!/usr/bin/env node
/**
 * Sahte gecmis uretir: gun ici agrega serisi + gunluk ozetler.
 *
 * Neden gerekli: iraksama grafigi ve liderlik tablosu ancak birikmis veriyle
 * anlam kazaniyor. Canli veri bu container'dan cekilemedigi icin (piyasa
 * host'lari 403) o bilesenleri baska turlu gorup duzeltmek mumkun degil.
 *
 * Kullanim:
 *   node scripts/seed-history.js [--variant regular] [--days 30] [--out .data]
 */

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndexMetrics } from '../shared/metrics.js';
import { sessionStartUtc, phaseBoundaries, DAY_MS } from '../shared/session.js';
import { isTradingDay } from '../shared/holidays.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const variant = arg('variant', 'regular');
const days = Number(arg('days', 30));
const outRoot = arg('out', join(ROOT, '.data'));
const base = join(outRoot, 'v1');

const fx = JSON.parse(readFileSync(join(ROOT, 'data', 'fixtures', `${variant}.json`), 'utf8'));

// GECMIS gunler her zaman hareketli bir seanstan turetilir. Hedef varyant
// "weekend"/"holiday" gibi tum getirileri sifir olan bir durumsa, gecmisi de
// ondan turetmek "son kapanan seans %0,00" gibi anlamsiz bir gecmis uretirdi —
// oysa gecmisteki gunler gercek islem gunleriydi.
const shapeFx = fx.rows.some((r) => r.price !== r.baseline)
  ? fx
  : JSON.parse(readFileSync(join(ROOT, 'data', 'fixtures', 'regular.json'), 'utf8'));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

rmSync(base, { recursive: true, force: true });
for (const d of ['baseline', 'intraday', 'daily']) {
  mkdirSync(join(base, d), { recursive: true });
}

const endDay = fx.nowUtc;
let written = 0;

for (let back = days; back >= 0; back--) {
  const dayMs = endDay - back * DAY_MS;
  const start = sessionStartUtc(dayMs);
  const tsiDay = new Date(start + 3 * 3600_000 + 1000).toISOString().slice(0, 10);
  if (!isTradingDay(tsiDay)) continue;

  const rnd = mulberry32(Number(tsiDay.replaceAll('-', '')));
  const b = phaseBoundaries(tsiDay);
  const isToday = back === 0;

  // BUGUN fixture'in KENDISI olmali. Aksi halde gun ici seri fixture'in
  // rakamlarina yakinsamaz ve canli anlik goruntunun noktasi serinin
  // ortasina dusup grafikte sivri bir ucurum yaratir.
  // Gecmis gunler ise cesitlensin: bazi gunler genis yukselis, bazilari
  // birkac hissenin tasidigi dar yukselis.
  const skew = isToday ? 1 : 0.25 + rnd() * 1.55;
  const dayScale = isToday ? 1 : (rnd() - 0.42) * 2.2;

  const src = isToday ? fx.rows : shapeFx.rows;
  const finalRows = src.map((r) => {
    const r0 = r.price / r.baseline - 1;
    const shaped = r0 > 0 ? r0 * skew * dayScale : r0 * (2 - skew) * dayScale;
    return { ...r, price: r.baseline * (1 + shaped), lastTradeAtUtc: b.regClose - 1000 };
  });

  // Her hisseye KENDI ilerleme egrisi veriliyor. Hepsine ayni egriyi
  // uygulamak agirlikli ve esit agirlikli serileri ust uste bindiriyordu —
  // oysa grafigin tum amaci ikisinin AYRISMASI. Agir tasiyicilar daha gec
  // ramp ederse iraksama gun boyunca acilir; asil anlatilmak istenen bu.
  // Bugun icin ramp yok: seri fixture'in son degerine duzgunce yakinsasin.
  const rampOf = new Map();
  const byWeight = [...finalRows].sort((x, y) => (y.shares * y.baseline) - (x.shares * x.baseline));
  byWeight.forEach((r, idx) => {
    const heavy = idx < 10;
    rampOf.set(r.symbol, heavy ? 1.45 + rnd() * 0.9 : 0.6 + rnd() * 0.7);
  });

  // Gun ici: acilistan kapanisa 5 dakikalik adimlar, sona dogru yaklasan bir yol.
  const step = 5 * 60_000;
  const lines = [];
  // Bugun henuz bitmedi: seri "simdi"de durmali, gun sonuna kadar uzamamali.
  const endT = isToday
    ? Math.min(b.postClose, fx.nowUtc)
    : Math.min(b.postClose, start + DAY_MS - 1);
  for (let t = b.preOpen; t <= endT; t += step) {
    const prog = Math.max(0, Math.min(1, (t - b.preOpen) / (endT - b.preOpen)));
    const ease = prog * prog * (3 - 2 * prog);
    // Gurultu ENDEKS olceginde olmali. Onceki hali +-%3'tu ve grafigi
    // gun basinda cilgin bir titresime cevirip okunmaz yapiyordu.
    const noise = (rnd() - 0.5) * 0.0012;
    const rows = finalRows.map((r) => {
      const rf = r.price / r.baseline - 1;
      const e = Math.pow(ease, rampOf.get(r.symbol) ?? 1);
      return { ...r, price: r.baseline * (1 + rf * e + noise) };
    });
    const m = buildIndexMetrics({ rows, ndxBase: fx.ndxBase, sessionStartUtc: start });
    const i = m.index;
    const top3 = m.constituents
      .filter((c) => c.contribPp > 0)
      .sort((x, y) => y.contribPp - x.contribPp)
      .slice(0, 3)
      .map((c) => [c.s, +c.contribPp.toFixed(4)]);
    lines.push(JSON.stringify({
      t: new Date(t).toISOString(),
      idx: +i.changePct.toFixed(4),
      ew: +i.equalWeightPct.toFixed(4),
      med: +i.medianPct.toFixed(4),
      up: i.breadth.advancers, dn: i.breadth.decliners, nt: i.breadth.noTrade,
      upW: +i.upWeight.toFixed(4),
      top3,
    }));
  }
  writeFileSync(join(base, 'intraday', `${tsiDay}.jsonl`), lines.join('\n') + '\n');

  // Gun kapanisi ozeti.
  const m = buildIndexMetrics({ rows: finalRows, ndxBase: fx.ndxBase, sessionStartUtc: start });
  const i = m.index;
  writeFileSync(join(base, 'daily', `${tsiDay}.json`), JSON.stringify({
    tsiDay,
    closedAt: new Date(b.regClose).toISOString(),
    index: {
      changePct: i.changePct, changePts: i.changePts,
      equalWeightPct: i.equalWeightPct, medianPct: i.medianPct,
      divergencePp: i.divergencePp, upWeight: i.upWeight,
      top5UpShare: i.top5UpShare, breadth: i.breadth,
    },
    contributions: m.constituents
      .map((c) => ({ s: c.s, w: +c.w.toFixed(6), chg: +c.changePct.toFixed(4), pp: +c.contribPp.toFixed(5) }))
      .sort((x, y) => y.pp - x.pp),
  }));
  written++;
}

console.log(`${written} islem gunu yazildi -> ${base}`);
console.log('Not: bu SAHTE veridir, yalnizca gecmis bilesenlerini gelistirmek/');
console.log('ekran goruntusu almak icin. Uretimde kullanilmaz.');
