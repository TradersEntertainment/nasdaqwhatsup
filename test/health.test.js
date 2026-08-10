/**
 * Healthcheck semantigi — REGRESYON TESTI.
 *
 * Ilk Railway dagitimi tam olarak burada test edilen davranisin eksikliginden
 * dustu: `/api/health` "veri hazir mi" sorusunu cevapliyordu ve ilk anlik
 * goruntu 101 chart istegi beklerken 503 donuyordu. Railway'in penceresi 60
 * saniye oldugu icin replica hic saglikli olmadi.
 *
 * Kural: surec dinlemeye basladiginda saglikli sayilir. Veri hazirligi
 * govdedeki `ready` alaninda tasinir, HTTP durum kodunda degil.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sunucuyu ayaga kaldirir ve `/api/health`'e ilk cevap gelene kadar bekler.
 * @param {Record<string,string>} env
 * @param {number} port
 */
async function boot(env, port) {
  const srv = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: 'error',
      RAILWAY_VOLUME_MOUNT_PATH: join(ROOT, '.data', 'test', String(port)),
      ...env,
    },
    stdio: 'ignore',
  });

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      return { srv, res };
    } catch { /* henuz dinlemiyor */ }
    await sleep(100);
  }
  srv.kill();
  throw new Error('sunucu 8 saniyede ayaga kalkmadi');
}

test('veri HAZIR DEGILKEN bile /api/health 200 doner', async () => {
  // Canli mod + engelli ag = ilk anlik goruntu asla kurulmaz. Railway'in
  // gordugu senaryonun ta kendisi. Yine de 200 donmeli.
  const { srv, res } = await boot({ FIXTURE_MODE: '0', ALLOW_FIXTURE_FALLBACK: '0' }, 3921);
  try {
    assert.equal(res.status, 200, 'acilis sirasinda 503 donmemeli');
    const body = await res.json();
    assert.equal(body.ready, false, 'veri henuz yok');
    assert.equal(body.ok, true, 'surec saglikli');
    assert.equal(body.fatal, false);
    assert.ok(Number.isFinite(body.uptimeSec));
  } finally {
    srv.kill('SIGKILL');
  }
});

test('veri geldiginde ready true olur', async () => {
  const { srv } = await boot({ FIXTURE_MODE: '1', FIXTURE_VARIANT: 'regular' }, 3922);
  try {
    let body;
    for (let i = 0; i < 50; i++) {
      const res = await fetch('http://127.0.0.1:3922/api/health');
      assert.equal(res.status, 200, 'her zaman 200');
      body = await res.json();
      if (body.ready) break;
      await sleep(100);
    }
    assert.equal(body.ready, true);
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'REGULAR');
    assert.equal(body.source, 'fixture');
  } finally {
    srv.kill('SIGKILL');
  }
});

test('veri yokken /api/snapshot 503 doner (health\'ten AYRI)', async () => {
  // Snapshot ucu "veri yoksa 503" demekte hakli — istemci onu boyle anliyor.
  // Onemli olan healthcheck'in bu kodu PAYLASMAMASI.
  const { srv } = await boot({ FIXTURE_MODE: '0', ALLOW_FIXTURE_FALLBACK: '0' }, 3923);
  try {
    const res = await fetch('http://127.0.0.1:3923/api/snapshot');
    assert.equal(res.status, 503);
    const health = await fetch('http://127.0.0.1:3923/api/health');
    assert.equal(health.status, 200, 'health snapshot ile birlikte dusmemeli');
  } finally {
    srv.kill('SIGKILL');
  }
});
