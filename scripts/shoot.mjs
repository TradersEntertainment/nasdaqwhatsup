#!/usr/bin/env node
/**
 * Her fixture durumunun ekran goruntusunu alir ve konsol hatalarini raporlar.
 *
 * Dogrulayici rengi kontrol eder, DUZENI kontrol etmez — cikti gozle
 * incelenmeden is bitmis sayilmaz.
 *
 * Kullanim:  node scripts/shoot.mjs [varyant...]
 */

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Playwright bu projenin bagimliligi DEGIL — ortamda global olarak kurulu
 * (1.56.1) ve /opt/pw-browsers'taki tarayici surumleriyle eslesiyor. Yerele
 * kurmak surum uyusmazligi yaratip tarayici indirmeye calisiyor, bu da
 * kapali agda basarisiz oluyor. O yuzden global kurulumdan cozuluyor.
 */
function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* yoksay */ }
  for (const root of candidates) {
    try {
      return require(join(root, 'playwright')).chromium;
    } catch { /* sonrakini dene */ }
  }
  try { return require('playwright').chromium; } catch { /* yoksay */ }
  throw new Error(
    'playwright bulunamadi. Bu ortamda global olarak kurulu olmali ' +
    '(npm ls -g playwright). Tarayici indirmeye CALISMAYIN — ag kapali.'
  );
}
const chromium = loadChromium();
const OUT = join(ROOT, 'screenshots');
const VARIANTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['regular', 'overnight', 'weekend', 'est', 'degraded', 'partial'];

const VIEWPORTS = [
  { name: 'masaustu', width: 1440, height: 1100 },
  { name: 'mobil', width: 390, height: 900 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* henuz ayaga kalkmadi */ }
    await sleep(250);
  }
  return false;
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
let failures = 0;

for (const variant of VARIANTS) {
  const port = 3200 + VARIANTS.indexOf(variant);
  const dataDir = join(ROOT, '.data', 'shoot', variant);

  // Gecmise dayali bilesenler (iraksama grafigi, liderlik tablosu) ancak
  // birikmis veriyle anlam kazaniyor; sahte gecmisi buraya seriyoruz.
  spawn(process.execPath, [
    'scripts/seed-history.js', '--variant', variant, '--days', '30', '--out', dataDir,
  ], { cwd: ROOT, stdio: 'ignore' });
  await sleep(1200);

  const srv = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      FIXTURE_MODE: '1',
      FIXTURE_VARIANT: variant,
      FIXTURE_PIN_CLOCK: '1',
      LOG_LEVEL: 'warn',
      // Ekran goruntuleri gercek diske yazmasin.
      RAILWAY_VOLUME_MOUNT_PATH: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write(`[${variant}] ${d}`));

  if (!(await waitForServer(port))) {
    console.error(`✗ ${variant}: sunucu ayaga kalkmadi`);
    srv.kill();
    failures++;
    continue;
  }

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    /** @type {string[]} */
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e.message)));

    // `networkidle` KULLANILMAZ: SSE akisi hic kapanmadigi icin asla tetiklenmez.
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    // Grafiklerin ilk boyamasi bitsin.
    await page.waitForSelector('#carriers svg, #carriers .empty', { timeout: 10_000 });
    await sleep(400);

    const file = join(OUT, `${variant}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: true });

    // Yatay tasma kontrolu — sayfa govdesi asla yatay kaymamali.
    // Sadece "tasma var" demek yetmez; HANGI eleman tasiyor onu da soyle.
    const { overflow, culprits } = await page.evaluate(() => {
      const doc = document.documentElement;
      const over = doc.scrollWidth - doc.clientWidth;
      const out = [];
      if (over > 1) {
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.right > doc.clientWidth + 1 && r.width > 0) {
            // Kendi kabinda kayan bilincli genis icerikleri (tablo) atla.
            const scroller = el.closest('[style*="overflow"], .table-scroll');
            if (scroller && scroller !== el) continue;
            out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
              `${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}` +
              ` (sag ${Math.round(r.right)}px)`);
          }
        }
      }
      return { overflow: over, culprits: out.slice(0, 6) };
    });

    const status = errors.length || overflow > 1 ? '✗' : '✓';
    if (errors.length || overflow > 1) failures++;
    console.log(`${status} ${variant}/${vp.name}  ${file.replace(ROOT + '/', '')}` +
      (overflow > 1 ? `  YATAY TASMA: ${overflow}px\n    tasiran: ${culprits.join(', ') || '?'}` : '') +
      (errors.length ? `\n    konsol: ${errors.slice(0, 4).join(' | ')}` : ''));

    await page.close();
  }

  srv.kill('SIGTERM');
  await sleep(200);
}

await browser.close();
console.log(failures ? `\n${failures} sorun bulundu.` : '\nTemiz.');
process.exit(failures ? 1 : 0);
