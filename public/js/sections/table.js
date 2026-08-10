/**
 * Tum hisseler tablosu — ayni zamanda her grafigin TABLO IKIZI.
 *
 * Renkle kodlanan her deger (katki cubuklari, isi haritasi) burada sayi olarak
 * da okunabiliyor; ipucu balonu hicbir degerin TEK okuma yolu degil.
 *
 * Kullanici "tum Nasdaq-100" dedigi icin varsayilan filtre YOK. Takip listesi
 * bu yuzden "ekleme" degil "cikarma" olarak cerceveleniyor.
 */

import { pct, usd, pctPlain, pp, badgeColor, normalizeSymbol, age } from '../format.js';

const LS_KEY = 'nwu.watchlist.v1';

/** @type {{key: string, dir: 1|-1}} */
let sort = { key: 'contribPp', dir: -1 };
let query = '';
let onlyStarred = false;

/** @returns {Set<string>} */
function loadStars() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
    // Surumlu zarf: ileride varsayilan degisirse temiz goc edilebilsin.
    if (raw && raw.version === 1 && Array.isArray(raw.tickers)) return new Set(raw.tickers);
  } catch { /* bozuk kayit — sifirdan basla */ }
  return new Set();
}

/** @param {Set<string>} set */
function saveStars(set) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      version: 1, tickers: [...set], isDefault: set.size === 0,
    }));
  } catch { /* private mode — yildizlar sadece bu oturumda yasar */ }
}

let stars = loadStars();

const COLS = [
  { key: 's', label: 'Hisse', align: 'left' },
  { key: 'n', label: 'Ad', align: 'left' },
  { key: 'price', label: 'Fiyat' },
  { key: 'changePct', label: 'TSİ seansı' },
  { key: 'gapPct', label: 'Gece boşluğu' },
  { key: 'rthPct', label: 'Seans içi' },
  { key: 'w', label: 'Ağırlık' },
  { key: 'contribPts', label: 'Katkı (puan)' },
  { key: 'contribPp', label: 'Katkı (pp)' },
  { key: 'sharePct', label: 'Tarafındaki pay' },
  { key: 'lastTradeAtUtc', label: 'Son işlem' },
];

/**
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderTable(host, snap) {
  host.innerHTML = `
    <div class="table-tools">
      <input type="search" id="tbl-q" placeholder="Sembol veya ad ara…"
             value="${escapeAttr(query)}" aria-label="Hisse ara">
      <div class="seg" role="group" aria-label="Liste kapsamı">
        <button type="button" data-scope="all" aria-pressed="${!onlyStarred}">Tümü (${snap.constituents.length})</button>
        <button type="button" data-scope="star" aria-pressed="${onlyStarred}">Takip ettiklerim (${stars.size})</button>
      </div>
      <span class="chip" style="margin-left:auto">Sırala: ${labelOf(sort.key)} ${sort.dir < 0 ? '▼' : '▲'}</span>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr>${COLS.map(headCell).join('')}<th style="width:38px"><span class="sr-only">Takip</span></th></tr></thead>
        <tbody id="tbl-body"></tbody>
      </table>
    </div>
  `;

  const body = /** @type {HTMLElement} */ (host.querySelector('#tbl-body'));

  const paint = () => {
    let rows = snap.constituents;
    if (onlyStarred && stars.size) rows = rows.filter((c) => stars.has(c.s));
    if (query) {
      const q = query.toUpperCase();
      rows = rows.filter((c) => c.s.includes(q) || c.n.toUpperCase().includes(q));
    }
    rows = [...rows].sort(cmp);

    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="${COLS.length + 1}" class="empty">Eşleşen hisse yok.</td></tr>`;
      return;
    }

    body.innerHTML = rows.map((c) => `
      <tr class="${c.traded ? '' : 'muted'}">
        <td><span class="sym"><i class="badge" style="background:${badgeColor(c.s)}">${c.s.slice(0, 2)}</i>${c.s}</span></td>
        <td class="name">${escapeHtml(c.n)}</td>
        <td>${usd(c.price)}</td>
        <td class="${cls(c.changePct)}">${pct(c.changePct)}</td>
        <td class="${cls(c.gapPct)}">${c.gapPct == null ? '—' : pct(c.gapPct)}</td>
        <td class="${cls(c.rthPct)}">${c.rthPct == null ? '—' : pct(c.rthPct)}</td>
        <td>${pctPlain(c.w * 100)}</td>
        <td class="${cls(c.contribPts)}">${c.contribPts.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' })}</td>
        <td class="${cls(c.contribPp)}">${pp(c.contribPp)}</td>
        <td>${pctPlain(c.sharePct)}</td>
        <td>${c.traded ? age(Math.round((snap.generatedAtMs - c.lastTradeAtUtc) / 1000)) : 'işlem yok'}</td>
        <td><button class="star" type="button" data-sym="${c.s}"
              aria-pressed="${stars.has(c.s)}"
              aria-label="${c.s} takip listesi">${stars.has(c.s) ? '★' : '☆'}</button></td>
      </tr>`).join('');
  };

  host.querySelector('#tbl-q')?.addEventListener('input', (e) => {
    query = /** @type {HTMLInputElement} */ (e.target).value;
    paint();
  });

  for (const btn of host.querySelectorAll('[data-scope]')) {
    btn.addEventListener('click', () => {
      onlyStarred = btn.getAttribute('data-scope') === 'star';
      renderTable(host, snap);
    });
  }

  for (const th of host.querySelectorAll('th[data-key]')) {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-key');
      // Metin sutunlari artan, sayisal sutunlar azalan baslar.
      if (sort.key === key) sort.dir = /** @type {1|-1} */ (-sort.dir);
      else sort = { key, dir: key === 's' || key === 'n' ? 1 : -1 };
      renderTable(host, snap);
    });
  }

  body.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('.star');
    if (!btn) return;
    const sym = btn.getAttribute('data-sym');
    if (!sym) return;
    if (stars.has(sym)) stars.delete(sym);
    else stars.add(sym);
    saveStars(stars);
    renderTable(host, snap);
  });

  paint();
}

function headCell(c) {
  const active = sort.key === c.key;
  const aria = active ? ` aria-sort="${sort.dir < 0 ? 'descending' : 'ascending'}"` : '';
  return `<th data-key="${c.key}"${aria} title="${c.label} ile sırala">${c.label}${active ? (sort.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
}

function labelOf(key) {
  return COLS.find((c) => c.key === key)?.label ?? key;
}

function cmp(a, b) {
  const k = sort.key;
  const av = a[k], bv = b[k];
  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av ?? '').localeCompare(String(bv ?? ''), 'tr') * sort.dir;
  }
  // null'lar her zaman en sona — siralama yonu ne olursa olsun.
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return (av - bv) * sort.dir;
}

const cls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const escapeAttr = escapeHtml;

export { normalizeSymbol };
