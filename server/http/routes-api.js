import * as store from '../store.js';
import * as storage from '../storage.js';
import * as history from '../history.js';
import { config } from '../config.js';
import { sessionState } from '../../shared/session.js';
import { rateLimitInfo } from '../sources/yahoo.js';
import { discoverEquityMarkets } from '../sources/crypto.js';
import * as pricetape from '../pricetape.js';
import { fetchWithTimeout } from '../lib/retry.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string,string>} [headers]
 */
function json(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

/**
 * Fixture modunda saat sabitlenmis olabilir; seans hesaplari o ana gore
 * yapilmali, yoksa hafta sonu ekrani gercek saate kayar.
 */
function effectiveNow() {
  const snap = store.get();
  if (config.fixtureMode && config.fixturePinClock && snap) return snap.generatedAtMs;
  return Date.now();
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} eslesip cevaplandiysa true
 */
export async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    const h = store.health();
    const disk = await storage.stats();
    // Healthcheck "surec ayakta ve servis veriyor mu" sorusunu cevaplar,
    // "veri boru hattı ilk turunu bitirdi mi" sorusunu DEGIL. Ikisini
    // karistirmak ilk dagitimda replica'nin hic saglikli olmamasina yol acti:
    // ilk poll 101 chart istegi bekliyor, Railway'in penceresi 60 sn.
    // Gercek durum govdede `ready` alaninda tasiniyor.
    json(res, h.ok ? 200 : 503, {
      ...h,
      stale: h.ageSec != null && h.ageSec * 1000 > config.staleAfterMs,
      mode: config.fixtureMode ? `fixture:${config.fixtureVariant}` : 'live',
      rateLimit: rateLimitInfo(),
      volume: disk,
      // Pencere bolumunun ne kadar geriye gidebildigi — "4 saat neden kapali?"
      // sorusu tahminle degil bu alanla cevaplanir.
      tape: pricetape.info(),
    });
    return true;
  }

  if (p === '/api/session') {
    json(res, 200, sessionState(effectiveNow()));
    return true;
  }

  if (p === '/api/snapshot') {
    const snap = store.get();
    if (!snap) {
      json(res, 503, { error: 'veri henuz hazir degil' });
      return true;
    }
    const etag = `"${snap.generatedAtMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag });
      res.end();
      return true;
    }
    json(res, 200, { ...snap, ageSec: store.ageSec() }, { ETag: etag });
    return true;
  }

  if (p === '/api/intraday') {
    const snap = store.get();
    const day = url.searchParams.get('day') || snap?.tsiDay;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      json(res, 400, { error: 'gecersiz gun' });
      return true;
    }
    const series = await history.getIntraday(day);
    // Disk yoksa ya da gun yeni basladiysa, grafik "veri yok" yerine en azindan
    // su anki noktayi gostersin.
    if (series.length === 0 && snap && snap.tsiDay === day) {
      series.push(history.intradayRow(snap));
    }
    json(res, 200, { day, series });
    return true;
  }

  if (p === '/api/discover') {
    // Teshis ucu: Hyperliquid ve Binance'te NASDAQ-100 sembolleriyle eslesen
    // piyasa var mi, hangisi daha hacimli? Tahmin etmek yerine veriye sor.
    // Tarayicidan acilabilsin diye GET.
    try {
      const seed = JSON.parse(
        readFileSync(join(ROOT, 'data', 'holdings.seed.json'), 'utf8')
      );
      const symbols = seed.holdings.map((h) => h.s);
      json(res, 200, await discoverEquityMarkets(symbols));
    } catch (err) {
      json(res, 500, { error: String(err?.message ?? err) });
    }
    return true;
  }

  if (p === '/api/tv-probe') {
    // Teshis: TradingView screener bu ag konumundan calisiyor mu, hangi kolon
    // seti geciyor, uzatilmis seans alanlari dolu mu? Ornek olarak 3 sembol.
    try {
      const { fetchTradingView, toSessionRow } = await import('../sources/tradingview.js');
      const st = sessionState(effectiveNow());
      const r = await fetchTradingView(['AAPL', 'NVDA', 'MSFT', 'QQQ']);
      json(res, 200, {
        ok: true,
        url: r.url,
        uzatilmisSeans: r.extended,
        faz: st.phase,
        adet: r.map.size,
        ornek: [...r.map].map(([s, rec]) => ({
          s, ...rec, tsi: toSessionRow(rec, st.phase, true),
        })),
      });
    } catch (err) {
      json(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return true;
  }

  if (p === '/api/members-probe') {
    // Teshis: S&P 500 ve Dow 30 uye listeleri hangi kaynaktan gelebiliyor?
    // nasdaq.com olcuidu ve yalnizca nasdaq100 veriyor; bu uc geri kalan iki
    // kaynagi (iShares IVV CSV, Wikipedia) sunucunun kendi ag konumundan
    // dener ve KAC UYE dondugunu raporlar.
    const m = await import('../sources/members.js');
    const sonuc = {};
    for (const key of ['spx', 'dji']) {
      const r = await m.fetchMembers(/** @type {any} */ (key)).catch((err) => ({
        hata: String(err?.message ?? err).slice(0, 140),
      }));
      sonuc[key] = r?.members
        ? {
          ok: true, kaynak: r.source, uye: r.members.length,
          payAdediVar: r.members.filter((x) => x.shares > 0).length,
          ornek: r.members.slice(0, 8).map((x) => x.symbol),
          beklenen: m.EXPECTED[key],
        }
        : { ok: false, ...(r ?? {}), beklenen: m.EXPECTED[key] };
    }
    json(res, 200, {
      not: 'ok:true ve uye beklenen aralikta ise o endeks acilabilir. ' +
        'payAdediVar > 0 ise agirlik GERCEK pay adedinden hesaplanir; ' +
        '0 ise piyasa degerinden turetilir (Dow icin gerekmez).',
      sonuc,
    });
    return true;
  }

  if (p === '/api/index-probe') {
    // Teshis: S&P 500 ve Dow 30 UYE LISTELERI nasdaq.com'un ayni ucundan
    // geliyor mu? Slug adlari belgeli degil, o yuzden birkac aday denenir.
    //
    // Bu ucun varlik sebebi tek bir kural: uye listeleri model bilgisinden
    // YAZILMAZ. 503 sembollük bir listeyi ezberden dokmek dogrulanamaz bir
    // hata kaynagi olurdu. Liste kaynaktan gelmiyorsa o endeks acilmaz.
    const { fetchIndexList } = await import('../sources/nasdaq.js');
    const adaylar = [
      ['nasdaq100', 'NASDAQ-100 (kontrol — bu calisiyor olmali)'],
      ['sp500', 'S&P 500'],
      ['spx', 'S&P 500 (alternatif slug)'],
      ['dowjones', 'Dow Jones 30'],
      ['dow-jones', 'Dow Jones 30 (alternatif slug)'],
      ['djia', 'Dow Jones 30 (alternatif slug)'],
    ];
    const sonuc = [];
    for (const [slug, aciklama] of adaylar) {
      try {
        const r = await fetchIndexList(slug, 600);
        const ilk = r.rows[0];
        sonuc.push({
          slug, aciklama, ok: r.rows.length > 0, uye: r.rows.length,
          // Piyasa degeri alani S&P icin SART: pay adedi ondan turetiliyor.
          piyasaDegeriVar: r.rows.filter((x) => x.marketCap > 0).length,
          ornek: r.rows.slice(0, 5).map((x) => x.symbol),
          ilkSatirAlanlari: ilk ? Object.keys(
            (r.raw?.data?.data?.rows ?? r.raw?.data?.rows ?? [])[0] ?? {}
          ) : [],
        });
      } catch (err) {
        sonuc.push({ slug, aciklama, ok: false, hata: String(err?.message ?? err).slice(0, 120) });
      }
      await new Promise((r2) => setTimeout(r2, 400));
    }
    json(res, 200, {
      not: 'uye > 0 VE piyasaDegeriVar ~ uye olan slug kullanilabilir. ' +
        'Dow icin piyasa degeri gerekmez (fiyat agirlikli).',
      sonuc,
    });
    return true;
  }

  if (p === '/api/nasdaq-probe') {
    // Teshis: nasdaq.com liste ucu ne donduruyor? Ham cevabin ilk 600
    // karakteri + kac satir ayristirildigi. 403 gorursek datamerkezi engeli.
    try {
      const r = await fetchWithTimeout(
        'https://api.nasdaq.com/api/quote/list-type/nasdaq100?limit=110',
        { timeoutMs: 15_000, headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/',
          'Sec-Fetch-Site': 'same-site',
        } });
      const body = await r.text();
      let parsed = 0;
      try {
        const { parseNasdaqList } = await import('../sources/nasdaq.js');
        parsed = parseNasdaqList(JSON.parse(body)).length;
      } catch { /* ayristirilamadi */ }
      json(res, 200, { status: r.status, parsedRows: parsed, bodyHead: body.slice(0, 600) });
    } catch (err) {
      json(res, 200, { status: null, error: String(err?.message ?? err) });
    }
    return true;
  }

  if (p === '/api/stooq-probe') {
    // Teshis: stooq'un HANGI bicimi kabul ettigini (ya da bulut IP'sini
    // komple kesip kesmedigini) sunucunun kendi ag konumundan olcer.
    // Uretimde 10 sembollu virgullu istek bile 404 aldi; tahmin bitti,
    // olcum basladi. Tek dokunusla calisir, 6 istek atar.
    const S = 'https://stooq.com';
    const tests = [
      ['tek-sembol', `${S}/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv`],
      ['virgul-2', `${S}/q/l/?s=aapl.us,msft.us&f=sd2t2ohlcv&h&e=csv`],
      ['arti-2', `${S}/q/l/?s=aapl.us+msft.us&f=sd2t2ohlcv&h&e=csv`],
      ['f-siz', `${S}/q/l/?s=aapl.us&e=csv`],
      ['gunluk-seri', `${S}/q/d/l/?s=aapl.us&d1=20260801&d2=20260810&i=d`],
      ['ana-sayfa', `${S}/`],
    ];
    const results = [];
    for (const [name, testUrl] of tests) {
      try {
        const r = await fetchWithTimeout(testUrl, { timeoutMs: 10_000 });
        const body = (await r.text()).slice(0, 140).replaceAll('\n', ' ⏎ ');
        results.push({ name, status: r.status, body });
      } catch (err) {
        results.push({ name, status: null, error: String(err?.message ?? err).slice(0, 100) });
      }
      await new Promise((r2) => setTimeout(r2, 300));
    }
    json(res, 200, {
      note: 'status 200 + CSV govdesi goren bicim dogru bicimdir. Hepsi 404 ise stooq bu IP araligini kesiyor demektir.',
      results,
    });
    return true;
  }

  if (p === '/api/history') {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    json(res, 200, await history.getHistory(days));
    return true;
  }

  return false;
}
