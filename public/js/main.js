/**
 * Orkestrasyon: veriyi bagla, bolumleri boya, saati canli tut.
 */

import { connect, fetchIntraday, fetchHistory } from './api.js';
import { renderHero } from './sections/hero.js';
import { renderBreadth, renderConcentration, renderCounterfactual, renderLeaderboard, renderLastSession } from './sections/panels.js';
import { renderTable } from './sections/table.js';
import { renderWindows, repaintWindowBars } from './sections/windows.js';
import { renderEarnings } from './sections/earnings.js';
import { renderBars } from './charts/bars.js';
import { renderTreemap } from './charts/treemap.js';
import { renderDivergence } from './charts/lines.js';
import { rampCss } from './charts/scale.js';
import { tsiTime, tsiDayLabel, until, age, int, pctPlain } from './format.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Zaman referansi. Fixture modunda sunucu saati sabitleyebiliyor (hafta sonu /
 * gece ekranlarini gercek saati beklemeden gormek icin); o durumda on yuz de
 * ayni ani kullanmali, yoksa "Ana seans" yazarken saat 10:18 gosterir ve
 * sifirlanma geri sayimi 24 saati asar.
 */
const nowRef = () => (snap?.quality?.clockPinned ? snap.generatedAtMs : Date.now());

/** @type {any|null} */
let snap = null;
/** @type {any[]} */
let intraday = [];
let lastDay = null;
let historyLoaded = false;

/* ---------- Boyama ---------- */

function paintAll() {
  if (!snap) return;
  renderLastSession($('last-session'), snap);
  renderHero($('hero'), snap);
  renderBars($('carriers'), snap.constituents);
  renderWindows($('windows'), snap);
  renderEarnings($('earnings'), snap);
  renderConcentration($('concentration'), snap);
  renderBreadth($('breadth'), snap);
  renderTreemap($('heatmap'), snap.constituents);
  renderCounterfactual($('counterfactual'), snap);
  renderTable($('table'), snap);
  renderDivergence($('divergence'), intraday, snap.session);
  paintChrome();
}

function paintChrome() {
  if (!snap) return;
  const s = snap.session;
  const q = snap.quality;

  const sessionChip = $('chip-session');
  sessionChip.className = `chip ${s.live ? 'is-live' : ''}`;
  sessionChip.innerHTML =
    `<span class="dot ${s.live ? 'live' : ''}"></span>` +
    `<span><strong>${s.label}</strong> · TSİ ${tsiTime(nowRef())}</span>`;

  paintCountdown();

  const stale = (snap.ageSec ?? 0) > 720;
  const ageChip = $('chip-age');
  ageChip.className = `chip ${stale ? 'is-warn' : ''}`;
  ageChip.textContent = `Veri ${age(snap.ageSec)} önce`;

  // Uyarilar gizlenmez — kullanici neye baktigini bilsin.
  const warns = [];
  const cov = snap.coverage;
  if (cov?.partial) {
    warns.push(
      `⚠︎ <b>Kısmi kapsam:</b> yalnızca <b>${int(cov.count)}/${int(cov.total)}</b> hisse izleniyor` +
      `${cov.weightPct != null ? ` (endeks ağırlığının ${pctPlain(cov.weightPct)}'i)` : ''} — ` +
      `fiyatlar <b>${cov.venue ?? 'kripto'}</b> perp piyasasından, spot fiyattan sapabilir.`
    );
  }
  if (q.warnings?.includes('fixture-mode')) {
    warns.push('⚠︎ <b>Örnek veri</b> gösteriliyor — canlı fiyat akışı kapalı.');
  }
  if (q.warnings?.includes('weights-stale')) {
    warns.push('Ağırlıklar eskimiş olabilir (sentetik endeks resmî ^NDX’ten sapıyor).');
  }
  if (q.weightsSource === 'bundled-approx' || q.weightsSource === 'fallback') {
    warns.push('Ağırlıklar <b>yaklaşık</b> — canlı kaynak henüz okunamadı.');
  }
  if (q.overlay?.count > 0) {
    warns.push(
      `<b>${int(q.overlay.count)}</b> hissenin fiyatı <b>Hyperliquid</b> perp ` +
      `piyasasından — bu yüzden ABD borsası kapalıyken de canlı. Perp fiyatı ` +
      `spot fiyattan bir miktar sapabilir.`
    );
  }
  if (q.warnings?.includes('stooq-delayed')) {
    warns.push('Veri kaynağı <b>stooq</b> — fiyatlar ~15 dk gecikmeli olabilir.');
  }
  if (q.warnings?.includes('provisional-baselines')) {
    warns.push('Baz fiyatlar <b>geçici</b> (önceki kapanış) — gerçek bazlar birkaç dakika içinde yerine geçecek.');
  }
  // Kismi kapsamda eksik sembol listesi ZATEN beklenen durum; ayrica
  // "hesaba katilmadi" demek ayni seyi iki kez soylemek olur.
  if (q.dropped?.length && !cov?.partial) {
    warns.push(`${int(q.dropped.length)} hisse veri gelmediği için hesaba katılmadı.`);
  }
  $('banner').innerHTML = warns.length
    ? `<div class="card" style="border-color:rgba(250,178,25,.35);margin-bottom:var(--gap);padding:14px 18px">
         <span style="color:var(--warn);font-size:var(--fs-sm)">${warns.join(' · ')}</span>
       </div>`
    : '';

  $('footer').innerHTML =
    `${tsiDayLabel(snap.tsiDay)} seansı · veri kaynağı: <b>${q.source}</b>` +
    `${q.weightsAsOf ? ` · ağırlıklar ${q.weightsAsOf}` : ''}` +
    ` · ${int(snap.constituents.length)} hisse<br>` +
    `Yatırım tavsiyesi değildir. Fiyatlar gecikmeli olabilir.`;

  $('ramp').style.background = rampCss();
}

function paintCountdown() {
  if (!snap) return;
  const s = snap.session;
  const now = nowRef();
  const parts = [];
  if (s.nextPhaseAtUtc && s.nextPhaseAtUtc > now) {
    parts.push(`${s.nextPhaseLabel} → ${until(s.nextPhaseAtUtc - now)}`);
  }
  if (s.resetAtUtc > now) {
    parts.push(`sıfırlanmaya ${until(s.resetAtUtc - now)}`);
  }
  $('chip-reset').textContent = parts.join(' · ') || 'seans kapandı';
}

/* ---------- Veri akisi ---------- */

async function onSnapshot(next) {
  const first = snap == null;
  const dayChanged = snap && snap.tsiDay !== next.tsiDay;
  snap = next;

  if (first || dayChanged || lastDay !== next.tsiDay) {
    lastDay = next.tsiDay;
    intraday = (await fetchIntraday(next.tsiDay)).series ?? [];
  } else {
    // Yeni noktayi seriye ekle; her tikte tum gecmisi yeniden cekmeye gerek yok.
    const last = intraday.at(-1);
    if (!last || last.t !== next.generatedAt) {
      intraday.push({
        t: next.generatedAt,
        idx: next.index.changePct,
        ew: next.index.equalWeightPct,
      });
    }
  }

  paintAll();

  if (!historyLoaded) {
    historyLoaded = true;
    renderLeaderboard($('leaderboard'), await fetchHistory(30));
  }
}

connect(onSnapshot, ({ connected, health }) => {
  // Iskelet parlamasi yok — onceki render yerinde solar.
  document.body.classList.toggle('refreshing', !connected);

  // Hic veri gelmediyse kullaniciyi sonsuz "yukleniyor" ekraninda birakma.
  if (!snap && health && health.ready === false) {
    const errs = (health.lastErrors ?? []).join(' · ') || 'sebep bildirilmedi';
    $('hero').innerHTML = `
      <p class="verdict-title">Veri kaynağına ulaşılamıyor</p>
      <p class="verdict-body">
        Sunucu ayakta (${int(health.uptimeSec ?? 0)} sn) ama piyasa verisi
        henüz alınamadı. Üst üste <b>${int(health.consecutiveFailures ?? 0)}</b>
        deneme başarısız oldu.
      </p>
      <p class="empty" style="text-align:left;padding-top:10px">${errs}</p>`;
  }
});

// Saat ve geri sayim, veri gelmese de akmali.
setInterval(() => {
  if (!snap) return;
  paintCountdown();
  const chip = $('chip-session').querySelector('span:last-child');
  if (chip) chip.innerHTML =
    `<strong>${snap.session.label}</strong> · TSİ ${tsiTime(nowRef())}`;
}, 15_000);

// Yeniden boyutlandirmada SVG'ler yeniden olculmeli.
let rt;
window.addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => {
    if (!snap) return;
    renderBars($('carriers'), snap.constituents);
    repaintWindowBars($('windows'), snap);
    renderTreemap($('heatmap'), snap.constituents);
    renderDivergence($('divergence'), intraday, snap.session);
  }, 180);
});
