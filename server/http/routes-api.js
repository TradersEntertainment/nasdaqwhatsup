import * as store from '../store.js';
import * as storage from '../storage.js';
import * as history from '../history.js';
import { config } from '../config.js';
import { sessionState } from '../../shared/session.js';

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string,string>} [headers]
 */
function json(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

/**
 * Fixture modunda saat sabitlenmis olabilir; seans hesaplari o ana gore
 * yapilmali, yoksa hafta sonu ekrani gercek saate kayar.
 */
function effectiveNow() {
  const snap = store.get();
  if (config.fixtureMode && config.fixturePinClock && snap) return snap.generatedAtMs;
  return Date.now();
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} eslesip cevaplandiysa true
 */
export async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    const h = store.health();
    const disk = await storage.stats();
    // Healthcheck "surec ayakta ve servis veriyor mu" sorusunu cevaplar,
    // "veri boru hattı ilk turunu bitirdi mi" sorusunu DEGIL. Ikisini
    // karistirmak ilk dagitimda replica'nin hic saglikli olmamasina yol acti:
    // ilk poll 101 chart istegi bekliyor, Railway'in penceresi 60 sn.
    // Gercek durum govdede `ready` alaninda tasiniyor.
    json(res, h.ok ? 200 : 503, {
      ...h,
      stale: h.ageSec != null && h.ageSec * 1000 > config.staleAfterMs,
      mode: config.fixtureMode ? `fixture:${config.fixtureVariant}` : 'live',
      volume: disk,
    });
    return true;
  }

  if (p === '/api/session') {
    json(res, 200, sessionState(effectiveNow()));
    return true;
  }

  if (p === '/api/snapshot') {
    const snap = store.get();
    if (!snap) {
      json(res, 503, { error: 'veri henuz hazir degil' });
      return true;
    }
    const etag = `"${snap.generatedAtMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag });
      res.end();
      return true;
    }
    json(res, 200, { ...snap, ageSec: store.ageSec() }, { ETag: etag });
    return true;
  }

  if (p === '/api/intraday') {
    const snap = store.get();
    const day = url.searchParams.get('day') || snap?.tsiDay;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      json(res, 400, { error: 'gecersiz gun' });
      return true;
    }
    const series = await history.getIntraday(day);
    // Disk yoksa ya da gun yeni basladiysa, grafik "veri yok" yerine en azindan
    // su anki noktayi gostersin.
    if (series.length === 0 && snap && snap.tsiDay === day) {
      series.push(history.intradayRow(snap));
    }
    json(res, 200, { day, series });
    return true;
  }

  if (p === '/api/history') {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    json(res, 200, await history.getHistory(days));
    return true;
  }

  return false;
}
