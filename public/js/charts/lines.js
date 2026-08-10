/**
 * Gun ici iraksama grafigi: piyasa degeri agirlikli endeks vs esit agirlikli.
 *
 * Aradaki dolgulu alan hikayenin kendisi — "sabah beraberdiler, ogleden sonra
 * birkac hisse endeksi tek basina yukari cekti".
 *
 * IKI SERI DE AYNI EKSENDE (yuzde). Cift eksen yok — iki farkli olcegi tek
 * grafige koymak olmayan bir korelasyon uydurur.
 */

import { bindTip, hideTip, showTip } from './tooltip.js';
import { pct, tsiTime } from '../format.js';
import { phaseBoundaries } from '/shared/session.js';

const SVG = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => {
  const e = document.createElementNS(SVG, n);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const CAP = 'var(--series-cap)';
const EQ = 'var(--series-eq)';

/**
 * @param {HTMLElement} host
 * @param {{t: string, idx: number, ew: number}[]} series
 * @param {any} session snapshot.session
 */
export function renderDivergence(host, series, session) {
  host.replaceChildren();

  const pts = series
    .map((r) => ({ t: Date.parse(r.t), idx: r.idx, ew: r.ew }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  if (pts.length === 0) {
    host.innerHTML = '<p class="empty">Bu seans için henüz kayıtlı seri yok.</p>';
    return;
  }

  const W = Math.max(320, host.clientWidth);
  const narrow = W < 520;
  const H = narrow ? 220 : 260;
  const padL = 44, padR = 64, padT = 14, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // X ekseni TSI gununun tamami — seansin neresinde oldugumuz gorunsun.
  const t0 = session.sessionStartUtc;
  const t1 = session.sessionEndUtc;
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;

  const vals = pts.flatMap((p) => [p.idx, p.ew]).concat([0]);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max(0.08, (hi - lo) * 0.18);
  lo -= pad; hi += pad;
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

  const svg = el('svg', {
    class: 'chart', width: '100%', height: H,
    viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': 'Gün içi ıraksama: ağırlıklı endeks ve eşit ağırlıklı endeks.',
  });

  // --- Krom: kesiksiz sac teli izgara ---
  const ticks = niceTicks(lo, hi, 4);
  for (const v of ticks) {
    svg.appendChild(el('line', {
      x1: padL, x2: W - padR, y1: y(v), y2: y(v),
      stroke: v === 0 ? 'var(--baseline)' : 'var(--grid)', 'stroke-width': 1,
    }));
    const lbl = el('text', {
      x: padL - 7, y: y(v) + 3.5, 'font-size': 10,
      fill: 'var(--ink-muted)', 'text-anchor': 'end',
      'font-variant-numeric': 'tabular-nums',
    });
    lbl.textContent = pct(v);
    svg.appendChild(lbl);
  }

  // Seans fazi sinirlari — acilis boslugunun nerede olustugu gorunsun.
  if (session.isTradingDay) {
    const b = phaseBoundaries(session.usDate);
    for (const [ms, label] of [[b.regOpen, 'açılış'], [b.regClose, 'kapanış']]) {
      if (ms <= t0 || ms >= t1) continue;
      svg.appendChild(el('line', {
        x1: x(ms), x2: x(ms), y1: padT, y2: padT + plotH,
        stroke: 'var(--grid)', 'stroke-width': 1,
      }));
      const t = el('text', {
        x: x(ms) + 4, y: padT + 10, 'font-size': 9.5, fill: 'var(--ink-muted)',
      });
      t.textContent = label;
      svg.appendChild(t);
    }
  }

  // Zaman ekseni: TSI saatleri. Kap yuksekligi (padB) bu bandi ICERIYOR.
  for (let h = 0; h <= 24; h += narrow ? 8 : 4) {
    const ms = t0 + h * 3600_000;
    if (ms > t1) break;
    const lab = el('text', {
      x: x(ms), y: H - 8, 'font-size': 10, fill: 'var(--ink-muted)',
      'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle',
      'font-variant-numeric': 'tabular-nums',
    });
    lab.textContent = String(h % 24).padStart(2, '0') + ':00';
    svg.appendChild(lab);
  }

  // --- Iki seri arasindaki alan: iraksamanin kendisi ---
  if (pts.length > 1) {
    const top = pts.map((p) => `${x(p.t)},${y(p.idx)}`).join(' ');
    const bottom = [...pts].reverse().map((p) => `${x(p.t)},${y(p.ew)}`).join(' ');
    svg.appendChild(el('polygon', {
      points: `${top} ${bottom}`,
      fill: 'rgba(111,163,24,0.16)',
    }));
  }

  const line = (key, color) => {
    if (pts.length === 1) {
      svg.appendChild(el('circle', {
        cx: x(pts[0].t), cy: y(pts[0][key]), r: 4.5, fill: color,
      }));
      return;
    }
    svg.appendChild(el('polyline', {
      points: pts.map((p) => `${x(p.t)},${y(p[key])}`).join(' '),
      fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  };
  line('ew', EQ);
  line('idx', CAP);

  // Uc nokta dogrudan etiketli — her noktaya sayi yazmak yerine secici etiket.
  const last = pts.at(-1);
  const endLabel = (v, color, dy) => {
    const t = el('text', {
      x: W - padR + 8, y: y(v) + dy, 'font-size': 11, 'font-weight': 650,
      fill: color, 'font-variant-numeric': 'tabular-nums',
    });
    t.textContent = pct(v);
    return t;
  };
  // Ust uste binmesinler.
  const gap = Math.abs(y(last.idx) - y(last.ew)) < 13;
  svg.appendChild(endLabel(last.idx, CAP, gap && last.idx < last.ew ? 10 : 3.5));
  svg.appendChild(endLabel(last.ew, EQ, gap && last.ew <= last.idx ? 10 : 3.5));

  // --- Nisangah + ipucu ---
  const cross = el('line', {
    x1: 0, x2: 0, y1: padT, y2: padT + plotH,
    stroke: 'var(--border-strong)', 'stroke-width': 1, opacity: 0,
  });
  svg.appendChild(cross);
  const dotA = el('circle', { r: 4, fill: CAP, opacity: 0 });
  const dotB = el('circle', { r: 4, fill: EQ, opacity: 0 });
  svg.appendChild(dotA);
  svg.appendChild(dotB);

  const hit = el('rect', {
    x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent',
  });
  svg.appendChild(hit);

  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    let best = pts[0], bd = Infinity;
    for (const p of pts) {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };

  const move = (ev) => {
    const c = ev.touches?.[0] ?? ev;
    const p = nearest(c.clientX);
    cross.setAttribute('x1', String(x(p.t)));
    cross.setAttribute('x2', String(x(p.t)));
    cross.setAttribute('opacity', '1');
    dotA.setAttribute('cx', String(x(p.t)));
    dotA.setAttribute('cy', String(y(p.idx)));
    dotA.setAttribute('opacity', '1');
    dotB.setAttribute('cx', String(x(p.t)));
    dotB.setAttribute('cy', String(y(p.ew)));
    dotB.setAttribute('opacity', '1');
    showTip(c.clientX, c.clientY, `
      <div class="t-sym">TSI ${tsiTime(p.t)}</div>
      <div class="t-row">Ağırlıklı endeks <b>${pct(p.idx)}</b></div>
      <div class="t-row">Eşit ağırlıklı <b>${pct(p.ew)}</b></div>
      <div class="t-row">Fark <b>${pct(p.idx - p.ew)}</b></div>
    `);
  };

  hit.addEventListener('mousemove', move);
  hit.addEventListener('touchmove', move, { passive: true });
  hit.addEventListener('mouseleave', () => {
    hideTip();
    for (const n of [cross, dotA, dotB]) n.setAttribute('opacity', '0');
  });

  host.appendChild(svg);
}

/** Okunakli eksen degerleri. */
function niceTicks(lo, hi, target) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    out.push(+v.toFixed(6));
  }
  if (lo <= 0 && hi >= 0 && !out.some((v) => Math.abs(v) < 1e-9)) out.push(0);
  return out;
}
