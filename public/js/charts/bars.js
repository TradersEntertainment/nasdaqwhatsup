/**
 * ANA GORSEL: iraksayan katki cubuklari.
 *
 * Kullanicinin sorusunu ("Nasdaq'i kim tasiyor?") dogrudan cevaplayan grafik.
 * Sifir cizgisi verinin kendi araligina gore konumlanir; tasiyanlar saga
 * (lime), cekenler sola (kirmizi).
 *
 * Renk kutupsalligi kodluyor, buyuklugu DEGIL — tum pozitif cubuklar ayni
 * lime, tum negatifler ayni kirmizi. Buyuklugu cubuk uzunlugu zaten soyluyor;
 * ayni bilgiyi renge de yuklemek kimlik kanalini bosa harcardi.
 */

import { POLE } from './scale.js';
import { bindTip } from './tooltip.js';
import { pct, pp, pts, pctPlain, badgeColor } from '../format.js';

const SVG = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => {
  const e = document.createElementNS(SVG, n);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/**
 * @param {HTMLElement} host
 * @param {any[]} constituents
 * @param {{perSide?: number}} [opts]
 */
export function renderBars(host, constituents, opts = {}) {
  host.replaceChildren();

  const narrow = host.clientWidth < 560;
  const perSide = opts.perSide ?? (narrow ? 8 : 12);

  const sorted = [...constituents].sort((a, b) => b.contribPp - a.contribPp);
  const carriers = sorted.filter((c) => c.contribPp > 0).slice(0, perSide);
  const draggers = sorted.filter((c) => c.contribPp < 0).slice(-perSide);
  const rows = [...carriers, ...draggers];

  if (rows.length === 0) {
    host.innerHTML = '<p class="empty">Bu seansta katkı üretecek hareket yok.</p>';
    return;
  }

  const W = Math.max(320, host.clientWidth);
  const gutter = narrow ? 74 : 104;   // sembol sutunu
  const padR = narrow ? 54 : 76;      // deger etiketi icin
  const rowH = 26;
  const barH = 13;
  const H = rows.length * rowH + 26;

  // S&P/Dow'un puan cinsinden SEVIYESI anahtarsiz elde edilemiyor; o
  // endekslerde `contribPts` her satirda 0 gelir. Etiketleri "0,00" diye
  // basmak yerine yuzde puanina dusulur — uydurma seviye yok.
  const hasPts = rows.some((c) => Number.isFinite(c.contribPts) && c.contribPts !== 0);

  const maxPos = Math.max(0, ...rows.map((c) => c.contribPp));
  const maxNeg = Math.max(0, ...rows.map((c) => -c.contribPp));
  const span = maxPos + maxNeg || 1;

  // Deger etiketleri cubuklarin DIS uclarinda duruyor, o yuzden her iki ucta
  // da onlara yer AYRILMALI. Ayrilmazsa negatif etiketler sembol sutununun
  // ustune biniyor ("NFLX-15,35" gibi) — cizim alanini once kis, sonra olcekle.
  const labelW = narrow ? 46 : 58;
  const plotW = Math.max(40, W - gutter - padR - labelW);
  // Sifir cizgisi, iki tarafin gercek genligine gore konumlanir.
  const x0 = gutter + labelW + (maxNeg / span) * plotW;
  const scale = (v) => (Math.abs(v) / span) * plotW;

  const svg = el('svg', {
    class: 'chart', width: '100%', height: H,
    viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMinYMin meet',
    role: 'img',
    'aria-label':
      `Katkı çubukları: ${carriers.length} taşıyıcı ve ${draggers.length} yük. ` +
      `Tüm değerler aşağıdaki tabloda da var.`,
  });

  // Sifir cizgisi — kesiksiz sac teli.
  svg.appendChild(el('line', {
    x1: x0, x2: x0, y1: 4, y2: H - 18,
    stroke: 'var(--baseline)', 'stroke-width': 1,
  }));

  rows.forEach((c, i) => {
    const y = 6 + i * rowH;
    const positive = c.contribPp > 0;
    const len = Math.max(2, scale(c.contribPp));
    const bx = positive ? x0 + 1 : x0 - len - 1; // sifir cizgisinin iki yaninda 1px bosluk

    const g = el('g', { tabindex: '0', role: 'listitem' });

    // Genis vurus alani: cubuk 13px ama hedef 26px (dokunmatik icin).
    g.appendChild(el('rect', {
      x: 0, y, width: W, height: rowH, fill: 'transparent',
    }));

    // Sembol rozeti + kod
    const badge = el('rect', {
      x: 0, y: y + (rowH - 16) / 2, width: 16, height: 16, rx: 5,
      fill: badgeColor(c.s),
    });
    g.appendChild(badge);

    const label = el('text', {
      x: 22, y: y + rowH / 2 + 4,
      'font-size': narrow ? 11 : 12, 'font-weight': 650,
      fill: 'var(--ink)',
    });
    label.textContent = c.s;
    g.appendChild(label);

    // Cubuk — ucu 4px yuvarlatilmis, tabana sabitlenmis.
    g.appendChild(el('rect', {
      x: bx, y: y + (rowH - barH) / 2, width: len, height: barH,
      rx: 4,
      fill: positive ? POLE.up : POLE.down,
    }));

    // Deger etiketi cubugun DIS ucunda — icine sigmayacagi icin asla kirpilmaz.
    const vx = positive
      ? Math.min(W - 4, bx + len + 7)
      : Math.max(gutter + 4, bx - 7);
    const val = el('text', {
      x: vx, y: y + rowH / 2 + 4,
      'font-size': narrow ? 10.5 : 11.5,
      'text-anchor': positive ? 'start' : 'end',
      fill: 'var(--ink-2)',
      'font-variant-numeric': 'tabular-nums',
    });
    val.textContent = hasPts ? pts(c.contribPts) : pp(c.contribPp);
    g.appendChild(val);

    bindTip(g, () => `
      <div class="t-sym">${c.s} <span style="color:var(--ink-muted);font-weight:400">${c.n}</span></div>
      <div class="t-row">Günlük değişim <b class="${positive ? 'up' : 'down'}">${pct(c.changePct)}</b></div>
      <div class="t-row">Endeks ağırlığı <b>${pctPlain(c.w * 100)}</b></div>
      <div class="t-row">Katkı <b>${pp(c.contribPp)}</b> · ${pts(c.contribPts)} endeks puanı</div>
      <div class="t-row">${positive ? 'Yükselişin' : 'Düşüşün'} <b>${pctPlain(c.sharePct)}</b>'si bu hisseden</div>
    `);

    svg.appendChild(g);
  });

  // Eksen etiketleri — kap yuksekligi bunlari ICERIYOR, kirpilmiyor.
  const axis = (x, text, anchor) => {
    const t = el('text', {
      x, y: H - 4, 'font-size': 10.5, fill: 'var(--ink-muted)', 'text-anchor': anchor,
    });
    t.textContent = text;
    return t;
  };
  if (maxNeg > 0) svg.appendChild(axis(x0 - 8, '◀ endeksi aşağı çekenler', 'end'));
  if (maxPos > 0) svg.appendChild(axis(x0 + 8, 'taşıyanlar ▶', 'start'));

  host.appendChild(svg);
}
