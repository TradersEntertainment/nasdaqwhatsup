/**
 * Endeks secici — NDX / SPX / DJI.
 *
 * Her cip o endeksin CANLI yuzdesini gosterir, boylece secim yapmadan once
 * "hangisi bugun ne yapmis" gorulur. Tiklayinca tum pano o endekse gecer.
 *
 * Kritik davranis: bir endeks yalnizca SUNUCUDA GERCEK VERISI VARSA cip
 * olarak cikar. Uye listesi kaynaktan gelmediyse o endeks hic gorunmez —
 * bos ya da yanlis bir endeks gostermektense hic gostermemek dogru.
 */

import { pct, tone, arrow } from '../format.js';

export const INDEX_META = {
  ndx: { short: 'NDX', label: 'NASDAQ-100', sub: 'NASDAQ-100 · katkı, genişlik ve ıraksama' },
  spx: { short: 'SPX', label: 'S&P 500', sub: 'S&P 500 · katkı, genişlik ve ıraksama' },
  dji: { short: 'DJI', label: 'Dow Jones 30', sub: 'Dow Jones 30 · FİYAT ağırlıklı endeks' },
};

const ORDER = ['ndx', 'spx', 'dji'];

/**
 * @param {HTMLElement} host
 * @param {object} o
 * @param {string} o.active
 * @param {Record<string, {changePct: number}|null>} o.summary endeks -> ozet
 * @param {(key: string) => void} o.onPick
 */
export function renderIndexSwitch(host, { active, summary, onPick }) {
  const keys = ORDER.filter((k) => k === active || summary[k]);
  // Tek endeks varsa secici gostermenin anlami yok.
  if (keys.length < 2) { host.innerHTML = ''; return; }

  host.innerHTML = keys.map((k) => {
    const m = INDEX_META[k];
    const s = summary[k];
    const on = k === active;
    return `<button type="button" class="idx-chip" data-idx="${k}"
      aria-pressed="${on}" title="${m.label}">
      <span class="idx-code">${m.short}</span>
      <span class="idx-val ${s ? tone(s.changePct) : ''}">${
        s ? `${arrow(s.changePct)} ${pct(s.changePct)}` : '—'
      }</span>
    </button>`;
  }).join('');

  for (const btn of host.querySelectorAll('[data-idx]')) {
    btn.addEventListener('click', () => {
      const k = btn.getAttribute('data-idx');
      if (k && k !== active) onPick(k);
    });
  }
}

/**
 * Baslik ve alt basligi secili endekse gore gunceller. Site NDX sorusuyla
 * dogdugu icin baslik NDX'te ozgun halinde kalir.
 * @param {string} key
 */
export function paintBrand(key) {
  const m = INDEX_META[key] ?? INDEX_META.ndx;
  const t = document.getElementById('brand-title');
  const sub = document.getElementById('brand-sub');
  if (t) t.textContent = key === 'ndx' ? "Nasdaq'ı Kim Taşıyor?" : `${m.label}'i Kim Taşıyor?`;
  if (sub) sub.textContent = m.sub;
  document.title = key === 'ndx'
    ? "Nasdaq'ı Kim Taşıyor?"
    : `${m.label}'i Kim Taşıyor?`;
}
