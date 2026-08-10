/**
 * "Son 1 dk / 5 dk / 15 dk / 1 sa / 4 sa'te endeksi ne taşıdı?"
 *
 * Gunluk katkiyla ayni soru, farkli pencere. Ozellikle kullanicinin sorusunun
 * en can alici hali burada gorunur: gun bazinda dengeli gorunen bir tablo,
 * 15 dakikalik pencerede "tek isim tasiyor, 80 hisse dusuyor"a donusebilir.
 *
 * Veri yetmeyen pencere DEVRE DISI cip olarak kalir — bos grafik ya da
 * uydurma sayi degil, "bant heniz o kadar geriye gitmiyor" mesaji.
 */

import { renderBars } from '../charts/bars.js';
import { pct, pts, int, pctPlain, tone, arrow } from '../format.js';

/** Kullanicinin sectigi pencere sayfada kalici. */
let selected = 'm15';

const ORDER = ['m1', 'm5', 'm15', 'h1', 'h4'];

/** Cip etiketi (kisa) ve baslik eki (Turkce bulunma hali). */
const LABEL = {
  m1: ['1 dk', '1 dakikada'],
  m5: ['5 dk', '5 dakikada'],
  m15: ['15 dk', '15 dakikada'],
  h1: ['1 saat', '1 saatte'],
  h4: ['4 saat', '4 saatte'],
};

/** "4 sa 12 dk" gibi gercek aralik yazisi. */
function spanText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} sa ${r} dk` : `${h} sa`;
}

/**
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderWindows(host, snap) {
  const w = snap.windows ?? {};
  const available = ORDER.filter((k) => w[k]);

  if (available.length === 0) {
    host.innerHTML = `<p class="empty">
      Pencere geçmişi henüz birikmedi. Sunucu her dakika bir kare kaydediyor;
      ilk pencere birkaç dakika içinde açılır.</p>`;
    return;
  }

  // Secili pencere kapandiysa (ornegin yeniden baslatma sonrasi 4 sa yok)
  // en uzun MEVCUT pencereye dus — kullanici bos ekranla karsilasmasin.
  if (!w[selected]) selected = available[available.length - 1];
  const cur = w[selected];

  // Baslik secili pencereye gore konusur. Sabit bir baslik ("Son ne tasidi?")
  // hem bozuk Turkce hem de eksik bilgi olurdu.
  const h = document.getElementById('h-win');
  if (h) h.textContent = `Son ${LABEL[selected][1]} endeksi ne taşıdı?`;

  host.innerHTML = `
    <div class="win-chips" role="group" aria-label="Zaman penceresi">
      ${ORDER.map((k) => {
        const d = w[k];
        const on = k === selected;
        return `<button type="button" class="win-chip" data-win="${k}"
          aria-pressed="${on}" ${d ? '' : 'disabled'}
          title="${d ? `gerçek aralık: ${spanText(d.actualMs)}` : 'bu pencere için yeterli geçmiş yok'}"
        >${label(k)}</button>`;
      }).join('')}
    </div>
    <div class="win-readout">
      <div>
        <div class="win-num ${tone(cur.changePct)}">${arrow(cur.changePct)} ${pct(cur.changePct)}</div>
        <div class="win-sub">endeks · ${pts(cur.changePts)} puan</div>
      </div>
      <div class="win-breadth">
        <div><b class="up">${int(cur.up)}</b> yükselen · <b class="down">${int(cur.down)}</b> düşen
          ${cur.flat ? `· <span class="flat">${int(cur.flat)} kıpırdamadı</span>` : ''}</div>
        <div class="win-sub">
          ${cur.grossUpPp > 0
            ? `yükselişin yarısını <b>${int(cur.namesToHalfOfUp)}</b> hisse yapıyor`
            : 'bu pencerede yükseliş yok'}
        </div>
      </div>
    </div>
    ${cur.approx ? `<p class="empty" style="text-align:left;padding:0 0 8px">
      Gerçek aralık <b>${spanText(cur.actualMs)}</b> — bant tam
      ${label(selected)} öncesine ulaşmıyor, en yakın kare kullanıldı.</p>` : ''}
    <div id="win-bars"></div>
    ${verdictLine(cur)}
  `;

  for (const btn of host.querySelectorAll('[data-win]')) {
    btn.addEventListener('click', () => {
      if (btn.hasAttribute('disabled')) return;
      selected = /** @type {string} */ (btn.getAttribute('data-win'));
      renderWindows(host, snap);
    });
  }

  // Cubuklar gunluk katkiyla AYNI bilesenden ciziliyor: ayni gorsel dilbilgisi,
  // ayni ipucu, ayni renk kutupsalligi. Pencere yalnizca bazi degistiriyor.
  renderBars(
    /** @type {HTMLElement} */ (host.querySelector('#win-bars')),
    [...cur.carriers, ...cur.draggers],
    { perSide: host.clientWidth < 560 ? 6 : 8 }
  );
}

function label(k) {
  return LABEL[k]?.[0] ?? k;
}

/** Pencereye ozel tek cumlelik teshis. */
function verdictLine(cur) {
  const movers = cur.up + cur.down;
  if (movers === 0) return '';

  const downShare = (cur.down / movers) * 100;
  const top = cur.carriers[0];

  // Kullanicinin sorusunun tam kalbi: endeks artida ama cogunluk kirmizi.
  if (cur.changePct > 0 && downShare >= 55 && top) {
    return `<p class="verdict-body" style="font-size:var(--fs-sm);margin-top:12px">
      Bu pencerede hisselerin <b>${pctPlain(downShare)}</b>'si düştü ama endeks
      <b class="up">${pct(cur.changePct)}</b> yükseldi — yükselişin
      <b>${pctPlain(top.sharePct)}</b>'si tek başına <b>${top.s}</b>'den geliyor.</p>`;
  }
  if (cur.changePct < 0 && downShare <= 45) {
    return `<p class="verdict-body" style="font-size:var(--fs-sm);margin-top:12px">
      Hisselerin çoğu yükseldi ama endeks <b class="down">${pct(cur.changePct)}</b>
      geriledi — düşüşü birkaç ağır isim taşıyor.</p>`;
  }
  return `<p class="verdict-body" style="font-size:var(--fs-sm);margin-top:12px">
    Son ${spanText(cur.actualMs)} içinde <b>${int(cur.up)}</b> hisse yükseldi,
    <b>${int(cur.down)}</b> hisse düştü; endeks
    <b class="${tone(cur.changePct)}">${pct(cur.changePct)}</b>.</p>`;
}

/** Yeniden boyutlandirmada cubuklar yeniden olculsun diye disari acildi. */
export function repaintWindowBars(host, snap) {
  const cur = snap.windows?.[selected];
  const el = host.querySelector('#win-bars');
  if (cur && el) {
    renderBars(/** @type {HTMLElement} */ (el), [...cur.carriers, ...cur.draggers],
      { perSide: host.clientWidth < 560 ? 6 : 8 });
  }
}
