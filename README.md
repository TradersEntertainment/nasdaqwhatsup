# Nasdaq'ı Kim Taşıyor?

Nasdaq yeşil görünürken takip ettiğiniz hisselerin çoğu kırmızıysa, bu bir
yanılsama değil. NASDAQ-100 **piyasa değeri ağırlıklı** bir endeks: NVDA tek
başına ~%9 ağırlığa sahipken sıradaki 50 hissenin toplamı bunun altında
kalabiliyor. Birkaç mega-cap yükselirken 60+ hisse düşebilir ve endeks yine de
yeşil kapanır.

Bu site o dağılımı tek bakışta okunur hale getiriyor. Merkezdeki soru:
**endeksin bugünkü hareketini kim üretti?**

![Pano](screenshots/kapak.png)

---

## Ne gösteriyor

| Bölüm | Cevapladığı soru |
|---|---|
| **Teşhis** | Endeks ne yaptı, kaç hisse kırmızı, eşit ağırlıklı olsaydı ne olurdu |
| **Endeksi kim taşıyor** | Her hissenin endeks hareketine kattığı puan (ıraksayan çubuklar) |
| **Konsantrasyon** | Yükselişin ne kadarı ilk 5 hisseden geliyor |
| **Sayı mı, ağırlık mı?** | Aynı piyasa iki ölçüyle: hisse sayısı vs endeks ağırlığı |
| **Gün içi ıraksama** | Ağırlıklı endeks ile eşit ağırlıklı endeksin gün boyunca ayrışması |
| **Ağırlık haritası** | Kutu alanı = ağırlık, renk = getiri (treemap) |
| **Taşıyıcıları çıkarırsak** | İlk N taşıyıcı olmasaydı endeks ne olurdu |
| **Tüm hisseler** | 100 hissenin tamamı, sıralanabilir tablo |
| **Son 30 seansın taşıyıcıları** | Uzun vadede endeksi en çok kim taşıyor |

---

## Hesaplama

**Seans.** TSİ 00:00–24:00, **seans dışı (pre/after-market) işlemler dahil.**
Türkiye sabit UTC+3 olduğu için TSİ gece yarısı her zaman **21:00 UTC**'dir.
Bu sınır ABD'de yazın 17:00 ET'ye, kışın 16:00 ET'ye denk gelir — yani kışın
TSİ günü tam olarak kapanış-kapanış olurken, yazın pencere bir saat
after-hours'a kayar.

**Baz fiyat.** TSİ gece yarısından *kesinlikle önceki* son işlem baskısı
(seans dışı baskılar dahil).

**Katkı.** NDX gün içi sabit bölenli modifiye kap-ağırlıklı bir endeks:

```
NDX_t / NDX_baz = 1 + Σ wᵢ·rᵢ
```

Bir hissenin katkısı `wᵢ·rᵢ`; bütün katkılar toplandığında endeks hareketini
**birebir** verir. `^NDX` seans dışında tik atmadığı için TSİ seansının endeks
hareketi bu özdeşlikten sentezlenir — tahmin değil, endeksin kendi tanımı.

Ağırlıklar **baz fiyattan** türetilir (`wᵢ = payAdediᵢ·bazᵢ / Σ`), önceki
kapanıştan değil; aksi halde yazın özdeşlik sessizce bozulur.

**Resmî rakamla fark.** TV'deki NDX yüzdesi yalnızca ana seansı kapsar;
buradaki gece boşluğunu da içerir. İkisi de hero panelinde yan yana durur.

---

## Çalıştırma

Node 22+, **npm bağımlılığı yok.**

```bash
# Örnek veriyle (bu ortamda tek yol — aşağıya bakın)
npm run fixture            # örnek veri üret
npm run seed-history       # geçmiş bileşenleri için sahte geçmiş
FIXTURE_MODE=1 npm start   # http://localhost:3000

npm test                   # 47 test — matematik, seans, ayrıştırma
npm run doctor             # canlı veri yolunun her adımını dener ve raporlar
npm run shoot              # her durumun ekran görüntüsü (Playwright)
```

### Bu geliştirme ortamında canlı veri çalışmaz

Container'ın kurumsal çıkış politikası **tüm piyasa verisi host'larını 403 ile
engelliyor** (Yahoo, Invesco, Stooq, Finnhub, TwelveData). `npm run doctor`
bunu saniyeler içinde gösterir. Canlı yol yalnızca Railway'de çalışır; bu
yüzden fixture modu kalıcı bir özellik, geçici bir çözüm değil.

---

## Railway'e kurulum

1. Repoyu Railway'e bağlayın. Nixpacks Node'u otomatik algılar; Dockerfile
   gerekmiyor. `PORT` Railway tarafından enjekte edilir.
2. ⚠️ **Servisi ABD bölgesine alın.** AB çıkış IP'si Yahoo'nun
   `guce.yahoo.com` onay yönlendirmesini tetikler ve crumb el sıkışmasını
   bozar. Kod bunu algılayıp gürültülü log basar ve yedek yola düşer.
3. Bir **volume** bağlayın (örn. `/data`). Railway
   `RAILWAY_VOLUME_MOUNT_PATH`'i otomatik verir. Volume olmadan da site
   çalışır; sadece geçmiş ve gün içi seri birikmez.
4. Ortam değişkeni gerekmez — API anahtarı yok. `.env.example`'daki ayarlar
   isteğe bağlı.
5. Healthcheck: `/api/health`.

### İlk dağıtımdan sonra kontrol

```bash
curl https://<uygulamanız>/api/health
curl https://<uygulamanız>/api/snapshot | jq '.quality, .index.changePct, .index.trackingErrorPp'
```

- `quality.source == "yahoo"` → canlı veri akıyor.
- `quality.weightsSource == "invesco"` → gerçek ağırlıklar okundu.
  `"bundled-approx"` görüyorsanız Invesco'ya erişilememiş; site çalışır ama
  ağırlıklar yaklaşıktır ve UI bunu söyler.
- Ana seansta `trackingErrorPp` küçük (|Δ| < 0,15) olmalı. Büyükse ağırlıklar
  eskimiş demektir.

---

## Mimari

Tek uzun ömürlü Node süreci. Sıfır bağımlılık, sıfır derleme adımı.

```
poller (5 dk)  ──► Yahoo v7 toplu kotasyon (3 istek)  ──┐
baz işi (1/gün)──► Yahoo v8 chart (101 istek)         ──┼──► store ──► SSE + /api
ağırlık (1/gün)──► Invesco QQQ CSV                    ──┘         └──► volume
```

5 dakikalık kadansı sürdürülebilir kılan şey iki katmanlılık: pahalı
sembol-başına yayılım günde 288 değil **1** kez çalışıyor.

```
shared/     matematik + seans mantığı — SUNUCU VE TARAYICI ORTAK, tek kaynak
server/     http, poller, depolama, veri kaynakları
public/     vanilya ES modülleri, el yazımı SVG grafikler
data/       ağırlık seed'i + örnek veri
scripts/    fixture, sahte geçmiş, doctor, ekran görüntüsü
test/       47 test
```

`shared/` hem Node hem tarayıcı tarafından import edilir (`/shared/` altına
mount edilir) — kopya yok, derleme yok.

**Dayanıklılık.** Bozuk anlık görüntü asla yayınlanmaz: kurulur, değişmezleri
doğrulanır (`Σw = 1`, `Σ katkı = endeks hareketi`), sonra atomik takas edilir.
Bir kaynak düşerse site bozulmaz, körelir — ve neyin köreldiğini üstteki
uyarı bandında **söyler**.

---

## Renk seçimi

Yükseliş/düşüş renkleri göz kararıyla değil, renk körlüğü simülasyonuyla
ölçülerek seçildi:

| Çift | Deuteranopi ΔE | Sonuç |
|---|---|---|
| Klasik finans yeşili/kırmızısı `#39D353` / `#FF5C5C` | **6,0** | çöküyor — renk körü için fiilen aynı renk |
| Lime'a kaydırılmış `#A8F03C` / `#FF5A5A` | **18,7** | ✓ |

İstenen neon-lime estetiği aynı zamanda erişilebilir olan seçim çıktı. Ayrıca
renk hiçbir yerde tek sinyal değil: konum (taşıyanlar sağda, çekenler solda),
açık `+/−` işaretleri ve her grafiğin tablo ikizi eşlik ediyor.

---

## Bilinen sınırlar

- **Yahoo resmî olmayan bir API.** Katmanlı yedekler var (crumb düşerse v8
  chart yolu, ağırlık kaynağı düşerse önbellek → seed), ama kalıcı çözüm
  anahtarlı bir sağlayıcı olurdu.
- **`data/holdings.seed.json` yaklaşıktır** — model bilgisinden yazıldı,
  canlı bir kaynaktan çekilmedi. Invesco'ya ilk başarılı erişimde tamamen
  değiştirilir. O ana kadar UI "yaklaşık ağırlıklar" uyarısı gösterir.
- **Tatil takvimi 2028 sonunda tükeniyor** (`shared/holidays.js`), elle
  güncellenmeli.
- **Canlı veri yolu bu ortamda test edilemedi.** Ayrıştırma ve seçim mantığı
  (`pickCurrent`, CSV ayrıştırıcı) kayıtlı örnek yüklerle test edildi; ağ
  katmanı yalnızca Railway'de doğrulanabilir.

Yatırım tavsiyesi değildir.
