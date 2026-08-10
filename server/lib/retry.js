/** Ag dayanikliligi: zaman asimi, geri cekilme, eszamanlilik havuzu. */

import { log } from './log.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Zaman asimli fetch. AbortSignal.timeout Node 22'de yerlesik.
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number}} [init]
 */
export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = 10_000, headers, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: { ...DEFAULT_HEADERS, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
}

/**
 * 429/5xx/ag hatasinda ustel geri cekilme. Retry-After gozetilir.
 * 4xx (429 haric) tekrarlanmaz — kalici hata.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{tries?: number, label?: string}} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { tries = 3, label = 'istek' } = {}) {
  const delays = [500, 1500, 4000];
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err?.permanent) throw err;
      if (i === tries - 1) break;
      const jitter = 0.75 + ((i * 37) % 50) / 100;
      const wait = Math.round((err?.retryAfterMs ?? delays[i] ?? 4000) * jitter);
      log.debug('yeniden deneniyor', { label, deneme: i + 1, wait });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * HTTP durumunu hataya cevirir; kalici olanlari isaretler.
 * @param {Response} res
 * @param {string} url
 */
export function assertOk(res, url) {
  if (res.ok) return res;
  const err = new Error(`${res.status} ${res.statusText} — ${url}`);
  // @ts-ignore — tasiyici alanlar
  err.status = res.status;
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    // @ts-ignore
    if (Number.isFinite(ra)) err.retryAfterMs = ra * 1000;
  } else if (res.status >= 400 && res.status < 500) {
    // @ts-ignore
    err.permanent = true;
  }
  throw err;
}

/**
 * Eszamanlilik havuzu — N is aynı anda kosar, gerisi kuyrukta bekler.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {{spacingMs?: number}} [opts]
 * @returns {Promise<PromiseSettledResult<R>[]>}
 */
export async function pool(items, limit, worker, { spacingMs = 0 } = {}) {
  /** @type {PromiseSettledResult<R>[]} */
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      if (spacingMs) {
        // Jitter'li aralik: 100 istek ayni milisaniyede firlamasin.
        await new Promise((r) => setTimeout(r, spacingMs * (0.5 + ((i * 17) % 100) / 100)));
      }
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
