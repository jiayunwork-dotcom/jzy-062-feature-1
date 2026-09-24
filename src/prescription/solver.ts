import {
  surfaceAbsorptionPerBand,
  totalSurfaceArea,
  computeAcoustics,
} from '../acoustics';
import {
  AIR_ATTENUATION_NP_PER_M,
  HELMHOLTZ_END_CORRECTION,
  OCTAVE_BANDS_HZ,
  REFERENCE_TEMPERATURE_C,
  SABINE_COEFFICIENT,
  speedOfSoundMetersPerSecond,
  type OctaveBandHz,
} from '../constants';
import { buildResonator } from '../helmholtz';
import type {
  BandResult,
  CalculationResult,
  ResonatorInput,
  RoomInput,
  SurfaceInput,
} from '../types';
import type {
  BandTargetSpec,
  BandVerification,
  PrescriptionRequest,
  PrescriptionResult,
  ResonatorBankPrescription,
  ResonatorPrescription,
  SurfaceBandPrescription,
  SurfacePrescription,
} from './types';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const K_SABINE = SABINE_COEFFICIENT;

interface BandContext {
  spec: BandTargetSpec;
  /** Surface absorption A_surface = Σ Sᵢ·αᵢ (exact, from the kernel helper). */
  surfaceAbsorption: number;
  /** Air absorption 4·m·V (exact, same term the kernel adds). */
  airAbsorption: number;
  /** Baseline resonator absorption at this band (may be 0). */
  baselineResonatorAbsorption: number;
}

function t60Of(result: CalculationResult, model: PrescriptionRequest['model'], band: number): number | null {
  const found = result.bands.find((b: BandResult) => b.frequencyHz === band);
  if (!found) return null;
  return model === 'sabine' ? found.sabine.t60Seconds : found.eyring.t60Seconds;
}

/**
 * Eyring surface term E = −S·ln(1 − A_surface/S). This is the inverse-side
 * evaluation of the exact term the forward kernel uses; the coefficient and
 * the sign convention both come from the shared kernel. Returns +∞ when the
 * mean surface coefficient is 1 (the forward kernel produces a null T60).
 */
function eyringSurfaceTerm(surfaceAbsorption: number, surfaceArea: number): number {
  const meanAlpha = surfaceAbsorption / surfaceArea;
  if (meanAlpha >= 1) return Number.POSITIVE_INFINITY;
  return -surfaceArea * Math.log(1 - meanAlpha);
}

/**
 * Total *non-resonator* denominator contribution at a band:
 * Sabine:  A_surface + A_air;  Eyring: E + A_air.
 */
function nonResonatorDenominator(ctx: BandContext, surfaceArea: number, model: PrescriptionRequest['model']): number {
  return model === 'sabine'
    ? ctx.surfaceAbsorption + ctx.airAbsorption
    : eyringSurfaceTerm(ctx.surfaceAbsorption, surfaceArea) + ctx.airAbsorption;
}

/**
 * Surface absorption total required to hit T60 = t (resonators unchanged):
 * Sabine:  A'_surface = K·V/t − A_air − A_res
 * Eyring:  A'_surface = S·(1 − exp(−(K·V/t − A_air − A_res)/S))
 */
function requiredSurfaceTotal(
  ctx: BandContext,
  surfaceArea: number,
  volume: number,
  model: PrescriptionRequest['model'],
  t: number,
): number {
  const d = (K_SABINE * volume) / t - ctx.airAbsorption - ctx.baselineResonatorAbsorption;
  if (model === 'sabine') return d;
  return surfaceArea * (1 - Math.exp(-d / surfaceArea));
}

/**
 * Continuous extra resonator absorption at a band required to hit T60 = t,
 * given the present surface and air terms:
 *   ΔA_res = K·V/t − (non-resonator denominator) − A_res,baseline
 */
function requiredResonatorAddition(
  ctx: BandContext,
  surfaceArea: number,
  volume: number,
  model: PrescriptionRequest['model'],
  t: number,
): number {
  const requiredDenominator = (K_SABINE * volume) / t;
  return Math.max(
    0,
    requiredDenominator - nonResonatorDenominator(ctx, surfaceArea, model) - ctx.baselineResonatorAbsorption,
  );
}

function buildBandContexts(
  request: PrescriptionRequest,
  surfaceMap: Map<number, number>,
): BandContext[] {
  const volume = request.room.volume;
  const baselineModels = request.resonators.map(buildResonator);
  return (Object.keys(request.targets) as unknown as string[])
    .map((raw) => Number(raw) as OctaveBandHz)
    .sort((a, b) => OCTAVE_BANDS_HZ.indexOf(a) - OCTAVE_BANDS_HZ.indexOf(b))
    .map((band) => {
      const entry = request.targets[band]!;
      const toleranceRatio = entry.toleranceRatio ?? request.toleranceRatio;
      const target = entry.t60Seconds;
      const spec: BandTargetSpec = {
        frequencyHz: band,
        targetT60Seconds: target,
        toleranceRatio,
        lowerT60Seconds: target * (1 - toleranceRatio),
        upperT60Seconds: target * (1 + toleranceRatio),
      };
      return {
        spec,
        surfaceAbsorption: surfaceMap.get(band)!,
        airAbsorption: 4 * AIR_ATTENUATION_NP_PER_M[band] * volume,
        baselineResonatorAbsorption: baselineModels.reduce(
          (sum, modelOf) => sum + modelOf.absorptionAreaAt(band),
          0,
        ),
      };
    });
}

function buildBandVerification(
  contexts: BandContext[],
  baseline: CalculationResult,
  achieved: CalculationResult,
  model: PrescriptionRequest['model'],
): BandVerification[] {
  return contexts.map((ctx) => {
    const band = ctx.spec.frequencyHz;
    const baselineT60 = t60Of(baseline, model, band);
    const achievedT60 = t60Of(achieved, model, band);
    const { lowerT60Seconds: lower, upperT60Seconds: upper } = ctx.spec;
    return {
      frequencyHz: band,
      targetT60Seconds: ctx.spec.targetT60Seconds,
      toleranceRatio: ctx.spec.toleranceRatio,
      lowerT60Seconds: lower,
      upperT60Seconds: upper,
      baselineT60Seconds: baselineT60,
      achievedT60Seconds: achievedT60,
      withinTolerance:
        achievedT60 !== null && achievedT60 >= lower && achievedT60 <= upper,
    };
  });
}

// ---------------------------------------------------------------------------
// Surface path: per-band inversion + water-fill levelling of candidate surfaces
// ---------------------------------------------------------------------------

interface SurfaceAttempt {
  prescription: SurfacePrescription;
  result: CalculationResult;
  infeasibleReasons: string[];
}

/**
 * Solve the water-fill level τ such that
 *   A_fix + Σ_{αᵢ ≥ τ} Sᵢ·αᵢ + τ·Σ_{αᵢ < τ} Sᵢ = A_required.
 * Candidates below τ are raised to τ; candidates already at/above τ keep
 * their coefficient. Closed-form piecewise-linear inversion (the function
 * is monotone, so no iterative search is needed).
 */
function waterfillLevel(
  candidates: { alpha: number; area: number }[],
  fixedAbsorption: number,
  requiredAbsorption: number,
): number | null {
  const sorted = [...candidates].sort((p, q) => p.alpha - q.alpha);
  // Everything starts in the "untouched (high)" bucket: present total.
  let highContribution =
    fixedAbsorption + sorted.reduce((sum, c) => sum + c.area * c.alpha, 0);
  if (requiredAbsorption <= highContribution + 1e-9) {
    // Present candidate coefficients already deliver the required area.
    return null;
  }
  let lowArea = 0;
  for (let r = 0; r < sorted.length; r += 1) {
    // Move candidate r from the untouched bucket into the raised bucket.
    highContribution -= sorted[r]!.alpha * sorted[r]!.area;
    lowArea += sorted[r]!.area;
    const level = (requiredAbsorption - highContribution) / lowArea;
    const nextAlpha = r + 1 < sorted.length ? sorted[r + 1]!.alpha : Number.POSITIVE_INFINITY;
    if (level <= nextAlpha) {
      return Math.min(1, Math.max(0, level));
    }
  }
  return 1;
}

function attemptSurfacePath(
  request: PrescriptionRequest,
  contexts: BandContext[],
  surfaceArea: number,
): SurfaceAttempt {
  const room = request.room;
  const volume = room.volume;
  const surfaces = room.surfaces;
  const candidateNames = request.candidateSurfaceNames;
  const candidateIndices = new Set<number>();
  surfaces.forEach((surface, index) => {
    if (candidateNames.includes(surface.name)) candidateIndices.add(index);
  });

  const bandPrescriptions: SurfaceBandPrescription[] = [];
  // Treated materials: candidate per-band coefficients raised per band.
  const treatedSurfaces: SurfaceInput[] = surfaces.map((surface) => ({
    name: surface.name,
    area: surface.area,
    coefficients: { ...surface.coefficients },
  }));

  const infeasibleBands: OctaveBandHz[] = [];
  const infeasibleReasons: string[] = [];

  for (const ctx of contexts) {
    const band = ctx.spec.frequencyHz;
    const candidateData = surfaces
      .map((surface, index) => ({
        index,
        area: surface.area,
        alpha: surface.coefficients[band],
      }))
      .filter((entry) => candidateIndices.has(entry.index));
    const candidateArea = candidateData.reduce((sum, c) => sum + c.area, 0);
    // Absorption of every non-candidate surface at this band (fixed).
    const fixedAbsorption = surfaces.reduce(
      (sum, surface, index) =>
        candidateIndices.has(index) ? sum : sum + surface.area * surface.coefficients[band],
      0,
    );

    // Present surface contribution at this band.
    const candidateCurrent = candidateData.reduce(
      (sum, c) => sum + c.area * c.alpha,
      0,
    );

    // Aim for the target centre when reachable, otherwise the upper (longest
    // acceptable) edge. The band is feasible iff the upper edge is reachable
    // even with every candidate coefficient at the physical ceiling of 1.
    const maxSurfaceTotal = fixedAbsorption + candidateArea;
    const requiredAtCenter = requiredSurfaceTotal(
      ctx,
      surfaceArea,
      volume,
      request.model,
      ctx.spec.targetT60Seconds,
    );
    const requiredAtUpper = requiredSurfaceTotal(
      ctx,
      surfaceArea,
      volume,
      request.model,
      ctx.spec.upperT60Seconds,
    );
    const centerReachable = requiredAtCenter <= maxSurfaceTotal + 1e-9;
    const feasible = requiredAtUpper <= maxSurfaceTotal + 1e-9;

    const aim = centerReachable
      ? ctx.spec.targetT60Seconds
      : ctx.spec.upperT60Seconds;
    const requiredAim = requiredSurfaceTotal(
      ctx,
      surfaceArea,
      volume,
      request.model,
      aim,
    );
    const additionalRequired = Math.max(0, requiredAim - ctx.surfaceAbsorption);

    if (!feasible) {
      infeasibleBands.push(band);
      // Saturate every candidate for this band and report the physical limit.
      for (const c of candidateData) {
        treatedSurfaces[c.index]!.coefficients[band] = 1;
      }
      bandPrescriptions.push({
        frequencyHz: band,
        targetCoefficient: 1,
        raisedSurfaceNames: candidateData
          .filter((c) => c.alpha < 1)
          .map((c) => surfaces[c.index]!.name),
        requiredAdditionalAbsorptionSquareMeters: Math.max(
          0,
          requiredAtUpper - ctx.surfaceAbsorption,
        ),
        feasible: false,
      });
      continue;
    }

    // Nothing to add when present absorption already meets the aim.
    if (requiredAim <= fixedAbsorption + candidateCurrent + 1e-9) {
      bandPrescriptions.push({
        frequencyHz: band,
        targetCoefficient: null,
        raisedSurfaceNames: [],
        requiredAdditionalAbsorptionSquareMeters: 0,
        feasible: true,
      });
      continue;
    }

    const level = waterfillLevel(
      candidateData.map((c) => ({ alpha: c.alpha, area: c.area })),
      fixedAbsorption,
      requiredAim,
    );
    if (level === null) {
      bandPrescriptions.push({
        frequencyHz: band,
        targetCoefficient: null,
        raisedSurfaceNames: [],
        requiredAdditionalAbsorptionSquareMeters: 0,
        feasible: true,
      });
      continue;
    }
    const raisedNames: string[] = [];
    for (const c of candidateData) {
      if (c.alpha < level - 1e-12) {
        treatedSurfaces[c.index]!.coefficients[band] = level;
        raisedNames.push(surfaces[c.index]!.name);
      }
    }
    bandPrescriptions.push({
      frequencyHz: band,
      targetCoefficient: level,
      raisedSurfaceNames: raisedNames,
      requiredAdditionalAbsorptionSquareMeters: additionalRequired,
      feasible: true,
    });
  }

  const treatedRoom: RoomInput = { ...room, surfaces: treatedSurfaces };
  const result = computeAcoustics(treatedRoom, request.resonators);

  if (infeasibleBands.length > 0) {
    for (const band of infeasibleBands) {
      const tMin = t60Of(result, request.model, band);
      const spec = contexts.find((c) => c.spec.frequencyHz === band)!.spec;
      infeasibleReasons.push(
        `Band ${band} Hz cannot reach its tolerance band by raising the candidate surfaces: ` +
          `with every candidate coefficient at the physical limit of 1 the shortest achievable T60 is ` +
          `${tMin === null ? 'non-finite (fully absorptive)' : `${tMin.toFixed(4)} s`}, ` +
          `still above the upper acceptable bound ${spec.upperT60Seconds.toFixed(4)} s.`,
      );
    }
  }

  const prescription: SurfacePrescription = {
    candidateSurfaceNames: candidateNames,
    surfaces: treatedSurfaces,
    bands: bandPrescriptions,
  };

  return {
    prescription,
    result,
    infeasibleReasons,
  };
}

// ---------------------------------------------------------------------------
// Resonator path: one tuned bank per pinned band, Lorentzian spillover handled
// by running the complete forward kernel on every candidate group increment.
// ---------------------------------------------------------------------------

/**
 * Derive the cavity volume that tunes a unit with the given neck geometry to
 * f0, inverting the shared Helmholtz relation:
 *   V_c = S_n·(c / (2π·f0))² / L_eff
 * The derived geometry is still passed back through buildResonator, so f0 in
 * the output always comes from the forward model (this helper never becomes a
 * parallel copy of the resonator physics).
 */
export function cavityVolumeForTuning(
  f0: number,
  neckArea: number,
  neckLength: number,
  temperatureC: number,
): number {
  const c = speedOfSoundMetersPerSecond(temperatureC);
  const effectiveNeckLength =
    neckLength + HELMHOLTZ_END_CORRECTION * Math.sqrt(neckArea / Math.PI);
  return neckArea * Math.pow(c / (2 * Math.PI * f0), 2) / effectiveNeckLength;
}

interface ResonatorAttempt {
  prescription: ResonatorPrescription;
  result: CalculationResult;
  reached: boolean;
  reason: string | null;
}

/** Lexicographic non-attainment score; smaller is better. */
function violationScore(
  tValues: (number | null)[],
  contexts: BandContext[],
): { maxRel: number; sumRel: number } {
  let maxRel = 0;
  let sumRel = 0;
  tValues.forEach((t, i) => {
    const spec = contexts[i]!.spec;
    if (t === null || t > spec.upperT60Seconds) {
      const rel = t === null ? Number.POSITIVE_INFINITY : (t - spec.upperT60Seconds) / spec.targetT60Seconds;
      maxRel = Math.max(maxRel, rel);
      sumRel += Number.isFinite(rel) ? rel : 1e9;
    }
  });
  return { maxRel, sumRel };
}

function isBetterScore(
  a: { maxRel: number; sumRel: number },
  b: { maxRel: number; sumRel: number },
): boolean {
  if (a.maxRel !== b.maxRel) return a.maxRel < b.maxRel;
  return a.sumRel < b.sumRel;
}

function attemptResonatorPath(
  request: PrescriptionRequest,
  contexts: BandContext[],
  surfaceArea: number,
): ResonatorAttempt {
  const room = request.room;
  const volume = room.volume;
  const cap = request.maxResonatorGroupsPerBand;
  const template = request.resonatorTemplate!;
  const temperatureC = template.temperatureC ?? REFERENCE_TEMPERATURE_C;

  // One bank per pinned band. A fixed-cavity template is reused verbatim
  // (validation already proved it lies inside every pinned band's octave);
  // otherwise the cavity is derived so f0 sits exactly on the band centre.
  const bankInputs: ResonatorInput[] = contexts.map((ctx) => {
    const cavityVolume =
      template.cavityVolume ??
      cavityVolumeForTuning(
        ctx.spec.frequencyHz,
        template.neckArea,
        template.neckLength,
        temperatureC,
      );
    return {
      neckArea: template.neckArea,
      neckLength: template.neckLength,
      cavityVolume,
      ...(template.temperatureC !== undefined ? { temperatureC: template.temperatureC } : {}),
      count: 1,
    };
  });
  const bankUnits = bankInputs.map((input) => buildResonator(input));

  // G[k][i]: absorption (m^2) one unit of bank k contributes at pinned band i.
  const gMatrix = bankUnits.map((unit) =>
    contexts.map((ctx) => unit.absorptionAreaAt(ctx.spec.frequencyHz)),
  );

  const evaluate = (groups: number[]): { result: CalculationResult; tValues: (number | null)[] } => {
    const activeResonators: ResonatorInput[] = [
      ...request.resonators,
      ...bankInputs
        .map((input, k) => ({ ...input, count: groups[k]! }))
        .filter((input) => input.count > 0),
    ];
    const result = computeAcoustics(room, activeResonators);
    return {
      result,
      tValues: contexts.map((ctx) => t60Of(result, request.model, ctx.spec.frequencyHz)),
    };
  };

  const k = contexts.length;

  // Per-bank "safe capacity": the largest number of groups that can sit in
  // bank j without pushing ANY pinned band below its lower tolerance edge.
  // Because each added group can only shorten T60, this is a monotone bound
  // found by probing the cap vector through the forward kernel, and it is
  // tight: any vector with groups[j] > mSafe[j] is guaranteed to violate a
  // lower edge. (This replaces the naive "saturate everything" probe, which
  // can itself overshoot the floor and prove nothing.)
  const mSafe: number[] = Array.from({ length: k }, () => cap);
  const probeVector = (j: number, n: number): (number | null)[] => {
    const groups = Array.from({ length: k }, () => 0);
    groups[j] = n;
    const { tValues } = evaluate(groups);
    return tValues;
  };
  for (let j = 0; j < k; j += 1) {
    // Binary search for the largest safe count in [0, cap].
    let low = 0;
    let high = cap;
    // First check whether even the cap is safe.
    const safeAt = (n: number) =>
      probeVector(j, n).every(
        (t, i) => t !== null && t >= contexts[i]!.spec.lowerT60Seconds,
      );
    if (safeAt(cap)) {
      mSafe[j] = cap;
    } else {
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (safeAt(mid)) low = mid;
        else high = mid - 1;
      }
      mSafe[j] = low;
    }
  }

  // Evaluate the configuration using every bank up to its safe capacity.
  // If a pinned band still cannot enter its tolerance band here, no integer
  // vector within the floor/cap constraints can do better: unreachable.
  const safeMax = evaluate(mSafe);
  const insufficient: OctaveBandHz[] = [];
  contexts.forEach((ctx, i) => {
    const t = safeMax.tValues[i];
    if (t === undefined || t === null || t > ctx.spec.upperT60Seconds) {
      insufficient.push(ctx.spec.frequencyHz);
    }
  });

  if (insufficient.length > 0) {
    return {
      prescription: finalizeResonatorPrescription(
        request,
        contexts,
        surfaceArea,
        volume,
        mSafe,
        bankInputs,
        bankUnits,
        safeMax.result,
      ),
      result: safeMax.result,
      reached: false,
      reason:
        `The pinned band(s) ${insufficient.join(', ')} Hz cannot enter their tolerance bands with integer resonator ` +
        `groups within maxResonatorGroupsPerBand=${cap}: adding enough absorption to reach the upper edge would push a ` +
        `pinned band below its own lower tolerance edge (Lorentzian spillover / single-unit granularity), or the group cap ` +
        `binds first. The closest achievable configuration is reported in the verification block.`,
    };
  }

  // Greedy integer search. Each accepted step is evaluated through the full
  // forward kernel. The lower tolerance edge is a hard floor: an increment is
  // rejected if it pushes ANY pinned band below its own lower bound, which is
  // exactly the spillover-coupling guard that prevents robbing neighbours.
  let groups = Array.from({ length: k }, () => 0);
  let current = evaluate(groups);
  let bestGroups = [...groups];
  let bestResult = current.result;
  let bestScore = violationScore(current.tValues, contexts);

  const maxIterations = k * cap;
  let iteration = 0;
  let blocked = false;

  outer: while (iteration < maxIterations) {
    iteration += 1;
    const violating = contexts
      .map((ctx, i) => ({
        i,
        severity:
          current.tValues[i] === null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, (current.tValues[i]! - ctx.spec.upperT60Seconds) / ctx.spec.targetT60Seconds),
      }))
      .filter((entry) => entry.severity > 0)
      .sort((a, b) => b.severity - a.severity);

    if (violating.length === 0) break outer;

    const j = violating[0]!.i;

    // Try the violating bands' own banks first (diagonal, largest effect at
    // the most severe band), then every remaining bank ranked by what it
    // contributes to band j.
    const triedBanks = new Set<number>();
    const order: number[] = [];
    for (const v of violating) {
      order.push(v.i);
      triedBanks.add(v.i);
    }
    const rest = contexts
      .map((_, bankIndex) => bankIndex)
      .filter((bankIndex) => !triedBanks.has(bankIndex))
      .sort((a, b) => gMatrix[b]![j]! - gMatrix[a]![j]!);
    order.push(...rest);

    let progressed = false;
    for (const bankIndex of order) {
      if (groups[bankIndex]! >= mSafe[bankIndex]!) continue;
      const trialGroups = [...groups];
      trialGroups[bankIndex] = trialGroups[bankIndex]! + 1;
      const trial = evaluate(trialGroups);

      // Hard lower-bound floor for every pinned band.
      const safe = trial.tValues.every((t, i) => {
        if (t === null) return false;
        return t >= contexts[i]!.spec.lowerT60Seconds;
      });
      // The step must actually shorten the band we are serving.
      const progress =
        current.tValues[j] !== null &&
        trial.tValues[j] !== null &&
        trial.tValues[j]! < current.tValues[j]!;

      if (safe && progress) {
        groups = trialGroups;
        current = trial;
        progressed = true;
        const score = violationScore(current.tValues, contexts);
        if (isBetterScore(score, bestScore)) {
          bestScore = score;
          bestGroups = [...groups];
          bestResult = current.result;
        }
        break;
      }
    }

    if (!progressed) {
      blocked = true;
      break outer;
    }
  }

  const stillViolating = contexts.some((ctx, i) => {
    const t = current.tValues[i];
    return t === undefined || t === null || t > ctx.spec.upperT60Seconds;
  });
  const reached = !blocked && !stillViolating;

  // Report the best configuration actually visited.
  const finalGroups = reached ? groups : bestGroups;
  const finalResult = reached ? current.result : bestResult;

  let reason: string | null = null;
  if (!reached) {
    if (blocked) {
      const blockedBands = contexts
        .filter((ctx, i) => {
          const t = current.tValues[i];
          return t !== undefined && t !== null && t < ctx.spec.lowerT60Seconds;
        })
        .map((ctx) => `${ctx.spec.frequencyHz} Hz`);
      reason =
        `No safe integer resonator group count satisfies all pinned bands simultaneously: ` +
        `adding the next group would push band(s) ${blockedBands.join(', ') || '?'} below their lower tolerance bounds ` +
        `(Lorentzian spillover), while other pinned bands are still too long. ` +
        `The closest achievable configuration is reported in the verification block.`;
    } else {
      reason =
        `The integer group search stopped after ${iteration} iterations without bringing every pinned band ` +
        `inside its tolerance band. The closest achievable configuration is reported in the verification block.`;
    }
  }

  return {
    prescription: finalizeResonatorPrescription(
      request,
      contexts,
      surfaceArea,
      volume,
      finalGroups,
      bankInputs,
      bankUnits,
      finalResult,
    ),
    result: finalResult,
    reached,
    reason,
  };
}

function finalizeResonatorPrescription(
  request: PrescriptionRequest,
  contexts: BandContext[],
  surfaceArea: number,
  volume: number,
  groups: number[],
  bankInputs: ResonatorInput[],
  bankUnits: ReturnType<typeof buildResonator>[],
  result: CalculationResult,
): ResonatorPrescription {
  const baseline = computeAcoustics(request.room, request.resonators);
  const banks: ResonatorBankPrescription[] = [];
  contexts.forEach((ctx, k) => {
    const count = groups[k]!;
    if (count === 0) return;
    const unit = bankUnits[k]!;
    banks.push({
      frequencyHz: ctx.spec.frequencyHz,
      resonator: { ...bankInputs[k]!, count },
      groups: count,
      resonanceFrequencyHz: unit.report.resonanceFrequencyHz,
      peakAbsorptionAreaSquareMeters: unit.report.peakAbsorptionAreaSquareMeters,
    });
  });

  const bands = contexts.map((ctx, k) => {
    const band = ctx.spec.frequencyHz;
    const baselineBand = baseline.bands.find((b) => b.frequencyHz === band)!;
    const achievedBand = result.bands.find((b) => b.frequencyHz === band)!;
    const delivered = Math.max(
      0,
      achievedBand.absorption.resonators - baselineBand.absorption.resonators,
    );
    const t = request.model === 'sabine'
      ? achievedBand.sabine.t60Seconds
      : achievedBand.eyring.t60Seconds;
    return {
      frequencyHz: band,
      groups: groups[k]!,
      requiredAdditionalAbsorptionSquareMeters: requiredResonatorAddition(
        ctx,
        surfaceArea,
        volume,
        request.model,
        ctx.spec.targetT60Seconds,
      ),
      deliveredAdditionalAbsorptionSquareMeters: delivered,
      reachedTolerance:
        t !== null &&
        t >= ctx.spec.lowerT60Seconds &&
        t <= ctx.spec.upperT60Seconds,
    };
  });

  return { banks, bands };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function solvePrescription(request: PrescriptionRequest): PrescriptionResult {
  const room = request.room;
  const surfaceArea = totalSurfaceArea(room);
  const surfaceMap = surfaceAbsorptionPerBand(room);
  const contexts = buildBandContexts(request, surfaceMap);
  const baseline = computeAcoustics(room, request.resonators);

  const baseVerification = buildBandVerification(contexts, baseline, baseline, request.model);

  // A band already shorter than its lower tolerance bound can never be fixed
  // by adding absorption (neither surfaces nor resonators lengthen a room).
  const overTreated = baseVerification.filter(
    (v) => v.baselineT60Seconds === null || v.baselineT60Seconds < v.lowerT60Seconds,
  );
  if (overTreated.length > 0) {
    const detail = overTreated
      .map((v) =>
        v.baselineT60Seconds === null
          ? `${v.frequencyHz} Hz has a non-finite (fully absorptive) baseline T60`
          : `${v.frequencyHz} Hz baseline T60 ${v.baselineT60Seconds} s is already below the lower bound ${v.lowerT60Seconds.toFixed(4)} s`,
      )
      .join('; ');
    return {
      status: 'unreachable',
      model: request.model,
      strategyUsed: request.candidateSurfaceNames.length > 0 ? 'surface' : 'resonator',
      targets: contexts.map((c) => c.spec),
      baseline,
      surface: null,
      resonators: null,
      verification: baseline,
      bandVerification: baseVerification,
      unreachable: {
        reason:
          `${detail}. Adding absorption can only shorten reverberation further; the target is physically unreachable.`,
        attemptedStrategy: request.candidateSurfaceNames.length > 0 ? 'surface' : 'resonator',
        bestAchievable: baseline,
        bestAchievableBandVerification: baseVerification,
      },
    };
  }

  // Already meeting every pinned band: empty prescription, do not over-treat.
  if (baseVerification.every((v) => v.withinTolerance)) {
    return {
      status: 'not-needed',
      model: request.model,
      strategyUsed: 'none',
      targets: contexts.map((c) => c.spec),
      baseline,
      surface: null,
      resonators: null,
      verification: baseline,
      bandVerification: baseVerification,
      unreachable: null,
    };
  }

  const wantSurface =
    request.strategy === 'surface' ||
    (request.strategy === 'auto' && request.candidateSurfaceNames.length > 0);
  const wantResonator =
    request.strategy === 'resonator' ||
    (request.strategy === 'auto' && request.resonatorTemplate !== null);

  type AttemptOutcome =
    | { kind: 'surface'; attempt: SurfaceAttempt; verification: BandVerification[]; score: { maxRel: number; sumRel: number } }
    | { kind: 'resonator'; attempt: ResonatorAttempt; verification: BandVerification[]; score: { maxRel: number; sumRel: number } };

  const outcomes: AttemptOutcome[] = [];

  if (wantSurface) {
    const attempt = attemptSurfacePath(request, contexts, surfaceArea);
    const verification = buildBandVerification(contexts, baseline, attempt.result, request.model);
    const tValues = contexts.map((ctx) => t60Of(attempt.result, request.model, ctx.spec.frequencyHz));
    outcomes.push({ kind: 'surface', attempt, verification, score: violationScore(tValues, contexts) });
  }
  if (wantResonator) {
    const attempt = attemptResonatorPath(request, contexts, surfaceArea);
    const verification = buildBandVerification(contexts, baseline, attempt.result, request.model);
    const tValues = contexts.map((ctx) => t60Of(attempt.result, request.model, ctx.spec.frequencyHz));
    outcomes.push({ kind: 'resonator', attempt, verification, score: violationScore(tValues, contexts) });
  }

  // Any fully successful attempt settles the request.
  const surfaceOutcome = outcomes.find((o) => o.kind === 'surface');
  const resonatorOutcome = outcomes.find((o) => o.kind === 'resonator');

  if (surfaceOutcome && surfaceOutcome.verification.every((v) => v.withinTolerance)) {
    const attempt = surfaceOutcome.attempt as SurfaceAttempt;
    return {
      status: 'solved',
      model: request.model,
      strategyUsed: 'surface',
      targets: contexts.map((c) => c.spec),
      baseline,
      surface: attempt.prescription,
      resonators: null,
      verification: attempt.result,
      bandVerification: surfaceOutcome.verification,
      unreachable: null,
    };
  }
  if (resonatorOutcome && resonatorOutcome.verification.every((v) => v.withinTolerance)) {
    const attempt = resonatorOutcome.attempt as ResonatorAttempt;
    return {
      status: 'solved',
      model: request.model,
      strategyUsed: 'resonator',
      targets: contexts.map((c) => c.spec),
      baseline,
      // In auto mode the surface attempt ran first and failed its bands:
      // retain its prescription so the caller can see what was tried.
      surface:
        request.strategy === 'auto' && surfaceOutcome !== undefined
          ? (surfaceOutcome.attempt as SurfaceAttempt).prescription
          : null,
      resonators: attempt.prescription,
      verification: attempt.result,
      bandVerification: resonatorOutcome.verification,
      unreachable: null,
    };
  }

  // Nothing converged: report the best configuration among the attempted
  // paths, with the per-band forward re-check attached — never a fabricated
  // prescription that the kernel does not confirm.
  const ranked = [...outcomes].sort((a, b) =>
    isBetterScore(a.score, b.score) ? -1 : 1,
  );
  const best = ranked[0]!;
  const bestResult =
    best.kind === 'surface'
      ? (best.attempt as SurfaceAttempt).result
      : (best.attempt as ResonatorAttempt).result;
  const reasons: string[] = [];
  if (surfaceOutcome) {
    reasons.push(...(surfaceOutcome.attempt as SurfaceAttempt).infeasibleReasons);
  }
  if (resonatorOutcome) {
    const r = (resonatorOutcome.attempt as ResonatorAttempt).reason;
    if (r !== null) reasons.push(r);
  }

  return {
    status: 'unreachable',
    model: request.model,
    strategyUsed: best.kind,
    targets: contexts.map((c) => c.spec),
    baseline,
    surface:
      surfaceOutcome !== undefined
        ? (surfaceOutcome.attempt as SurfaceAttempt).prescription
        : null,
    resonators:
      resonatorOutcome !== undefined
        ? (resonatorOutcome.attempt as ResonatorAttempt).prescription
        : null,
    verification: bestResult,
    bandVerification: best.verification,
    unreachable: {
      reason: reasons.join(' '),
      attemptedStrategy: best.kind,
      bestAchievable: bestResult,
      bestAchievableBandVerification: best.verification,
    },
  };
}
