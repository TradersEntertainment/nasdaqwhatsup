/**
 * Ham satirlardan yayina hazir anlik goruntuyu kurar.
 *
 * Kural: BOZUK ANLIK GORUNTU ASLA YAYINLANMAZ. Once kurulur, sonra degismezler
 * dogrulanir; ancak temizse store'a atomik takas edilir. Aksi halde bir onceki
 * goruntu servis edilmeye devam eder.
 */

import { buildIndexMetrics, checkInvariants } from '../../shared/metrics.js';
import { sessionState } from '../../shared/session.js';
import { classify } from '../../shared/verdict.js';

/**
 * @param {object} input
 * @param {any[]} input.rows
 * @param {number} input.ndxBase
 * @param {number} input.nowUtc
 * @param {number|null} [input.officialRegularPct]
 * @param {number|null} [input.officialRegularLevel]
 * @param {object} [input.quality]
 * @param {number} [input.minConstituents]
 * @returns {{snapshot: any, errors: string[]}}
 */
export function buildSnapshot({
  rows,
  ndxBase,
  nowUtc,
  officialRegularPct = null,
  officialRegularLevel = null,
  quality = {},
  minConstituents = 85,
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
    verdict: classify(m.index),
    index: m.index,
    constituents,
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
      warnings,
    },
  };

  return { snapshot, errors };
}
