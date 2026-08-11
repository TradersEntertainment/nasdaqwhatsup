/**
 * Veri baglantisi: SSE ile anlik itme, kopunca 60 sn'lik poll'a dusme.
 */

const POLL_MS = 60_000;
const RECONNECT_MS = 5_000;

/**
 * @param {(snap: any) => void} onSnapshot
 * @param {(state: {connected: boolean, mode: 'sse'|'poll'}) => void} [onState]
 */
export function connect(onSnapshot, onState = () => {}, index = 'ndx') {
  const q = `?index=${encodeURIComponent(index)}`;
  /** @type {EventSource|null} */
  let es = null;
  /** @type {number|undefined} */
  let pollTimer;
  let closed = false;

  async function pollOnce() {
    try {
      const r = await fetch(`/api/snapshot${q}`, { cache: 'no-store' });
      if (r.ok) {
        onSnapshot(await r.json());
        onState({ connected: true, mode: 'poll' });
        return;
      }
      // Veri henuz yok (503). Sessizce "yukleniyor"da birakma — sunucunun
      // durumunu sor ve SEBEBINI goster.
      const h = await fetch('/api/health', { cache: 'no-store' })
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null);
      onState({ connected: false, mode: 'poll', health: h });
    } catch {
      onState({ connected: false, mode: 'poll' });
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function openStream() {
    if (closed) return;
    es = new EventSource(`/api/stream${q}`);

    es.addEventListener('snapshot', (ev) => {
      stopPolling();
      try {
        onSnapshot(JSON.parse(/** @type {MessageEvent} */ (ev).data));
        onState({ connected: true, mode: 'sse' });
      } catch { /* bozuk kare — bir sonrakini bekle */ }
    });

    es.addEventListener('error', () => {
      es?.close();
      es = null;
      onState({ connected: false, mode: 'poll' });
      // SSE yoksa site yine calissin.
      startPolling();
      if (!closed) setTimeout(openStream, RECONNECT_MS);
    });
  }

  openStream();
  // Ilk boyama SSE'nin ilk karesini beklemesin.
  pollOnce();

  return () => {
    closed = true;
    es?.close();
    stopPolling();
  };
}

/** @param {string} [day] */
export async function fetchIntraday(day) {
  const q = day ? `?day=${encodeURIComponent(day)}` : '';
  const r = await fetch(`/api/intraday${q}`, { cache: 'no-store' });
  if (!r.ok) return { day, series: [] };
  return r.json();
}

/** @param {number} days */
export async function fetchHistory(days = 30) {
  const r = await fetch(`/api/history?days=${days}`, { cache: 'no-store' });
  if (!r.ok) return { days: 0, summaries: [], leaderboard: [] };
  return r.json();
}
