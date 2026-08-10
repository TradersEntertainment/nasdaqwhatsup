/**
 * Giris noktasi. Railway sozlesmesi:
 *   PORT env'den, 0.0.0.0'a bind, healthcheck /api/health, duzgun SIGTERM.
 */

import http from 'node:http';
import { config } from './config.js';
import { log } from './lib/log.js';
import * as storage from './storage.js';
import * as poller from './poller.js';
import { serveStatic } from './http/static.js';
import { handleApi } from './http/routes-api.js';
import { handleStream } from './http/sse.js';

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.writeHead(400).end('Gecersiz istek');
    return;
  }

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('Yontem desteklenmiyor');
      return;
    }

    if (url.pathname === '/api/stream') {
      handleStream(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) res.writeHead(404, jsonHead()).end('{"error":"bulunamadi"}');
      return;
    }

    if (await serveStatic(req, res, url.pathname)) return;

    // SPA degil; bilinmeyen yol dogrudan 404.
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Sayfa bulunamadi');
  } catch (err) {
    log.error('istek hatasi', {
      path: url.pathname,
      ms: Date.now() - started,
      err: String(err?.stack ?? err),
    });
    if (!res.headersSent) res.writeHead(500, jsonHead());
    if (!res.writableEnded) res.end('{"error":"sunucu hatasi"}');
  }
});

const jsonHead = () => ({ 'Content-Type': 'application/json; charset=utf-8' });

// SSE baglantilari uzun omurlu; varsayilan timeout'lar onlari kesmesin.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

async function main() {
  await storage.init();
  await storage.prune();

  server.listen(config.port, config.host, () => {
    log.info('sunucu ayakta', {
      url: `http://${config.host}:${config.port}`,
      mode: config.fixtureMode ? `fixture:${config.fixtureVariant}` : 'live',
      dataDir: config.dataDir,
    });
  });

  poller.start();
}

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('kapaniyor', { sig });
    poller.stop();
    server.close(() => process.exit(0));
    // Acik SSE baglantilari kapanisi sonsuza kadar bekletmesin.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (err) => {
  log.error('yakalanmamis promise reddi', { err: String(err?.stack ?? err) });
});

main().catch((err) => {
  log.error('acilis basarisiz', { err: String(err?.stack ?? err) });
  process.exit(1);
});
