/**
 * Canli yolun CEVRIMDISI test edilebilen parcalari.
 *
 * Ag cagrilari bu container'dan yapilamiyor (piyasa host'lari 403), ama
 * ayristirma ve secim mantigi saf fonksiyonlar — ve canli yolun en cok hata
 * yapilan yeri tam olarak burasi. Kayitli ornek yukler elle yazildi.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCurrent } from '../server/sources/yahoo.js';
import { parseCsv, parseHoldings } from '../server/sources/invesco.js';

const SESSION_START = Date.parse('2026-08-10T21:00:00Z'); // TSI 11 Agu 00:00
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

/* ---------------- pickCurrent ---------------- */

test('ana seans fiyati secilir', () => {
  const got = pickCurrent({
    regularMarketPrice: 184.2, regularMarketTime: sec('2026-08-11T17:00:00Z'),
  }, SESSION_START);
  assert.equal(got?.price, 184.2);
  assert.equal(got?.kind, 'REGULAR');
});

test('en YENI baski secilir, marketState\'e bakilmaz', () => {
  // marketState belgelenmemis degerler alabiliyor (POSTPOST, PREPRE...),
  // o yuzden ona gore dallanmiyoruz.
  const got = pickCurrent({
    marketState: 'POSTPOST',
    regularMarketPrice: 100, regularMarketTime: sec('2026-08-11T20:00:00Z'),
    postMarketPrice: 103, postMarketTime: sec('2026-08-11T22:30:00Z'),
  }, SESSION_START);
  assert.equal(got?.price, 103);
  assert.equal(got?.kind, 'POST');
});

test('ONCEKI aksamdan sarkan post-market fiyati REDDEDILIR', () => {
  // Sabah pre-market sirasinda Yahoo sik sik onceki aksamin postMarketPrice'ini
  // tasir; elenmezse seans getirisi tamamen yanlis cikar.
  const got = pickCurrent({
    preMarketPrice: 181, preMarketTime: sec('2026-08-11T11:30:00Z'),
    postMarketPrice: 999, postMarketTime: sec('2026-08-10T23:30:00Z'), // seans oncesi
  }, SESSION_START);
  assert.equal(got?.price, 181);
  assert.equal(got?.kind, 'PRE');
});

test('tum baskilar seans oncesindense null doner (islem yok)', () => {
  const got = pickCurrent({
    regularMarketPrice: 100, regularMarketTime: sec('2026-08-10T19:00:00Z'),
    postMarketPrice: 101, postMarketTime: sec('2026-08-10T20:30:00Z'),
  }, SESSION_START);
  assert.equal(got, null);
});

test('gecersiz/eksik alanlar elenir', () => {
  assert.equal(pickCurrent({}, SESSION_START), null);
  assert.equal(pickCurrent({ regularMarketPrice: 0, regularMarketTime: sec('2026-08-11T17:00:00Z') }, SESSION_START), null);
  assert.equal(pickCurrent({ regularMarketPrice: 10, regularMarketTime: null }, SESSION_START), null);
  assert.equal(pickCurrent(null, SESSION_START), null);
});

/* ---------------- CSV ---------------- */

test('CSV: tirnakli alanlar ve gomulu virgul', () => {
  const rows = parseCsv('a,b,c\n1,"iki, uc",4\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'iki, uc', '4']]);
});

test('CSV: kacisli tirnak ve CRLF', () => {
  const rows = parseCsv('x,y\r\n"1""2",3\r\n');
  assert.deepEqual(rows, [['x', 'y'], ['1"2', '3']]);
});

/** 85 satirlik gecerli bir holdings CSV'si uretir. */
function makeCsv(extraRows = []) {
  const head = 'Fund Ticker,Security Identifier,Holding Ticker,Shares/Par,Name,Weight';
  const body = Array.from({ length: 85 }, (_, i) =>
    `QQQ,ID${i},SYM${i},"1,000,${String(i).padStart(3, '0')}",Sirket ${i},${(1 + i / 100).toFixed(4)}`);
  return [head, ...body, ...extraRows].join('\n');
}

test('holdings: Shares/Par sutunu okunur, binlik ayirici temizlenir', () => {
  const { holdings } = parseHoldings(makeCsv());
  assert.equal(holdings.length, 85);
  assert.equal(holdings[0].s, 'SYM0');
  assert.equal(holdings[0].shares, 1000000);
  assert.equal(holdings[0].n, 'Sirket 0');
  assert.equal(holdings[0].publishedWeight, 1);
});

test('holdings: nakit / vadeli satirlari elenir', () => {
  const { holdings } = parseHoldings(makeCsv([
    'QQQ,CASH,-,"5,000",US DOLLARS,0.12',
    'QQQ,FUT,NQ ESU6 INDEX,"12",E-MINI NASDAQ FUTURE,0.05',
    'QQQ,X,,"7",Sembolsuz,0.01',
  ]));
  assert.equal(holdings.length, 85, 'yalnizca gecerli hisse sembolleri kalmali');
  assert.ok(!holdings.some((h) => h.s === '-'));
});

test('holdings: sutun adlari degisirse anlasilir hata verir', () => {
  assert.throws(
    () => parseHoldings('Foo,Bar\n1,2\n'),
    /sutunlari taninmadi/
  );
});

test('holdings: beklenenden az hisse gelirse reddedilir', () => {
  // Sessizce eksik listeyle devam etmek agirliklari bozar; yuksek sesle
  // basarisiz olup yedek zincire dusmek dogrusu.
  const short = makeCsv().split('\n').slice(0, 40).join('\n');
  assert.throws(() => parseHoldings(short), /beklenenden az/);
});
