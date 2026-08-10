/**
 * Yardimci paneller: genislik karsilastirmasi, konsantrasyon, karsi-olgu,
 * liderlik tablosu.
 */

import { pct, pctPlain, int, tone, ppPlain, tsiDayLabel } from '../format.js';
import { POLE } from '../charts/scale.js';

/* ---------- Sayi vs Agirlik ---------- */

/**
 * Carpikligi tek bakista gosteren panel: ayni piyasa iki kere olculuyor —
 * bir kere HISSE SAYISIYLA, bir kere ENDEKS AGIRLIGIYLA. Iki cubugun
 * birbirini tutmamasi kullanicinin sorusunun cevabi.
 *
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderBreadth(host, snap) {
  const i = snap.index;
  const b = i.breadth;

  if (b.traded === 0) {
    host.innerHTML = `<p class="empty">Bu seansta hiçbir hisse işlem görmedi.</p>`;
    return;
  }

  // Agirliklar yalnizca islem gorenler uzerinden — karsilastirma adil olsun.
  const traded = snap.constituents.filter((c) => c.traded);
  const wTotal = traded.reduce((s, c) => s + c.w, 0) || 1;
  const wUp = traded.filter((c) => c.changePct > 0).reduce((s, c) => s + c.w, 0) / wTotal;
  const wDown = traded.filter((c) => c.changePct < 0).reduce((s, c) => s + c.w, 0) / wTotal;

  const countUp = b.advancers / b.traded;
  const countDown = b.decliners / b.traded;

  host.innerHTML = `
    ${bar('Hisse sayısıyla', countUp, countDown, `${int(b.advancers)} / ${int(b.decliners)}`)}
    ${bar('Endeks ağırlığıyla', wUp, wDown, `${pctPlain(wUp * 100)} / ${pctPlain(wDown * 100)}`)}
    <p class="verdict-body" style="font-size:var(--fs-sm);margin-top:14px">
      Hisselerin <b>${pctPlain(countDown * 100)}</b>'si kırmızı, ama endeks
      ağırlığının sadece <b>${pctPlain(wDown * 100)}</b>'si kırmızı.
      Endeksin gördüğü piyasa ile sizin gördüğünüz piyasa bu yüzden ayrışıyor.
    </p>
    ${b.noTrade > 0 ? `<p class="empty" style="padding:8px 0 0;text-align:left">
      ${int(b.noTrade)} hissede bu seansta hiç işlem baskısı yok; oranlar
      yalnızca işlem görenler üzerinden.</p>` : ''}
  `;
}

function bar(label, up, down, right) {
  const flat = Math.max(0, 1 - up - down);
  const seg = (cls, frac, text) => frac <= 0.001 ? '' :
    `<div class="bc-seg ${cls}" style="flex:${frac}">${frac > 0.12 ? text : ''}</div>`;
  return `
    <div class="bar-compare">
      <div class="bc-head"><span>${label}</span><span>${right}</span></div>
      <div class="bc-track">
        ${seg('up', up, pctPlain(up * 100))}
        ${seg('down', down, pctPlain(down * 100))}
        ${seg('nt', flat, '')}
      </div>
    </div>`;
}

/* ---------- Konsantrasyon ---------- */

/**
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderConcentration(host, snap) {
  const i = snap.index;
  if (i.grossUpPp <= 0) {
    host.innerHTML = `<p class="empty">Bu seansta endeksi yukarı taşıyan hisse yok.</p>`;
    return;
  }

  const carriers = [...snap.constituents]
    .filter((c) => c.contribPp > 0)
    .sort((a, b) => b.contribPp - a.contribPp);

  const top5 = carriers.slice(0, 5);
  const share = i.top5UpShare;

  host.innerHTML = `
    <div class="cf-readout">
      <span class="cf-val num-big up">${pctPlain(share)}</span>
      <span class="cf-from">yükselişin ilk 5 hisseden geldiği pay</span>
    </div>
    <div class="bc-track" style="margin:14px 0 16px">
      <div class="bc-seg up" style="flex:${share}">${pctPlain(share)}</div>
      <div class="bc-seg nt" style="flex:${Math.max(0.001, 100 - share)}">diğer ${int(carriers.length - top5.length)}</div>
    </div>
    <div class="cf-removed">
      ${top5.map((c) => `
        <span class="tick">
          <i class="sw" style="background:${POLE.up}"></i>
          <b>${c.s}</b> ${pctPlain(c.sharePct)}
        </span>`).join('')}
    </div>
    <p class="empty" style="text-align:left;padding:14px 0 0">
      Yükselişin yarısı <b style="color:var(--ink)">${int(i.namesToHalfOfUp)}</b> hisseden geliyor.
    </p>
  `;
}

/* ---------- Karsi-olgu ---------- */

/**
 * "Ilk N tasiyiciyi cikar" — kalan agirliklar yeniden normalize edilerek.
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderCounterfactual(host, snap) {
  const cf = snap.counterfactual ?? [];
  const carriers = [...snap.constituents]
    .filter((c) => c.contribPp > 0)
    .sort((a, b) => b.contribPp - a.contribPp);

  if (cf.length === 0 || carriers.length === 0) {
    host.innerHTML = `<p class="empty">Çıkarılacak taşıyıcı yok.</p>`;
    return;
  }

  const maxN = Math.min(10, carriers.length);

  host.innerHTML = `
    <div class="cf-readout">
      <span class="cf-val num-big" id="cf-val"></span>
      <span class="cf-from" id="cf-from"></span>
    </div>
    <label class="sr-only" for="cf-range">Çıkarılacak taşıyıcı sayısı</label>
    <input type="range" id="cf-range" min="0" max="${maxN}" value="0" step="1">
    <div class="bc-head"><span>0</span><span>${maxN} hisse</span></div>
    <div class="cf-removed" id="cf-removed"></div>
  `;

  const range = /** @type {HTMLInputElement} */ (host.querySelector('#cf-range'));
  const valEl = host.querySelector('#cf-val');
  const fromEl = host.querySelector('#cf-from');
  const remEl = host.querySelector('#cf-removed');

  const paint = () => {
    const n = Number(range.value);
    const row = cf.find((c) => c.removeTop === n) ?? cf[0];
    valEl.textContent = pct(row.changePct);
    valEl.className = `cf-val num-big ${tone(row.changePct)}`;
    fromEl.textContent = n === 0
      ? 'endeksin gerçek hâli'
      : `${n} taşıyıcı çıkarılınca (${pct(snap.index.changePct)} yerine)`;
    remEl.innerHTML = carriers.slice(0, n).map((c) => `
      <span class="tick"><i class="sw"></i><b>${c.s}</b> ${pct(c.changePct)}</span>
    `).join('');
  };

  range.addEventListener('input', paint);
  paint();
}

/* ---------- Liderlik tablosu ---------- */

/**
 * @param {HTMLElement} host
 * @param {{summaries: any[], leaderboard: any[]}} hist
 */
export function renderLeaderboard(host, hist) {
  if (!hist.leaderboard?.length) {
    host.innerHTML = `<p class="empty">
      Geçmiş henüz birikmedi. Site her TSİ günü kapandığında o seansı kaydeder;
      birkaç seans sonra burada "son 30 günde endeksi en çok kim taşıdı"
      tablosu oluşacak.</p>`;
    return;
  }

  const rows = hist.leaderboard.slice(0, 12);
  host.innerHTML = `
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Hisse</th>
          <th>Kümülatif katkı</th>
          <th>İlk 3'te</th>
          <th>1 numara</th>
          <th>Seans</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><span class="sym">${r.s}</span></td>
              <td class="${tone(r.cumPp)}">${ppPlain(r.cumPp)}</td>
              <td>${int(r.top3)}</td>
              <td>${int(r.top1)}</td>
              <td>${int(r.days)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="empty" style="text-align:left;padding-top:12px">
      Son ${int(hist.days)} seans. "Kümülatif katkı", o hissenin endekse eklediği
      yüzde puanların toplamı.
    </p>
  `;
}

/* ---------- Son kapanmis seans ---------- */

/**
 * Hafta sonu / tatil / gece: bu seansta hic islem yoksa sifir duvari yerine
 * son kapanmis seansi goster. Kullanicinin sorusu ("kim tasidi?") o gun de
 * gecerli; sadece cevabi dunden.
 *
 * @param {HTMLElement} host
 * @param {any} snap
 * @returns {boolean} kart gosterildiyse true
 */
export function renderLastSession(host, snap) {
  const ls = snap.lastSession;
  if (!ls) { host.innerHTML = ''; return false; }

  const names = (ls.top3 ?? []).map((c) => `<b>${c.s}</b>`).join(', ');
  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-head">
        <h2>Son kapanan seans</h2>
        <span class="sub">${tsiDayLabel(ls.tsiDay)}</span>
      </div>
      <div class="cf-readout">
        <span class="cf-val num-big ${tone(ls.changePct)}">${pct(ls.changePct)}</span>
        <span class="cf-from">
          eşit ağırlıklı <b class="${tone(ls.equalWeightPct)}">${pct(ls.equalWeightPct)}</b>
          · ${int(ls.breadth.advancers)} yükselen / ${int(ls.breadth.decliners)} düşen
        </span>
      </div>
      ${names ? `<p class="empty" style="text-align:left;padding:12px 0 0">
        O seansı en çok taşıyanlar: ${names}</p>` : ''}
    </div>`;
  return true;
}
