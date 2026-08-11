import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWikiConstituents, parseIsharesHoldings, splitCsvLine, EXPECTED,
} from '../server/sources/members.js';


/* ---------------- Wikipedia ---------------- */

// S&P sayfasi: Symbol ILK sutun.
const SPX_HTML = `
<p>bla</p>
<table class="wikitable sortable" id="constituents">
<tbody>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td><a href="/x">MMM</a></td><td><a href="/3M">3M</a></td><td>Industrials</td></tr>
<tr><td><a href="/x">BRK.B</a></td><td>Berkshire Hathaway</td><td>Financials</td></tr>
<tr><td><a href="/x">AOS</a></td><td>A. O. Smith</td><td>Industrials</td></tr>
</tbody></table>
<table class="wikitable"><tr><th>Date</th><th>Added</th></tr>
<tr><td>2024-01-01</td><td>ZZZZ</td></tr></table>`;

// Dow sayfasi: Symbol UCUNCU sutun — sabit indeks varsayimi burada patlardi.
const DJI_HTML = `
<table class="wikitable sortable" id="constituents">
<tbody>
<tr><th>Company</th><th>Exchange</th><th>Symbol</th><th>Industry</th></tr>
<tr><td><a href="/a">3M</a></td><td>NYSE</td><td><a href="/b">MMM</a></td><td>Conglomerate</td></tr>
<tr><td>Amgen</td><td>NASDAQ</td><td>AMGN</td><td>Biopharmaceutical</td></tr>
<tr><td>Apple</td><td>NASDAQ</td><td>AAPL</td><td>Information technology</td></tr>
</tbody></table>`;

test('wiki: S&P tablosundan semboller (Symbol ilk sutun)', () => {
  assert.deepEqual(parseWikiConstituents(SPX_HTML), ['MMM', 'BRK.B', 'AOS']);
});

test('wiki: Dow tablosunda Symbol UCUNCU sutun — baslikla bulunur', () => {
  assert.deepEqual(parseWikiConstituents(DJI_HTML), ['MMM', 'AMGN', 'AAPL']);
});

// Uretimde Dow BASARISIZ oldu: sayfada id="constituents" yok ve bilesen
// tablosu ILK tablo degil. Onceki surum ilk tabloyu okuyup cop uretiyordu.
const DJI_GERCEKCI = `
<table class="infobox"><tr><th>Kisaltma</th><td>DJIA</td></tr>
<tr><th>Borsa</th><td>NYSE</td></tr></table>
<h2>Components</h2>
<table class="wikitable sortable">
<tr><th>Company</th><th>Exchange</th><th>Symbol</th><th>Industry</th></tr>
${['MMM','AXP','AMGN','AAPL','BA','CAT','CVX','CSCO','KO','DIS',
   'GS','HD','HON','IBM','JNJ','JPM','MCD','MRK','MSFT','NKE',
   'NVDA','PG','CRM','SHW','TRV','UNH','VZ','V','WMT','DOW']
  .map((t) => `<tr><td>Sirket ${t}</td><td>NYSE</td><td><a href="/x">${t}</a></td><td>Sanayi</td></tr>`)
  .join('')}
</table>
<table class="wikitable"><tr><th>Yil</th><th>Kapanis</th></tr>
<tr><td>2020</td><td>30606</td></tr></table>`;

test('wiki: id yoksa ve bilesen tablosu ilk tablo degilse ARALIKLA bulunur', () => {
  const syms = parseWikiConstituents(DJI_GERCEKCI, EXPECTED.dji);
  assert.equal(syms.length, 30, 'infobox ve tarihce tablosu degil, bilesen tablosu');
  assert.equal(syms[0], 'MMM');
  assert.ok(syms.includes('NVDA'));
});

test('wiki: borsa adlari sembol sanilmaz', () => {
  const syms = parseWikiConstituents(DJI_GERCEKCI, EXPECTED.dji);
  assert.ok(!syms.includes('NYSE'), 'NYSE sembol bicimine uyuyor ama sembol degil');
  assert.ok(!syms.includes('NASDAQ'));
});

test('wiki: hicbir tablo araliga oturmuyorsa BOS doner (cop liste yok)', () => {
  // Guard'in uretimde yaptigi tam olarak buydu: yanlis tabloyu reddetti.
  assert.deepEqual(parseWikiConstituents(DJI_GERCEKCI, [400, 520]), []);
});

test('wiki: yalnizca constituents tablosu okunur, sonraki tablolar degil', () => {
  assert.ok(!parseWikiConstituents(SPX_HTML).includes('ZZZZ'),
    'ikinci tablodaki degerler sizmamali');
});

test('wiki: "Ticker" basligi da kabul edilir', () => {
  const html = `<table id="constituents"><tr><th>Ticker</th><th>Ad</th></tr>
    <tr><td>NVDA</td><td>Nvidia</td></tr></table>`;
  assert.deepEqual(parseWikiConstituents(html), ['NVDA']);
});

test('wiki: baslik yoksa satirdaki ilk sembol-bicimli hucreye dusulur', () => {
  const html = `<table class="wikitable"><tr><td>AAPL</td><td>Apple Inc</td></tr></table>`;
  assert.deepEqual(parseWikiConstituents(html), ['AAPL']);
});

test('wiki: tekrar eden sembol bir kez alinir', () => {
  const html = `<table id="constituents"><tr><th>Symbol</th><th>x</th></tr>
    <tr><td>AAPL</td><td>a</td></tr><tr><td>AAPL</td><td>b</td></tr></table>`;
  assert.deepEqual(parseWikiConstituents(html), ['AAPL']);
});

test('wiki: bozuk/eksik girdi bos dizi', () => {
  assert.deepEqual(parseWikiConstituents(''), []);
  assert.deepEqual(parseWikiConstituents(null), []);
  assert.deepEqual(parseWikiConstituents('<p>tablo yok</p>'), []);
});

/* ---------------- CSV ---------------- */

test('splitCsvLine: tirnak icindeki virgul bolmez', () => {
  assert.deepEqual(splitCsvLine('AAPL,"Apple Inc, Class A",123'),
    ['AAPL', 'Apple Inc, Class A', '123']);
});

test('splitCsvLine: cift tirnak kacisi', () => {
  assert.deepEqual(splitCsvLine('A,"de""mek",1'), ['A', 'de"mek', '1']);
});

/* ---------------- iShares ---------------- */

const IVV_CSV = `iShares Core S&P 500 ETF
Fund Holdings as of,"Aug 08, 2026"
Inception Date,"May 15, 2000"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Shares,Price
NVDA,NVIDIA CORP,Information Technology,Equity,"1,234,567.89",7.50,"1,234,567.89","6,000,000",205.76
AAPL,APPLE INC,Information Technology,Equity,"999,999.00",6.10,"999,999.00","4,500,000",222.22
XTSLA,BLK CSH FND TREASURY SL AGENCY,Cash and/or Derivatives,Money Market,"1,000.00",0.01,"1,000.00","1,000",1.00
BRK.B,BERKSHIRE HATHAWAY INC CLASS B,Financials,Equity,"500,000.00",3.00,"500,000.00","1,200,000",416.67
`;

test('ishares: baslik satiri aranarak bulunur, sabit satir degil', () => {
  const rows = parseIsharesHoldings(IVV_CSV);
  assert.deepEqual(rows.map((r) => r.symbol), ['NVDA', 'AAPL', 'BRK.B']);
});

test('ishares: pay adetleri binlik ayiracindan temizlenir', () => {
  const rows = parseIsharesHoldings(IVV_CSV);
  assert.equal(rows.find((r) => r.symbol === 'NVDA').shares, 6_000_000);
  assert.equal(rows.find((r) => r.symbol === 'BRK.B').shares, 1_200_000);
});

test('ishares: nakit/turev satirlari elenir (endeks uyesi degil)', () => {
  assert.ok(!parseIsharesHoldings(IVV_CSV).some((r) => r.symbol === 'XTSLA'));
});

test('ishares: baslik bulunamazsa bos dizi — sessiz yanlis liste yok', () => {
  assert.deepEqual(parseIsharesHoldings('a,b,c\n1,2,3'), []);
  assert.deepEqual(parseIsharesHoldings(''), []);
  assert.deepEqual(parseIsharesHoldings(null), []);
});

test('ishares: pay adedi gecersizse satir atlanir', () => {
  const csv = 'Ticker,Asset Class,Shares\nAAPL,Equity,-5\nMSFT,Equity,0\nNVDA,Equity,10\n';
  assert.deepEqual(parseIsharesHoldings(csv).map((r) => r.symbol), ['NVDA']);
});

/* ---------------- akil saglik araliklari ---------------- */

test('beklenen uye araliklari kaba bozulmayi yakalar', () => {
  assert.deepEqual(EXPECTED.dji, [25, 35]);
  assert.ok(EXPECTED.spx[0] >= 400 && EXPECTED.spx[1] <= 520);
});
