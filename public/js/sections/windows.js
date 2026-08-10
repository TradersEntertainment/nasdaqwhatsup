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

/**
 * Secili pencere. Baslangicta null: ilk boyamada HAREKETI OLAN en kisa
 * pencere secilir. Sabit bir varsayilan ("15 dk"), o pencerede hic baski
 * yoksa kullaniciyi olu bir ekranla karsilastiriyordu.
 */
let selected = null;
/** Kullanici bir cipe bastiysa secim artik ona ait — otomatik degistirilmez. */
let userPicked = false;

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
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} sn`;
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} sa ${r} dk` : `${h} sa`;
}

/**
 * Bir pencerenin acilmasi icin bandin ne kadar geriye gitmesi gerekiyor.
 * shared/windows.js'teki `pickFrame` toleransiyla (%50) AYNI esik — iki yerde
 * farkli sayi tutmak, arayuzun yalan soylemesi demek olurdu.
 */
const OPEN_AT = (ms) => ms * 0.5;

/**
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderWindows(host, snap) {
  const w = snap.windows ?? {};
  const available = ORDER.filter((k) => w[k]);

  const meta = snap.windowsMeta ?? { spanMs: 0, frames: 0, persisted: false };

  if (available.length === 0) {
    host.innerHTML = `<p class="empty">
      Pencere geçmişi henüz birikmedi. Sunucu her dakika bir fiyat karesi
      kaydediyor; ilk pencere birkaç dakika içinde açılır.</p>
      ${diskNote(meta)}`;
    return;
  }

  // Secim: kullanici sectiyse ona dokunma. Aksi halde hareketi olan en kisa
  // pencereyi sec — seans disinda 1 dk cogu zaman olu, 1 saat doludur.
  if (!selected || !w[selected]) selected = pickDefault(w, available);
  else if (!userPicked && movers(w[selected]) === 0) selected = pickDefault(w, available);
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
        const eksik = OPEN_AT(WIN_MS[k]) - meta.spanMs;
        return `<button type="button" class="win-chip" data-win="${k}"
          aria-pressed="${on}" ${d ? '' : 'disabled'}
          title="${d
            ? `gerçek aralık: ${spanText(d.actualMs)}`
            : `geçmiş henüz yetmiyor — yaklaşık ${spanText(Math.max(60000, eksik))} sonra açılır`}"
        >${d?.approx ? '~' : ''}${label(k)}</button>`;
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
      Gerçek aralık <b>${spanText(cur.actualMs)}</b> — geçmiş tam
      ${label(selected)} öncesine ulaşmıyor, en yakın kare kullanıldı.</p>` : ''}
    <div id="win-bars"></div>
    ${verdictLine(cur)}
    ${closedNote(w, meta)}
  `;

  for (const btn of host.querySelectorAll('[data-win]')) {
    btn.addEventListener('click', () => {
      if (btn.hasAttribute('disabled')) return;
      selected = /** @type {string} */ (btn.getAttribute('data-win'));
      userPicked = true;
      renderWindows(host, snap);
    });
  }

  const bars = /** @type {HTMLElement} */ (host.querySelector('#win-bars'));
  if (movers(cur) === 0) {
    // Bos cubuk grafigi yerine SEBEP. Onceki halde gunluk grafigin bos mesaji
    // ("Bu seansta katki uretecek hareket yok") pencere baglamina sizmisti.
    bars.innerHTML = quietBlock(cur, snap, w, available);
    const jump = bars.querySelector('[data-jump]');
    jump?.addEventListener('click', () => {
      selected = /** @type {string} */ (jump.getAttribute('data-jump'));
      userPicked = true;
      renderWindows(host, snap);
    });
    return;
  }

  // Cubuklar gunluk katkiyla AYNI bilesenden ciziliyor: ayni gorsel dilbilgisi,
  // ayni ipucu, ayni renk kutupsalligi. Pencere yalnizca bazi degistiriyor.
  renderBars(bars, [...cur.carriers, ...cur.draggers],
    { perSide: host.clientWidth < 560 ? 6 : 8 });
}

/** Bir pencerede fiyati kipirdayan hisse sayisi. */
const movers = (d) => (d ? d.up + d.down : 0);

/** Hareketi olan en kisa pencere; hicbirinde yoksa en uzunu. */
function pickDefault(w, available) {
  for (const k of available) if (movers(w[k]) > 0) return k;
  return available[available.length - 1];
}

/**
 * Hicbir hissenin kipirdamadigi pencere. Bu NORMAL bir durum (piyasa kapali,
 * ya da seans disi baskilar seyrek) — hata gibi gorunmemeli, ve kullaniciya
 * hareketin OLDUGU pencereye tek dokunusla gecis onerilmeli.
 */
function quietBlock(cur, snap, w, available) {
  const dolu = available.filter((k) => movers(w[k]) > 0);
  const oneri = dolu[0];
  const kapali = !snap.session?.live;

  return `<div class="win-quiet">
    <p><b>${int(cur.n)} hissenin tamamı aynı fiyatta</b> — son
      ${spanText(cur.actualMs)} içinde hiçbirinde yeni işlem baskısı olmamış.</p>
    <p>${kapali
      ? `Piyasa şu an kapalı (${snap.session?.label ?? 'seans dışı'}). Fiyatlar
         seans açılınca hareket etmeye başlar.`
      : 'Seans dışı işlemler seyrek olabiliyor; kısa pencerelerde çoğu hisse hiç baskı görmez.'}
    </p>
    ${oneri
      ? `<button type="button" class="win-jump" data-jump="${oneri}">
           ${label(oneri)} penceresinde hareket var → göster
         </button>`
      : '<p>Hiçbir pencerede hareket yok.</p>'}
  </div>`;
}

function label(k) {
  return LABEL[k]?.[0] ?? k;
}

/** Pencere sureleri — cip metnini ve "ne zaman acilir" hesabini besler. */
const WIN_MS = { m1: 60_000, m5: 300_000, m15: 900_000, h1: 3600_000, h4: 14400_000 };

/**
 * Kapali pencereler icin TEK ve NET aciklama. Onceki surumde cip yalnizca
 * ustu cizili gorunuyordu; mobilde title ipucu de gorunmedigi icin "tiklanmiyor"
 * deneyimi veriyordu — sebebi yazmak sart.
 */
function closedNote(w, meta) {
  const kapali = ORDER.filter((k) => !w[k]);
  if (kapali.length === 0) return '';
  const list = kapali
    .map((k) => `<b>${label(k)}</b> ≈${spanText(Math.max(60_000, OPEN_AT(WIN_MS[k]) - meta.spanMs))} sonra`)
    .join(' · ');
  return `<p class="empty" style="text-align:left;padding:14px 0 0;border-top:1px solid var(--border);margin-top:12px">
    Üstü çizili pencereler için yeterli fiyat geçmişi yok — eksik veriyle sayı
    üretilmiyor. Şu an <b>${spanText(meta.spanMs)}</b>'lık geçmiş var:
    ${list}.${diskNote(meta)}</p>`;
}

/**
 * Kalici disk yoksa pencereler her yeniden baslatmada sifirlanir. Bu, canli
 * ortamda en cok kafa karistiran davranis — soylenmezse "bozuk" gorunuyor.
 */
function diskNote(meta) {
  if (meta.persisted) return '';
  return ` <span style="color:var(--warn)">Kalıcı disk bağlı değil; her yeniden
    başlatmada bu geçmiş sıfırlanıyor.</span>`;
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
  const cur = selected ? snap.windows?.[selected] : null;
  const el = host.querySelector('#win-bars');
  // Sessiz pencerede cubuk yok; aciklama blogu yeniden olculmeye ihtiyac duymaz.
  if (cur && el && movers(cur) > 0) {
    renderBars(/** @type {HTMLElement} */ (el), [...cur.carriers, ...cur.draggers],
      { perSide: host.clientWidth < 560 ? 6 : 8 });
  }
}
