/**
 * Hiz siniri devre kesicisi — REGRESYON TESTI.
 *
 * Uretimde 429 alindi ve kod her sembol icin 3 kez yeniden denedi: tek poll
 * dongusunde 321 istek. 429 "bekle" demektir, "tekrar dene" degil. Bu test
 * amplifikasyonun geri gelmesini engelliyor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimitInfo, isRateLimited } from '../server/sources/yahoo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'server/sources/yahoo.js'), 'utf8');

test('baslangicta hiz siniri yok', () => {
  assert.equal(isRateLimited(), false);
  assert.deepEqual(rateLimitInfo(), { limited: false, remainingSec: 0, strikes: 0 });
});

test('spark ve chart cagrilari 429 icin YENIDEN DENEMIYOR', () => {
  // tries:1 olmadan bir 429, sembol basina uc istege cikar.
  const sparkCall = /label: `spark\[\$\{ci\}\]`/.exec(src);
  assert.ok(sparkCall, 'spark cagrisi bulunamadi');
  const sparkCtx = src.slice(Math.max(0, sparkCall.index - 200), sparkCall.index + 40);
  assert.match(sparkCtx, /tries:\s*1/, 'spark 429 icin yeniden denememeli');

  const chartCall = /label: `chart:\$\{symbol\}`/.exec(src);
  assert.ok(chartCall, 'chart cagrisi bulunamadi');
  const chartCtx = src.slice(Math.max(0, chartCall.index - 200), chartCall.index + 40);
  assert.match(chartCtx, /tries:\s*1/, 'chart 429 icin yeniden denememeli');
});

test('spark tek istekte tum sembolleri gonderiyor (parcalamiyor)', () => {
  // 102 sembol ~670 karakter; parcalamak istek sayisini bes katina cikariyordu.
  assert.match(src, /SPARK_URL_LIMIT\s*=\s*\d{4}/, 'URL uzunlugu esigi tanimli olmali');
  assert.doesNotMatch(src, /SPARK_BATCH/, 'sabit parca boyutu kaldirilmis olmali');
});

test('fan-out ilk 429 gorunce iptal ediliyor', () => {
  assert.match(src, /aborted = true/, 'chart fan-out iptal bayragi olmali');
  assert.match(src, /noteRateLimit\(\)/, 'devre kesici tetiklenmeli');
});

test('soguma usteli ve ust sinirli', () => {
  const m = /COOLDOWN_MIN = \[([\d,\s]+)\]/.exec(src);
  assert.ok(m, 'soguma merdiveni tanimli olmali');
  const steps = m[1].split(',').map((x) => Number(x.trim()));
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] > steps[i - 1], 'soguma monoton artmali');
  }
  assert.ok(steps.at(-1) <= 240, 'ust sinir makul olmali');
});
