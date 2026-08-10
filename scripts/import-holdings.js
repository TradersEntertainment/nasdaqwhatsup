#!/usr/bin/env node
/**
 * data/ndx-components.tsv -> data/holdings.seed.json
 *
 * Kaynak listede agirlik ve fiyat birlikte veriliyor; ortulu pay adedi
 * `shares = agirlik / fiyat` ile cikiyor. Calisma aninda agirlik yeniden
 * `w = shares * baz / Σ` diye hesaplandigi icin, fiyatlar anlik goruntudeki
 * degerden uzaklastikca agirliklar DOGRU YONDE kayiyor.
 *
 * Seed'de `refWeight`/`refPrice` ikilisi korunuyor (turetilmis `shares`
 * yerine): kaynak listeyle gozle karsilastirilabilsin diye. Turetme
 * server/pipeline/live.js icindeki loadSeed()'de yapiliyor.
 *
 * DOGRULAMA: ic tutarsizliklar sessizce gecmiyor. Ozellikle iki farkli
 * sembolun AYNI fiyat + ayni degisim + ayni yuzde tasimasi, kaynak listede
 * satirin kopyalandigini gosterir ve o satirin fiyati kullanilamaz — cunku
 * yanlis fiyat, ortulu pay adedini ve dolayisiyla agirligi katlarca sapitir.
 *
 * Kullanim:
 *   node scripts/import-holdings.js            # dogrula + yaz
 *   node scripts/import-holdings.js --check    # yalnizca dogrula
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data', 'ndx-components.tsv');
const OUT = join(ROOT, 'data', 'holdings.seed.json');
const checkOnly = process.argv.includes('--check');

/** Turkce sektor etiketleri. Kaynak listede sektor yok; elle esleniyor. */
const SECTORS = {
  NVDA: 'Yarı İletken', AVGO: 'Yarı İletken', AMD: 'Yarı İletken', ASML: 'Yarı İletken',
  INTC: 'Yarı İletken', AMAT: 'Yarı İletken', LRCX: 'Yarı İletken', MU: 'Yarı İletken',
  TXN: 'Yarı İletken', KLAC: 'Yarı İletken', MRVL: 'Yarı İletken', QCOM: 'Yarı İletken',
  ADI: 'Yarı İletken', NXPI: 'Yarı İletken', ARM: 'Yarı İletken', ALAB: 'Yarı İletken',
  MCHP: 'Yarı İletken', TER: 'Yarı İletken', MPWR: 'Yarı İletken', LITE: 'Yarı İletken',
  AAPL: 'Donanım', CSCO: 'Donanım', STX: 'Donanım', SNDK: 'Donanım', WDC: 'Donanım',
  MSFT: 'Yazılım', PLTR: 'Yazılım', ADBE: 'Yazılım', INTU: 'Yazılım', CDNS: 'Yazılım',
  SNPS: 'Yazılım', ADSK: 'Yazılım', WDAY: 'Yazılım', DDOG: 'Yazılım', APP: 'Yazılım',
  ADP: 'Yazılım', PAYX: 'Yazılım', ROP: 'Yazılım', MSTR: 'Yazılım',
  PANW: 'Siber Güvenlik', CRWD: 'Siber Güvenlik', FTNT: 'Siber Güvenlik',
  AMZN: 'E-Ticaret', MELI: 'E-Ticaret', SHOP: 'E-Ticaret', PDD: 'E-Ticaret',
  GOOGL: 'İnternet', GOOG: 'İnternet', META: 'İnternet', DASH: 'İnternet',
  NFLX: 'Medya', CMCSA: 'Medya', WBD: 'Medya',
  TSLA: 'Otomotiv', PCAR: 'Sanayi', HON: 'Sanayi', HONA: 'Havacılık',
  SPCX: 'Havacılık', RKLB: 'Havacılık', AXON: 'Sanayi', CTAS: 'Sanayi',
  FAST: 'Sanayi', CPRT: 'Sanayi',
  WMT: 'Perakende', COST: 'Perakende', ROST: 'Perakende', ORLY: 'Perakende',
  PEP: 'Gıda-İçecek', MDLZ: 'Gıda-İçecek', MNST: 'Gıda-İçecek', KDP: 'Gıda-İçecek',
  KHC: 'Gıda-İçecek', CCEP: 'Gıda-İçecek', SBUX: 'Restoran',
  AMGN: 'Biyoteknoloji', GILD: 'Biyoteknoloji', VRTX: 'Biyoteknoloji',
  REGN: 'Biyoteknoloji', ALNY: 'Biyoteknoloji',
  ISRG: 'Sağlık', IDXX: 'Sağlık', GEHC: 'Sağlık', DXCM: 'Sağlık',
  CEG: 'Enerji', AEP: 'Enerji', XEL: 'Enerji', EXC: 'Enerji', BKR: 'Enerji',
  FANG: 'Enerji',
  TMUS: 'Telekom', LIN: 'Kimya', CSX: 'Taşımacılık', ODFL: 'Taşımacılık',
  MAR: 'Seyahat', ABNB: 'Seyahat', BKNG: 'Seyahat',
  PYPL: 'Fintek', TTWO: 'Oyun', TRI: 'Veri-Analitik',
  CRWV: 'Bulut Altyapı', NBIS: 'Bulut Altyapı', FER: 'Altyapı',
};

/* ---------------- ayristirma ---------------- */

const rows = [];
for (const line of readFileSync(SRC, 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const f = line.split('\t');
  if (f.length < 7) continue;
  rows.push({
    rank: Number(f[0]),
    name: f[1].trim(),
    s: f[2].trim().toUpperCase(),
    weight: Number(f[3]),
    price: Number(f[4]),
    chg: Number(f[5]),
    chgPct: Number(f[6]),
  });
}

/* ---------------- dogrulama ---------------- */

const problems = [];
const warnings = [];

// 1) Toplam agirlik
const wSum = rows.reduce((a, r) => a + r.weight, 0);
if (Math.abs(wSum - 100) > 1.5) {
  problems.push(`Agirlik toplami %${wSum.toFixed(2)} — %100'den fazla sapiyor`);
} else if (Math.abs(wSum - 100) > 0.3) {
  warnings.push(`Agirlik toplami %${wSum.toFixed(2)} (yuvarlama kaynakli olabilir)`);
}

// 2) Tekrar eden semboller
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.s)) problems.push(`${r.s} listede birden fazla kez var`);
  seen.add(r.s);
}

// 3) Temel gecerlilik
for (const r of rows) {
  if (!/^[A-Z][A-Z0-9.\-]{0,5}$/.test(r.s)) problems.push(`${r.s}: gecersiz sembol`);
  if (!(r.weight > 0)) problems.push(`${r.s}: agirlik ${r.weight}`);
  if (!(r.price > 0)) problems.push(`${r.s}: fiyat ${r.price}`);
}

// 4) Degisim ic tutarliligi: chgPct, chg ve fiyattan yeniden hesaplanabilmeli.
for (const r of rows) {
  const prev = r.price - r.chg;
  if (prev <= 0) { warnings.push(`${r.s}: onceki fiyat <= 0`); continue; }
  const implied = (r.chg / prev) * 100;
  if (Math.abs(implied - r.chgPct) > 0.06) {
    warnings.push(`${r.s}: %${r.chgPct} yazili ama fiyat/degisimden %${implied.toFixed(2)} cikiyor`);
  }
}

// 5) KOPYALANMIS SATIR: iki farkli sembol ayni (fiyat, degisim, yuzde) ucluyu
//    tasiyamaz. Tasiyorsa kaynak listede satir kopyalanmistir ve o fiyat
//    kullanilamaz — ortulu pay adedini katlarca sapitir.
const byTriple = new Map();
for (const r of rows) {
  const key = `${r.price}|${r.chg}|${r.chgPct}`;
  if (!byTriple.has(key)) byTriple.set(key, []);
  byTriple.get(key).push(r);
}
const suspect = new Set();
for (const [key, group] of byTriple) {
  if (group.length < 2) continue;
  const syms = group.map((g) => g.s).join(', ');
  problems.push(
    `Kopyalanmis satir: ${syms} ayni fiyat+degisim+yuzde tasiyor (${key.replaceAll('|', ' / ')}). ` +
    `Bunlardan en az biri yanlis.`
  );
  // Siralamada daha ASAGIDA olani supheli say: kopyalama genelde asagi dogru olur.
  group.slice(1).forEach((g) => suspect.add(g.s));
}

/* ---------------- rapor ---------------- */

console.log(`Kaynak: ${rows.length} bilesen · agirlik toplami %${wSum.toFixed(2)}`);
for (const w of warnings) console.log(`  uyari: ${w}`);
for (const p of problems) console.log(`  SORUN: ${p}`);
if (suspect.size) {
  console.log(`\n  Supheli fiyat tasiyan semboller: ${[...suspect].join(', ')}`);
  console.log('  Bunlar seed\'e YAZILMIYOR — yanlis fiyat, agirligi katlarca sapitir.');
  console.log('  Calisma aninda Invesco/Yahoo listeden geri getirir.');
}

if (checkOnly) process.exit(problems.length ? 1 : 0);

/* ---------------- yaz ---------------- */

const kept = rows.filter((r) => !suspect.has(r.s));
const missingSector = kept.filter((r) => !SECTORS[r.s]).map((r) => r.s);

const seed = {
  source: 'user-supplied-components',
  asOf: '2026-08-10',
  note:
    'Kullanici tarafindan saglanan NASDAQ-100 agirlik/fiyat anlik goruntusundan ' +
    'uretildi (kaynak kayit: data/ndx-components.tsv). Ortulu pay adedi ' +
    'shares = refWeight / refPrice. Calisma aninda agirlik w = shares * baz / Σ ' +
    'olarak yeniden hesaplanir; fiyatlar refPrice\'tan uzaklastikca agirliklar ' +
    'dogru yonde kayar. Invesco QQQ holdings CSV\'sine erisilebildiginde ' +
    'tamamen degistirilir. Uretmek icin: node scripts/import-holdings.js',
  holdings: kept.map((r) => ({
    s: r.s,
    n: r.name,
    sector: SECTORS[r.s] ?? null,
    refWeight: r.weight,
    refPrice: r.price,
  })),
};

writeFileSync(OUT, JSON.stringify(seed, null, 1) + '\n');

console.log(`\n${kept.length} bilesen yazildi -> data/holdings.seed.json`);
if (missingSector.length) console.log(`Sektor etiketi eksik: ${missingSector.join(', ')}`);
if (problems.length) {
  console.log('\nSORUNLAR VAR — yukaridaki maddelere bakin.');
  process.exit(1);
}
