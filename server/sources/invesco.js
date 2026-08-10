/**
 * Invesco QQQ holdings CSV — endeks uyeligi ve PAY ADETLERI.
 *
 * ⚠ Bu container'dan test edilemez (www.invesco.com 403). Yalnizca Railway'de.
 *
 * NEDEN "Shares/Par" sutunu, yayinlanan "Weight" sutunu DEGIL:
 * Invesco'nun agirliklari eski bir kapanisa gore hesaplanmis olur. Pay adetleri
 * ise yalnizca yeniden dengelemede degisir. Kendi baz fiyatlarimizla
 * `w = pay * baz / Σ` diye yeniden hesaplayinca, onlarin tazeleme gecikmesinden
 * BAGIMSIZ olarak dogru agirligi elde ediyoruz. Yayinlanan agirlik yalnizca
 * akil sagligi kontrolu icin kullaniliyor.
 */

import { fetchWithTimeout, withRetry, assertOk } from '../lib/retry.js';
import { log } from '../lib/log.js';

const URL_QQQ =
  'https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0' +
  '?audienceType=Investor&action=download&ticker=QQQ';

/**
 * Tirnakli alanlari destekleyen minimal CSV ayristirici.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

/**
 * @param {string} csv
 * @returns {{holdings: {s: string, n: string, shares: number, publishedWeight: number|null}[]}}
 */
export function parseHoldings(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('CSV bos veya basliksiz');

  const head = rows[0].map(norm);
  const find = (...names) => {
    for (const n of names) {
      const i = head.indexOf(norm(n));
      if (i > -1) return i;
    }
    return -1;
  };

  const iSym = find('Holding Ticker', 'HoldingTicker', 'Ticker', 'Security Identifier');
  const iName = find('Name', 'Security Name', 'Description');
  const iShares = find('Shares/Par', 'SharesPar', 'Shares', 'Quantity');
  const iWeight = find('Weight', 'PercentOfFund', '% of Fund', 'Weighting');

  if (iSym < 0 || iShares < 0) {
    throw new Error(`CSV sutunlari taninmadi: ${rows[0].join('|').slice(0, 200)}`);
  }

  const holdings = [];
  for (const r of rows.slice(1)) {
    const s = (r[iSym] ?? '').trim().toUpperCase();
    // Nakit/vadeli satirlarini ele: gecerli hisse sembolu deseni disindakiler.
    if (!/^[A-Z][A-Z0-9.\-]{0,5}$/.test(s)) continue;
    const shares = Number(String(r[iShares] ?? '').replace(/[,\s]/g, ''));
    if (!Number.isFinite(shares) || shares <= 0) continue;
    const w = Number(String(r[iWeight] ?? '').replace(/[,%\s]/g, ''));
    holdings.push({
      s,
      n: (r[iName] ?? s).trim(),
      shares,
      publishedWeight: Number.isFinite(w) ? w : null,
    });
  }

  if (holdings.length < 80) {
    throw new Error(`beklenenden az hisse ayristirildi: ${holdings.length}`);
  }
  return { holdings };
}

/** @returns {Promise<{holdings: any[], fetchedAt: string}>} */
export async function fetchHoldings() {
  const csv = await withRetry(async () => {
    const res = await fetchWithTimeout(URL_QQQ, {
      timeoutMs: 20_000,
      headers: { Accept: 'text/csv,application/csv,*/*' },
    });
    assertOk(res, URL_QQQ);
    return res.text();
  }, { label: 'invesco-qqq' });

  const { holdings } = parseHoldings(csv);
  log.info('QQQ holdings cekildi', { adet: holdings.length });
  return { holdings, fetchedAt: new Date().toISOString() };
}
