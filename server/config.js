import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, dflt = false) =>
  v == null || v === '' ? dflt : v === '1' || v.toLowerCase?.() === 'true';
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export const config = {
  port: num(process.env.PORT, 3000),
  host: '0.0.0.0',

  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 5 * 60_000),

  /** Yahoo'ya hic cikilmaz; data/fixtures servis edilir. */
  fixtureMode: bool(process.env.FIXTURE_MODE),
  fixtureVariant: process.env.FIXTURE_VARIANT || 'regular',
  /**
   * Fixture'in kendi `nowUtc`'sini saat olarak kullan. Hafta sonu / gece /
   * tatil ekranlarini gercek saati beklemeden gorebilmek icin.
   */
  fixturePinClock: bool(process.env.FIXTURE_PIN_CLOCK, true),

  /**
   * Canli cekim basarisiz olursa fixture'a dus. URETIMDE KAPALI OLMALI —
   * bozuk bir deploy sessizce sahte fiyat gostermektense gorunur sekilde
   * basarisiz olsun.
   */
  allowFixtureFallback: bool(process.env.ALLOW_FIXTURE_FALLBACK),

  /** Railway volume baglayinca otomatik gelir. */
  dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, '.data'),

  logLevel: process.env.LOG_LEVEL || 'info',

  /** Veriyi "bayat" saymaya baslama esigi (UI rozeti icin). */
  staleAfterMs: num(process.env.STALE_AFTER_MS, 12 * 60_000),

  /** Gecmis budama. */
  retainIntradayDays: num(process.env.RETAIN_INTRADAY_DAYS, 365),
  retainDailyDays: num(process.env.RETAIN_DAILY_DAYS, 180),
};

export const isProd = process.env.NODE_ENV === 'production';
