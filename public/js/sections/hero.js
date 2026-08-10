/**
 * Teshis paneli — sitenin varlik sebebi.
 *
 * Buyuk rakam TSI seansi (kullanicinin sectigi tanim: seans disi dahil).
 * Resmi ^NDX rakami hemen altinda KALICI olarak duruyor — gecis anahtari
 * degil, cunku "hangi moddayim?" diye takip edilecek bir durum yaratmak
 * kullaniciyi TV'deki rakamla karsilastirirken yaniltir.
 */

import { pct, pp, pts, pctPlain, int, tone, ppPlain } from '../format.js';

/**
 * @param {HTMLElement} host
 * @param {any} snap
 */
export function renderHero(host, snap) {
  const i = snap.index;
  const b = i.breadth;
  const v = snap.verdict;
  const t = tone(i.changePct);
  const cov = snap.coverage;
  const partial = !!cov?.partial;

  const carriers = [...snap.constituents]
    .filter((c) => c.contribPp > 0)
    .sort((a, b2) => b2.contribPp - a.contribPp)
    .slice(0, 3);

  const level = Math.round(i.syntheticLevel).toLocaleString('tr-TR');

  // Kismi kapsamda buyuk rakam ALT KUMENIN getirisidir, NDX degil — etiket
  // ve alt satir bunu acikca soyler; NDX≈seviye tahmini gosterilmez.
  const label = partial
    ? `Kapsanan ${int(cov.count)}/${int(cov.total)} hisse · TSİ seansı`
    : 'TSİ seansı · seans dışı dahil';
  const sub = partial
    ? (cov.contribPpNdx != null
        ? `endekse yaklaşık katkı ${pp(cov.contribPpNdx)}`
        : 'kısmi kapsam — endeks seviyesi hesaplanamaz')
    : `${pts(i.changePts)} endeks puanı · NDX ≈ ${level}`;
  const official = partial
    ? `<div class="hero-official">Resmî <b>^NDX</b> şu an alınamıyor — fiyatlar
         <b>${cov.venue ?? 'kripto'}</b> perp piyasasından.</div>`
    : officialLine(i);

  host.innerHTML = `
    <div class="hero-grid">
      <div>
        <span class="hero-label">${label}</span>
        <div class="hero-num num-hero ${t}">${pct(i.changePct)}</div>
        <div class="hero-label">${sub}</div>
        ${official}
      </div>
      <div>
        <p class="verdict-title">${v.title}</p>
        <p class="verdict-body">${sentence(snap, carriers)}</p>
        <div class="hero-stats">${stats(i, cov)}</div>
      </div>
    </div>
  `;
}

/** @param {any} i */
function officialLine(i) {
  if (i.officialRegularPct == null) {
    return `<div class="hero-official">Resmî <b>^NDX</b> şu an tik atmıyor (ana seans dışı).</div>`;
  }
  const diff = i.changePct - i.officialRegularPct;
  return `
    <div class="hero-official">
      Resmî <b>^NDX</b> (ana seans): <b class="${tone(i.officialRegularPct)}">${pct(i.officialRegularPct)}</b><br>
      <span style="color:var(--ink-muted)">Aradaki ${ppPlain(Math.abs(diff))} fark gece boşluğundan geliyor.</span>
    </div>`;
}

/**
 * @param {any} snap
 * @param {any[]} carriers
 */
function sentence(snap, carriers) {
  const i = snap.index;
  const b = i.breadth;
  // Metin murekkep token'i giyer, seri rengi degil — renkli bir yazi
  // burada olmayan bir kodlama varmis izlenimi verirdi.
  const names = carriers.map((c) => `<b>${c.s}</b>`).join(', ');

  if (snap.verdict.verdict === 'PARTIAL') {
    const cov = snap.coverage ?? {};
    return `Yahoo erişilemediği için yalnızca <b>${int(cov.count)}</b> büyük hisse ` +
      `izlenebiliyor${cov.weightPct != null ? ` — endeks ağırlığının <b>${pctPlain(cov.weightPct)}</b>'i` : ''}. ` +
      `Bu hisseler birlikte <b class="${tone(i.changePct)}">${pct(i.changePct)}</b> hareket etti` +
      `${cov.contribPpNdx != null ? ` ve endekse yaklaşık <b>${ppPlain(cov.contribPpNdx)}</b> kattı` : ''}. ` +
      `Fiyatlar <b>${cov.venue ?? 'kripto'}</b> perp piyasasından — spot fiyattan sapabilir. ` +
      `Genişlik ("kaç hisse kırmızı") ve eşit ağırlıklı endeks kısmi kapsamda hesaplanmaz.`;
  }

  if (b.traded < 20) {
    return `Bu seansta sadece <b>${int(b.traded)}</b> hisse işlem gördü ` +
      `(${int(b.noTrade)} hissede hiç baskı yok). Genişlik istatistiği ` +
      `piyasa açılana kadar anlamlı olmayacak.`;
  }

  const common =
    `Endeks <b class="${tone(i.changePct)}">${pct(i.changePct)}</b>, ` +
    `ama işlem gören <b>${int(b.traded)}</b> hissenin ` +
    `<b>${pctPlain(b.declinersPctOfTraded)}</b>'si kırmızı. ` +
    `Her hisse eşit sayılsaydı endeks <b class="${tone(i.equalWeightPct)}">${pct(i.equalWeightPct)}</b> olurdu.`;

  switch (snap.verdict.verdict) {
    case 'MASKED_WEAKNESS':
      return `${common} Aradaki <b>${ppPlain(Math.abs(i.divergencePp))}</b> puanlık farkı ` +
        `birkaç hisse taşıyor: yükselişin yarısı sadece <b>${int(i.namesToHalfOfUp)}</b> hisseden ` +
        `geliyor — ${names}.`;
    case 'MASKED_STRENGTH':
      return `Endeks <b class="down">${pct(i.changePct)}</b> ama hisselerin ` +
        `<b>${pctPlain(b.advancersPctOfTraded)}</b>'si yeşil. Eşit ağırlıklı olsaydı ` +
        `endeks <b class="up">${pct(i.equalWeightPct)}</b> olurdu — düşüşü birkaç ağır ` +
        `hisse tek başına yaratıyor.`;
    case 'BROAD_RALLY':
      return `Endeks <b class="up">${pct(i.changePct)}</b> ve yükseliş genişe yayılmış: ` +
        `işlem gören <b>${int(b.traded)}</b> hissenin <b>${pctPlain(b.advancersPctOfTraded)}</b>'si ` +
        `yeşil. Eşit ağırlıklı endeks de <b class="${tone(i.equalWeightPct)}">${pct(i.equalWeightPct)}</b> — ` +
        `bu yükselişi birkaç hisse taşımıyor.`;
    case 'BROAD_SELLOFF':
      return `Endeks <b class="down">${pct(i.changePct)}</b> ve satış genişe yayılmış: ` +
        `hisselerin <b>${pctPlain(b.declinersPctOfTraded)}</b>'si kırmızı. Eşit ağırlıklı ` +
        `endeks <b class="${tone(i.equalWeightPct)}">${pct(i.equalWeightPct)}</b>.`;
    case 'FLAT':
      return `Endeks neredeyse yatay (<b>${pct(i.changePct)}</b>), ama altta hareket var: ` +
        `<b>${int(b.advancers)}</b> hisse yükselirken <b>${int(b.decliners)}</b> hisse düşüyor. ` +
        `Eşit ağırlıklı endeks <b class="${tone(i.equalWeightPct)}">${pct(i.equalWeightPct)}</b>.`;
    default:
      return common;
  }
}

/**
 * @param {any} i
 * @param {any} [cov]
 */
function stats(i, cov) {
  const b = i.breadth;
  if (cov?.partial) {
    // Esit agirlik / ortanca 12 hisse uzerinden yanlis mesaj verir; yalnizca
    // kapsananlar hakkinda durust olan hucreler gosterilir.
    const cells = [
      ['Yükselen / Düşen', `${int(b.advancers)} / ${int(b.decliners)}`, ''],
      ['Kapsanan ağırlık', cov.weightPct != null ? pctPlain(cov.weightPct) : '—', ''],
      ['Endekse katkı', cov.contribPpNdx != null ? pp(cov.contribPpNdx) : '—',
        tone(cov.contribPpNdx ?? 0)],
      ['Yükselişin yarısı', `${int(i.namesToHalfOfUp)} hisse`, ''],
    ];
    return cells.map(([k, v2, cls]) => `
    <div class="stat">
      <span class="k">${k}</span>
      <span class="v num-big ${cls}">${v2}</span>
    </div>`).join('');
  }
  const cells = [
    ['Eşit ağırlıklı endeks', pct(i.equalWeightPct), tone(i.equalWeightPct)],
    ['Ortanca hisse', pct(i.medianPct), tone(i.medianPct)],
    ['Yükselen / Düşen', `${int(b.advancers)} / ${int(b.decliners)}`, ''],
    ['Yükselenlerin ağırlığı', pctPlain(i.upWeight * 100), ''],
    ['Yükselişin yarısı', `${int(i.namesToHalfOfUp)} hisse`, ''],
  ];
  if (i.gapPct != null) {
    cells.push(['Gece / seans içi', `${pct(i.gapPct)} / ${pct(i.rthPct)}`, '']);
  }
  return cells.map(([k, v, cls]) => `
    <div class="stat">
      <span class="k">${k}</span>
      <span class="v num-big ${cls}">${v}</span>
    </div>`).join('');
}
