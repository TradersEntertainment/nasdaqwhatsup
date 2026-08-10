#!/usr/bin/env node
/**
 * Teshis: canli veri yolunun her adimini tek tek dener ve rapor eder.
 *
 * Bu container'da HEPSININ basarisiz olmasi BEKLENIR (cikis politikasi piyasa
 * host'larini 403'le engelliyor). Railway'de ilk dagitimdan sonra calistirin;
 * orada hepsi gecmeli.
 *
 *   node scripts/doctor.js
 */

import { fetchWithTimeout } from '../server/lib/retry.js';
import { fetchQuotes, fetchBaseline, pickCurrent, resetSession } from '../server/sources/yahoo.js';
import { fetchHoldings } from '../server/sources/invesco.js';
import { sessionStartUtc, sessionState } from '../shared/session.js';

const HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
  'https://fc.yahoo.com',
  'https://www.invesco.com',
];

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failures = 0;

async function step(label, fn) {
  process.stdout.write(`  ${label.padEnd(38)}`);
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(ok(`${String(detail ?? '').slice(0, 90)} ${dim(`${Date.now() - t0}ms`)}`));
    return true;
  } catch (err) {
    failures++;
    console.log(bad(String(err?.message ?? err).slice(0, 110)));
    return false;
  }
}

const now = Date.now();
const st = sessionState(now);
console.log(`\nTSI ${st.tsiClock} · ${st.tsiDate} · faz: ${st.phase} (${st.label})`);
console.log(`ET ofseti: ${st.etOffsetHours}  ·  seans: ${new Date(st.sessionStartUtc).toISOString()} → ${new Date(st.sessionEndUtc).toISOString()}\n`);

console.log('Ag erisimi');
for (const h of HOSTS) {
  await step(new URL(h).host, async () => {
    const res = await fetchWithTimeout(h, { timeoutMs: 8000 });
    // 403/407 proxy'den geliyorsa host ENGELLI demektir; "cevap geldi" diye
    // basarili saymak yanilticidir — asil aradigimiz sey tam olarak budur.
    if (res.status === 403 || res.status === 407) {
      throw new Error(`HTTP ${res.status} — cikis politikasi engelliyor`);
    }
    return `HTTP ${res.status}`;
  });
}

console.log('\nVeri yolu');
resetSession();

const quotesOk = await step('Yahoo crumb + toplu kotasyon', async () => {
  const m = await fetchQuotes(['AAPL', 'MSFT', '^NDX']);
  if (m.size === 0) throw new Error('hicbir kotasyon donmedi');
  const a = m.get('AAPL');
  const cur = a ? pickCurrent(a, sessionStartUtc(now)) : null;
  return `${m.size} sembol · AAPL ${cur ? `${cur.price} (${cur.kind})` : 'seans ici baski yok'}`;
});

if (quotesOk) {
  await step('Yahoo chart baz (AAPL)', async () => {
    const b = await fetchBaseline('AAPL', sessionStartUtc(now));
    if (!b) throw new Error('baz bari bulunamadi');
    return `${b.baseline} @ ${new Date(b.at).toISOString()} (${b.source})`;
  });
}

await step('Invesco QQQ holdings', async () => {
  const { holdings } = await fetchHoldings();
  const top = holdings.slice(0, 3).map((h) => h.s).join(', ');
  return `${holdings.length} hisse · ilk: ${top}`;
});

console.log('');
if (failures === 0) {
  console.log(ok('Canli veri yolu saglikli.\n'));
} else {
  console.log(bad(`${failures} adim basarisiz.`));
  console.log(dim('  Bu GELISTIRME container\'inda bu beklenen sonuctur: kurumsal cikis'));
  console.log(dim('  politikasi tum piyasa veri host\'larini 403 ile engelliyor.'));
  console.log(dim('  Railway\'de calistirdiginizda hepsi gecmeli. Gecmiyorsa:'));
  console.log(dim('   · guce/consent yonlendirmesi -> servisi ABD bolgesine alin'));
  console.log(dim('   · 429 -> hiz siniri, poll araligini artirin\n'));
}
process.exit(failures ? 1 : 0);
