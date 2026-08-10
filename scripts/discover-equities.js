#!/usr/bin/env node
/**
 * Hyperliquid ve Binance'te NASDAQ-100 sembolleriyle eslesen piyasa var mi?
 *
 * Tahmin etmemek icin: hangi hissenin nerede oldugunu ve hacmini VERI soylesin.
 * Bu container'dan calismaz (cikis politikasi engelliyor) — Railway'de
 * calistirin ya da dagitimdan sonra /api/discover ucunu tarayicidan acin.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverEquityMarkets } from '../server/sources/crypto.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'holdings.seed.json'), 'utf8'));
const symbols = seed.holdings.map((h) => h.s);

const r = await discoverEquityMarkets(symbols);

console.log(`\nNASDAQ-100 sembolu: ${r.ndxSymbolCount}\n`);
for (const [venue, v] of Object.entries(r.venues)) {
  if (!v.ok) {
    console.log(`${venue.padEnd(13)} HATA: ${v.error}`);
    continue;
  }
  console.log(
    `${venue.padEnd(13)} ${v.matched}/${r.ndxSymbolCount} eslesme ` +
    `(%${v.coveragePct} kapsam) · toplam piyasa ${v.totalMarkets} · ` +
    `24s hacim $${v.totalVolumeUsd.toLocaleString('en-US')}`
  );
  for (const s of v.symbols.slice(0, 15)) {
    console.log(`  ${s.s.padEnd(6)} ${String(s.price).padStart(10)} ` +
      `hacim $${s.volume.toLocaleString('en-US')}`);
  }
  if (v.symbols.length > 15) console.log(`  ... +${v.symbols.length - 15} sembol daha`);
  console.log('');
}
console.log(r.verdict);
console.log(r.recommended ? `\nOnerilen borsa: ${r.recommended}\n` : '');
