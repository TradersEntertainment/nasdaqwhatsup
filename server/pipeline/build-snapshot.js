/**
 * Ham satirlardan yayina hazir anlik goruntuyu kurar.
 *
 * Kural: BOZUK ANLIK GORUNTU ASLA YAYINLANMAZ. Once kurulur, sonra degismezler
 * dogrulanir; ancak temizse store'a atomik takas edilir. Aksi halde bir onceki
 * goruntu servis edilmeye devam eder.
 */

import { buildIndexMetrics, checkInvariants } from '../../shared/metrics.js';
import { sessionState } from '../../shared/session.js';
import { classify, VERDICT_META } from '../../shared/verdict.js';
import { buildWindows } from '../../shared/windows.js';

/**
 * @param {object} input
 * @param {any[]} input.rows
 * @param {number} input.ndxBase
 * @param {number} input.nowUtc
 * @param {number|null} [input.officialRegularPct]
 * @param {number|null} [input.officialRegularLevel]
 * @param {object} [input.quality]
 * @param {object|null} [input.coverage] kismi-kapsam bilgisi (crypto yolu)
 * @param {number} [input.minConstituents]
 * @param {{t: number, p: Record<string, number>}[]} [input.tape] fiyat bandi
 * @param {boolean} [input.tapePersisted] bant diske yaziliyor mu
 * @param {Record<string, any>} [input.earnings] sembol -> bilanco kaydi
 * @returns {{snapshot: any, errors: string[]}}
 */
export function buildSnapshot({
  rows,
  ndxBase,
  nowUtc,
  officialRegularPct = null,
  officialRegularLevel = null,
  quality = {},
  coverage = null,
  minConstituents = 85,
  tape = [],
  tapePersisted = false,
  earnings = {},
}) {
  const session = sessionState(nowUtc);

  const m = buildIndexMetrics({
    rows,
    ndxBase,
    sessionStartUtc: session.sessionStartUtc,
    officialRegularPct,
    officialRegularLevel,
  });

  const errors = checkInvariants(m, { minConstituents });

  const warnings = [...(quality.warnings ?? [])];
  if (m.index.trackingErrorPp !== null && Math.abs(m.index.trackingErrorPp) > 0.15) {
    // Sentetik ana seans hareketi resmi ^NDX'ten uzaklastiysa agirliklar eskimis
    // demektir. Olumcul degil ama gorunur olmali.
    warnings.push('weights-stale');
  }
  if (m.dropped.length) warnings.push('dropped-symbols');

  // Degismezler DOGRULANDIKTAN SONRA ondalik kirpma. Tam hassasiyetli JSON
  // mobilde bosuna ~40% daha buyuk; kirpma sadece tel uzerindeki gosterimi
  // etkiler, hesaplarin hicbirine girmez.
  const round = (v, d) => (v == null ? v : +v.toFixed(d));
  const constituents = m.constituents.map((c) => ({
    ...c,
    earn: earnings[c.s] ?? null,
    w: round(c.w, 7),
    price: round(c.price, 4),
    baseline: round(c.baseline, 4),
    changePct: round(c.changePct, 4),
    contribPp: round(c.contribPp, 5),
    contribPts: round(c.contribPts, 3),
    gapPct: round(c.gapPct, 4),
    rthPct: round(c.rthPct, 4),
    sharePct: round(c.sharePct, 3),
    shareOfNetPct: round(c.shareOfNetPct, 3),
  }));

  // Kismi kapsamda genislik-temelli hukumler gecersiz: 12 hisseyle QUIET ya
  // da MASKED_* uretmek yaniltir. Hukum PARTIAL'a sabitlenir ve kapsanan
  // agirligin endekse yaklasik katkisi hesaplanir:
  //   Σ w_orig·r = altKumeGetirisi × kapsananAgirlikOrani
  let verdict = classify(m.index);
  if (coverage?.partial) {
    verdict = { verdict: 'PARTIAL', ...VERDICT_META.PARTIAL };
    if (coverage.weightPct != null) {
      coverage = {
        ...coverage,
        contribPpNdx: +(m.index.changePct * (coverage.weightPct / 100)).toFixed(3),
      };
    }
  }

  const snapshot = {
    generatedAt: new Date(nowUtc).toISOString(),
    generatedAtMs: nowUtc,
    tsiDay: session.tsiDate,
    session: {
      phase: session.phase,
      label: session.label,
      live: session.live,
      tsiDate: session.tsiDate,
      usDate: session.usDate,
      isTradingDay: session.isTradingDay,
      halfDay: session.halfDay,
      tsiClock: session.tsiClock,
      etOffsetHours: session.etOffsetHours,
      sessionStartUtc: session.sessionStartUtc,
      sessionEndUtc: session.sessionEndUtc,
      resetAtUtc: session.resetAtUtc,
      nextPhaseAtUtc: session.nextPhaseAtUtc,
      nextPhaseLabel: session.nextPhaseLabel,
    },
    verdict,
    coverage,
    index: m.index,
    constituents,
    // Pencere katkilari: "son 1 dk / 5 dk / 15 dk / 1 sa / 4 sa'te endeksi ne
    // yukseltti". Bant yeterince geriye gitmiyorsa ilgili pencere null kalir —
    // 2 dakikalik veriyle "son 4 saat" uydurulmaz.
    // Ham `rows` kullanilir (turetilmis bilesenler degil): pay adetleri
    // burada zaten dogru olcekte ve pencere agirliklari o adetlerle PENCERE
    // BASINDAKI fiyattan yeniden hesaplanir.
    windows: buildWindows({ frames: tape, rows, nowMs: nowUtc, ndxBase, topN: 8 }),
    // Kapali pencerelerin SEBEBI: bant ne kadar geriye gidiyor. Bu olmadan
    // arayuz "tiklanmiyor" demekten oteye gecemiyor.
    windowsMeta: {
      frames: tape.length,
      spanMs: tape.length ? Math.max(0, nowUtc - tape[0].t) : 0,
      persisted: tapePersisted,
    },
    earningsSoon: Object.entries(earnings)
      .map(([s, e]) => ({ s, ...e }))
      .sort((a, b) => a.inDays - b.inDays || a.s.localeCompare(b.s)),
    counterfactual: m.counterfactual.map((c) => ({
      removeTop: c.removeTop,
      changePct: round(c.changePct, 4),
      naivePct: round(c.naivePct, 4),
    })),
    quality: {
      source: quality.source ?? 'unknown',
      weightsSource: quality.weightsSource ?? null,
      weightsAsOf: quality.weightsAsOf ?? null,
      missing: quality.missing ?? [],
      dropped: m.dropped,
      consecutiveFailures: quality.consecutiveFailures ?? 0,
      clockPinned: quality.clockPinned ?? false,
      warnings,
    },
  };

  return { snapshot, errors };
}
