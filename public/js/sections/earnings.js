/**
 * Bilanco uyarilari.
 *
 * Neden onemli: bilanco gunu bir hissenin oynakligi kati artar ve endeksi tek
 * basina tasiyabilir. "Bunu kim tasiyor?" sorusunun cevabi cogu zaman "dun
 * aksam bilanco aciklayan sirket" oluyor — o yuzden bu bilgi tablonun
 * KENARINDA, hissenin yaninda duruyor; ayri bir sayfada degil.
 *
 * Gorsel kural: rozet renkle DEGIL, once metinle konusuyor ("bugün", "yarın").
 * Renk yalnizca aciliyeti guclendiriyor.
 */

import { int } from '../format.js';

/** Rozette gorunen kisa metin. */
export function shortLabel(inDays) {
  if (inDays === 0) return 'bugün';
  if (inDays === 1) return 'yarın';
  return `${inDays}g`;
}

/** 0–1 gun: sicak. 2–3 gun: yakin. Otesi: sakin. */
export function urgency(inDays) {
  if (inDays <= 1) return 'hot';
  if (inDays <= 3) return 'soon';
  return '';
}

/**
 * Tablo/satir ici rozet. `earn` yoksa bos string — cagiran yerde kosul gerekmez.
 * @param {{inDays: number, text: string}|null|undefined} earn
 */
export function earnBadge(earn) {
  if (!earn) return '';
  return `<i class="earn-badge ${urgency(earn.inDays)}" title="${escapeAttr(earn.text)}"
    aria-label="${escapeAttr(earn.text)}">◈ ${shortLabel(earn.inDays)}</i>`;
}

/**
 * "Yaklasan bilancolar" karti — gune gore gruplanmis.
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderEarnings(host, snap) {
  const list = (snap.earningsSoon ?? []).filter((e) => e.inDays <= 7);

  if (list.length === 0) {
    host.innerHTML = `<p class="empty">
      Önümüzdeki 7 gün içinde NASDAQ-100'de bilanço açıklayan şirket
      görünmüyor${snap.earningsSoon?.length ? '' : ' (takvim kaynağı okunamamış olabilir)'}.</p>`;
    return;
  }

  // Gune gore grupla — kullanici "bu hafta ne var" diye bakiyor, sembol
  // sirasina degil takvime ihtiyaci var.
  /** @type {Map<number, any[]>} */
  const byDay = new Map();
  for (const e of list) {
    if (!byDay.has(e.inDays)) byDay.set(e.inDays, []);
    byDay.get(e.inDays).push(e);
  }

  // Agirligi buyuk olanlar one: endeksi tasima ihtimali en yuksek olanlar.
  const wOf = new Map(snap.constituents.map((c) => [c.s, c.w]));

  host.innerHTML = `
    <div class="earn-groups">
      ${[...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([days, items]) => `
        <div class="earn-group">
          <div class="earn-day ${urgency(days)}">
            ${days === 0 ? 'Bugün' : days === 1 ? 'Yarın' : `${days} gün sonra`}
            <span class="earn-count">${int(items.length)} hisse</span>
          </div>
          <div class="earn-syms">
            ${items
              .sort((a, b) => (wOf.get(b.s) ?? 0) - (wOf.get(a.s) ?? 0))
              .map((e) => `<span class="earn-sym" title="${escapeAttr(e.text)}">
                <b>${e.s}</b>${e.hint === 'bmo' ? ' ↑' : e.hint === 'amc' ? ' ↓' : ''}
              </span>`).join('')}
          </div>
        </div>`).join('')}
    </div>
    <p class="empty" style="text-align:left;padding-top:10px">
      ↑ açılış öncesi · ↓ kapanış sonrası. Bilanço günlerinde tek bir hisse
      endeksi tek başına taşıyabilir; tablodaki ◈ işareti bunu satır satır
      gösteriyor.</p>
  `;
}

const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
