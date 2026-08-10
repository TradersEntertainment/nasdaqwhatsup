/**
 * Statik dosya servisi — bagimliliksiz.
 *
 * Iki mount noktasi var:
 *   /          -> public/
 *   /shared/   -> shared/     (matematik ve seans mantigi TEK kaynak; hem Node
 *                              hem tarayici ayni dosyalari import eder, kopya yok)
 */

import { promises as fs } from 'node:fs';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../config.js';

const PUBLIC_DIR = resolve(join(ROOT, 'public'));
const SHARED_DIR = resolve(join(ROOT, 'shared'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Istek yolunu guvenli bir dosya yoluna cozer. Dizin disina cikma (../)
 * girisimlerinde null doner.
 * @param {string} urlPath
 * @returns {string|null}
 */
export function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';

  let dir = PUBLIC_DIR;
  if (p.startsWith('/shared/')) {
    dir = SHARED_DIR;
    p = p.slice('/shared'.length);
  }

  const full = resolve(join(dir, normalize(p)));
  // Prefix kontrolu: ayirici ile birlikte, "publicX" gibi kardes dizinleri de eler.
  if (full !== dir && !full.startsWith(dir + sep)) return null;
  return full;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} urlPath
 * @returns {Promise<boolean>} servis edildiyse true
 */
export async function serveStatic(req, res, urlPath) {
  const file = resolveFile(urlPath);
  if (!file) {
    res.writeHead(403).end('Yasak');
    return true;
  }

  let data;
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return false;
    data = await fs.readFile(file);
  } catch {
    return false;
  }

  const etag = '"' + createHash('sha1').update(data).digest('base64').slice(0, 20) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return true;
  }

  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': data.length,
    ETag: etag,
    // Kaynak dosyalar sik degisiyor; dogrulamali onbellek en dogrusu.
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}
