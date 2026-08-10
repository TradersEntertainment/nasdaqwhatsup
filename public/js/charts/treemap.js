/**
 * Agirlik haritasi: kutu ALANI = endeks agirligi, DOLGUSU = getiri.
 *
 * Devasa yesil NVDA kutusu ve etrafindaki kucuk kirmizi kutular denizi —
 * carpikligi tek bakista gosteren gorsel.
 *
 * Dolgu surekli bir iraksayan olcek (kutupsallik), o yuzden olcek gostergesi
 * sart; tam degerler ayrica tabloda.
 */

import { divergingColor } from './scale.js';
import { bindTip } from './tooltip.js';
import { pct, pp, pctPlain } from '../format.js';

const SVG = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => {
  const e = document.createElementNS(SVG, n);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/**
 * Squarified treemap (Bruls, Huizing, van Wijk). En-boy oranini 1'e yakin
 * tutar; slice-and-dice'in urettigi ince seritleri onler.
 * @param {{value: number}[]} data
 */
function squarify(data, x, y, w, h) {
  const out = [];
  const items = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((s, d) => s + d.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;

  const scale = (w * h) / total;
  const queue = items.map((d) => ({ ...d, area: d.value * scale }));

  let rect = { x, y, w, h };
  let row = [];

  const shortest = () => Math.min(rect.w, rect.h);

  const worst = (r, len) => {
    let sum = 0, max = -Infinity, min = Infinity;
    for (const d of r) {
      sum += d.area;
      if (d.area > max) max = d.area;
      if (d.area < min) min = d.area;
    }
    const l2 = len * len;
    const s2 = sum * sum;
    if (s2 === 0 || min === 0) return Infinity;
    return Math.max((l2 * max) / s2, s2 / (l2 * min));
  };

  const layoutRow = (r) => {
    const sum = r.reduce((s, d) => s + d.area, 0);
    if (sum <= 0) return;
    const horizontal = rect.w >= rect.h;
    if (horizontal) {
      const rw = sum / rect.h;
      let yy = rect.y;
      for (const d of r) {
        const hh = d.area / rw;
        out.push({ ...d, x: rect.x, y: yy, w: rw, h: hh });
        yy += hh;
      }
      rect = { x: rect.x + rw, y: rect.y, w: rect.w - rw, h: rect.h };
    } else {
      const rh = sum / rect.w;
      let xx = rect.x;
      for (const d of r) {
        const ww = d.area / rh;
        out.push({ ...d, x: xx, y: rect.y, w: ww, h: rh });
        xx += ww;
      }
      rect = { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh };
    }
  };

  for (const item of queue) {
    if (row.length === 0) { row.push(item); continue; }
    const len = shortest();
    if (worst([...row, item], len) <= worst(row, len)) row.push(item);
    else { layoutRow(row); row = [item]; }
  }
  if (row.length) layoutRow(row);
  return out;
}

/**
 * @param {HTMLElement} host
 * @param {any[]} constituents
 */
export function renderTreemap(host, constituents) {
  host.replaceChildren();

  const W = Math.max(320, host.clientWidth);
  const H = Math.round(Math.min(560, Math.max(320, W * 0.44)));
  const GAP = 2; // dolgular arasi zemin bosluğu — cerceve cizmek yerine

  const cells = squarify(
    constituents.map((c) => ({ ...c, value: c.w })),
    0, 0, W, H
  );

  if (cells.length === 0) {
    host.innerHTML = '<p class="empty">Ağırlık verisi yok.</p>';
    return;
  }

  const svg = el('svg', {
    class: 'chart', width: '100%', height: H,
    viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label':
      `Ağırlık haritası: ${cells.length} hisse, kutu alanı endeks ağırlığını, ` +
      `rengi günlük getiriyi gösteriyor. Değerler aşağıdaki tabloda.`,
  });

  for (const c of cells) {
    const w = Math.max(0, c.w - GAP);
    const h = Math.max(0, c.h - GAP);
    if (w < 1 || h < 1) continue;

    const g = el('g', { tabindex: '0' });

    g.appendChild(el('rect', {
      x: c.x, y: c.y, width: w, height: h,
      rx: Math.min(6, w / 3, h / 3),
      fill: divergingColor(c.changePct),
    }));

    // Etiket YALNIZCA sigiyorsa cizilir. Kirpilmis/tasan etiket yerine
    // hicbir etiket daha iyi — deger zaten ipucunda ve tabloda.
    const fs = w > 92 && h > 58 ? 13 : 11;
    const needW = c.s.length * fs * 0.62 + 10;
    if (w >= needW && h >= fs * 2 + 12) {
      const t1 = el('text', {
        x: c.x + 7, y: c.y + fs + 5,
        'font-size': fs, 'font-weight': 700,
        fill: 'rgba(8,10,8,0.86)',
      });
      t1.textContent = c.s;
      g.appendChild(t1);

      if (h >= fs * 2 + 18) {
        const t2 = el('text', {
          x: c.x + 7, y: c.y + fs * 2 + 7,
          'font-size': fs - 1.5,
          fill: 'rgba(8,10,8,0.66)',
        });
        t2.textContent = pct(c.changePct);
        g.appendChild(t2);
      }
    }

    bindTip(g, () => `
      <div class="t-sym">${c.s} <span style="color:var(--ink-muted);font-weight:400">${c.n}</span></div>
      <div class="t-row">Günlük değişim <b class="${c.changePct > 0 ? 'up' : c.changePct < 0 ? 'down' : ''}">${pct(c.changePct)}</b></div>
      <div class="t-row">Endeks ağırlığı <b>${pctPlain(c.w * 100)}</b></div>
      <div class="t-row">Katkı <b>${pp(c.contribPp)}</b></div>
    `);

    svg.appendChild(g);
  }

  host.appendChild(svg);
}
