/**
 * Turn one parsed IES file into the compact metric bundle stored in
 * `ies_metrics.metrics` (jsonb). Everything here is a thin call into the
 * VERBATIM-ported WIES photometry kernels in @wac/shared — no new math.
 *
 * BUG/UGR are gated by `metricsAvailable`: rotationally symmetric (single
 * horizontal plane) and non-Type-C files can't produce a meaningful BUG/UGR,
 * so those fields are null and the caveat surfaces via the parse warnings.
 * We precompute ONE canonical UGR (default reference room) — the expensive
 * full CIE-117 table is deliberately skipped in precompute.
 */

import {
  M_PER_FT,
  beamAngles,
  computeBUG,
  computeUGR,
  coneOfLightAt,
  efficacy,
  metricsAvailable,
  parseIES,
  spacingCriterion,
  totalLuminaireLumens,
  zonalSummary,
  type IESParseResult,
  type IESParseWarning,
} from "@wac/shared";

/** Mounting heights (feet) at which to precompute the cone-of-light row. */
const CONE_HEIGHTS_FT = [8, 9, 10];

export interface MetricBundle {
  format: string;
  photometricType: string;
  lumens: number;
  inputWatts: number;
  efficacy: number;
  maxCandela: number;
  maxAngle: number;
  beam: {
    beamAngle: number | null;
    fieldAngle: number | null;
    beamC0: number | null;
    beamC90: number | null;
    fieldC0: number | null;
    fieldC90: number | null;
  };
  spacingCriterion: {
    plane0: number | null;
    plane90: number | null;
    average: number | null;
    symmetric: boolean;
  };
  zonal: { total: number; downward: number; upward: number };
  bug: { rating: string; B: number; U: number; G: number } | null;
  ugr: { value: number } | null;
  cone: {
    mountingHeightM: number;
    mountingHeightFt: number;
    beamDiaM: number;
    fieldDiaM: number;
    centerFc: number;
    centerLux: number;
  }[];
}

export interface BuiltMetrics {
  metrics: MetricBundle;
  warnings: IESParseWarning[];
}

/** Build the metric bundle from an already-parsed IES result. */
export function buildMetricBundle(ies: IESParseResult): MetricBundle {
  const ba = beamAngles(ies);
  const sc = spacingCriterion(ies);
  const zs = zonalSummary(ies);
  const avail = metricsAvailable(ies);

  const bug = avail.bug
    ? (() => {
        const b = computeBUG(ies);
        return { rating: b.rating, B: b.B, U: b.U, G: b.G };
      })()
    : null;
  const ugr = avail.ugr ? { value: computeUGR(ies).value } : null;

  const cone = CONE_HEIGHTS_FT.map((ft) => {
    const c = coneOfLightAt(ies, ft * M_PER_FT);
    return {
      mountingHeightM: c.mountingHeightM,
      mountingHeightFt: ft,
      beamDiaM: c.beamDiaM,
      fieldDiaM: c.fieldDiaM,
      centerFc: c.centerFc,
      centerLux: c.centerLux,
    };
  });

  return {
    format: ies.format,
    photometricType: ies.photometricType,
    lumens: totalLuminaireLumens(ies),
    inputWatts: ies.inputWatts,
    efficacy: efficacy(ies),
    maxCandela: ba.maxCandela,
    maxAngle: ba.maxAngle,
    beam: {
      beamAngle: ba.beamAngle,
      fieldAngle: ba.fieldAngle,
      beamC0: ba.beamC0,
      beamC90: ba.beamC90,
      fieldC0: ba.fieldC0,
      fieldC90: ba.fieldC90,
    },
    spacingCriterion: {
      plane0: sc.plane0,
      plane90: sc.plane90,
      average: sc.average,
      symmetric: sc.symmetric,
    },
    zonal: { total: zs.total, downward: zs.downward, upward: zs.upward },
    bug,
    ugr,
    cone,
  };
}

/** Parse raw IES text + build the bundle in one step. */
export function parseAndBuild(text: string, label: string): BuiltMetrics {
  const ies = parseIES(text, label);
  return { metrics: buildMetricBundle(ies), warnings: ies.warnings };
}
