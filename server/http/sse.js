/**
 * Server-Sent Events — yeni anlik goruntu hazir olunca tarayiciya iter.
 * Istemci baglanti kurulamazsa 60 sn'lik poll'a duser (public/js/api.js).
 */

import * as store from '../store.js';
import { log } from '../lib/log.js';

const HEARTBEAT_MS = 25_000;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Railway/nginx gibi ara katmanlarin tamponlamasini kapat.
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Baglanir baglanmaz mevcut durumu gonder ki istemci bos beklemesin.
  const initial = store.get();
  if (initial) send('snapshot', { ...initial, ageSec: store.ageSec() });

  const unsubscribe = store.subscribe((snap) => {
    send('snapshot', { ...snap, ageSec: store.ageSec() });
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    log.debug('SSE baglantisi kapandi', { kalan: store.subscriberCount() });
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}
