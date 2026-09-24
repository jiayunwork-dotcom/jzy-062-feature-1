import { computeAcoustics } from '../acoustics';
import { SABINE_COEFFICIENT, type OctaveBandHz } from '../constants';
import { buildResonator, type ResonatorModel } from '../helmholtz';
import type {
  CalculationResult,
  PrescriptionAttempt,
  PrescriptionRequest,
  PrescriptionResult,
  PrescriptionTargetStatus,
  ResolvedPrescriptionRequest,
  ResonatorInput,
  ResonatorTreatment,
  RoomInput,
  SurfaceTreatment,
  TargetBandState,
} from '../types';

/**
 * Goal-driven absorption prescription solver.
 *
 * This module is pure inversion logic wrapped around the UNMODIFIED forward
 * kernel: every candidate treatment is scored by calling `computeAcoustics`
 * (and resonator geometry is inverted by bisecting against `buildResonator`).
 * It declares no physical constants or reverberation formulas of its own —
 * the Sabine/Eyring coefficient, resonator end correction, Q factor and the
 * temperature-dependent speed of sound all keep coming from `constants.ts`
 * through the forward modules.
 *
 * The solver holds no module-level state: each call builds its own room
 * clones and counters, so concurrent solves can never share intermediate
 * state.
 */

const SURFACE_BISECTION_STEPS = 44;
const CAVITY_BISECTION_STEPS = 60;
/** Bound on satisfy/repair sweeps; six bands make convergence far quicker. */
const RESONATOR_SWEEP_LIMIT = 10_000;

interface SolveContext {
  resolved: ResolvedPrescriptionRequest;
  forwardEvaluations: number;
  iterations: number;
}

// ---------------------------------------------------------------------------
// Forward-kernel accessors (the ONLY way the solver looks at acoustics)
// ---------------------------------------------------------------------------

function readT60(
  result: CalculationResult,
  band: OctaveBandHz,
  model: ResolvedPrescriptionRequest['model'],
): number {
  const row = result.bands.find((b) => b.frequencyHz === band);
  if (row === undefined) {
    throw new Error(`forward kernel did not return band ${band}`);
  }
  return model === 'sabine'
    ? (row.sabine.t60Seconds ?? 0)
    : (row.eyring.t60Seconds ?? 0);
}

/**
 * Effective reverberation "denominator" (Sabine total absorption A, or the
 * Eyring denominator -S*ln(1-a) + 4mV + A_res) read back from a forward
 * result: T60 = K*V / D, so D = K*V / T60. K is imported from the shared
 * constants module — never redeclared here.
 */
function effectiveDenominator(
  result: CalculationResult,
  band: OctaveBandHz,
  volume: number,
  model: ResolvedPrescriptionRequest['model'],
): number {
  const row = result.bands.find((b) => b.frequencyHz === band)!;
  if (model === 'sabine') {
    return row.absorption.total;
  }
  const t60 = row.eyring.t60Seconds;
  return t60 === null || t60 === 0 ? Number.POSITIVE_INFINITY : (SABINE_COEFFICIENT * volume) / t60;
}

function runForward(
  ctx: SolveContext,
  room: RoomInput,
  resonators: ResonatorInput[],
): CalculationResult {
  ctx.forwardEvaluations += 1;
  return computeAcoustics(room, resonators);
}

// ---------------------------------------------------------------------------
// Room cloning / treatment application
// ---------------------------------------------------------------------------

function cloneRoom(room: RoomInput): RoomInput {
  return {
    name: room.name,
    volume: room.volume,
    surfaces: room.surfaces.map((surface) => ({
      name: surface.name,
      area: surface.area,
      coefficients: { ...surface.coefficients },
    })),
  };
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Resonator geometry inversion (forward model inside the loop)
// ---------------------------------------------------------------------------

/**
 * Design one unit resonator tuned to exactly `band` Hz, keeping the caller's
 * neck geometry and temperature. The cavity volume is the only free design
 * variable; rather than re-deriving the Helmholtz formula, we bisect the
 * cavity and let `buildResonator` (with the shared end correction, speed of
 * sound and Q) tell us the resulting f0 on every iteration.
 */
function designResonatorForBand(
  band: OctaveBandHz,
  template: ResolvedPrescriptionRequest['resonatorTemplate'],
  ctx: SolveContext,
): { model: ResonatorModel; cavityVolume: number } {
  let low = 1e-9;
  let high = 1e2;
  // f0 decreases monotonically as cavity volume grows.
  const probe = (cavityVolume: number): number => {
    ctx.forwardEvaluations += 1;
    return buildResonator({
      neckArea: template.neckArea,
      neckLength: template.neckLength,
      cavityVolume,
      temperatureC: template.temperatureC,
    }).report.resonanceFrequencyHz;
  };

  if (probe(low) < band || probe(high) > band) {
    throw new Error(
      `resonator design search bracket does not straddle ${band} Hz for the supplied neck geometry`,
    );
  }

  for (let step = 0; step < CAVITY_BISECTION_STEPS; step += 1) {
    ctx.iterations += 1;
    const mid = Math.sqrt(low * high); // geometric midpoint: volume spans decades
    if (probe(mid) > band) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const cavityVolume = Math.sqrt(low * high);
  return {
    cavityVolume,
    model: buildResonator({
      neckArea: template.neckArea,
      neckLength: template.neckLength,
      cavityVolume,
      temperatureC: template.temperatureC,
    }),
  };
}

// ---------------------------------------------------------------------------
// Band target bookkeeping
// ---------------------------------------------------------------------------

interface BandSpec {
  band: OctaveBandHz;
  target: number;
  lower: number;
  upper: number;
  baseline: number;
}

function buildBandSpecs(
  resolved: ResolvedPrescriptionRequest,
  baseline: CalculationResult,
): BandSpec[] {
  return resolved.pinnedBands.map((band) => {
    const target = resolved.targets[band]!;
    return {
      band,
      target,
      lower: target * (1 - resolved.toleranceRatio),
      upper: target * (1 + resolved.toleranceRatio),
      baseline: readT60(baseline, band, resolved.model),
    };
  });
}

/** Extra absorption (m^2) needed at `band` to just reach the upper tolerance edge. */
function requiredAbsorption(
  result: CalculationResult,
  spec: BandSpec,
  volume: number,
  model: ResolvedPrescriptionRequest['model'],
): number {
  const denominator = effectiveDenominator(result, spec.band, volume, model);
  const needed = (SABINE_COEFFICIENT * volume) / spec.upper - denominator;
  return needed > 0 ? needed : 0;
}

function targetStatuses(
  specs: BandSpec[],
  achieved: CalculationResult,
  baseline: CalculationResult,
  volume: number,
  model: ResolvedPrescriptionRequest['model'],
): PrescriptionTargetStatus[] {
  return specs.map((spec) => {
    const t = readT60(achieved, spec.band, model);
    let state: TargetBandState;
    if (spec.baseline <= spec.upper) {
      // Added absorption can never lengthen T60, so a band already at or
      // under the upper edge is a no-treatment band.
      state =
        spec.baseline >= spec.lower ? 'already-compliant' : 'already-better-than-target';
    } else if (t >= spec.lower && t <= spec.upper) {
      state = 'within-tolerance';
    } else if (t < spec.lower) {
      state = 'over-treated';
    } else {
      state = 'unreachable';
    }
    return {
      frequencyHz: spec.band,
      targetT60Seconds: spec.target,
      lowerBoundSeconds: round4(spec.lower),
      upperBoundSeconds: round4(spec.upper),
      baselineT60Seconds: round4(spec.baseline),
      achievedT60Seconds: round4(t),
      state,
      requiredAdditionalAbsorptionSquareMeters: round4(
        requiredAbsorption(baseline, spec, volume, model),
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Surface path: raise candidate-surface coefficients, per band
// ---------------------------------------------------------------------------

interface SurfacePlan {
  status: PrescriptionResult['status'];
  treatments: SurfaceTreatment[];
  treatedRoom: RoomInput;
  limitingBands: OctaveBandHz[];
  bestAchievable: CalculationResult;
}

function solveSurfacePath(ctx: SolveContext, baseline: CalculationResult): SurfacePlan {
  const { resolved } = ctx;
  const specs = buildBandSpecs(resolved, baseline);
  const candidateIndexes = resolved.room.surfaces
    .map((surface, index) => ({ surface, index }))
    .filter(({ surface }) => resolved.candidateSurfaceNames.includes(surface.name));

  // Per-band common coefficient levels the candidates are raised to.
  const levels = new Map<OctaveBandHz, number>();
  const limitingBands: OctaveBandHz[] = [];

  for (const spec of specs) {
    if (spec.baseline <= spec.upper) {
      levels.set(spec.band, 0); // nothing to add; levels only raise coefficients
      continue;
    }

    const tAt = (level: number): number => {
      const trial = cloneRoom(resolved.room);
      for (const { index } of candidateIndexes) {
        const targetSurface = trial.surfaces[index]!;
        targetSurface.coefficients[spec.band] = Math.max(
          targetSurface.coefficients[spec.band],
          level,
        );
      }
      return readT60(
        runForward(ctx, trial, resolved.existingResonators),
        spec.band,
        resolved.model,
      );
    };

    // Physical ceiling: every candidate coefficient pinned to 1.
    const minimumT = tAt(1);
    if (minimumT > spec.upper) {
      limitingBands.push(spec.band);
      levels.set(spec.band, 1);
      continue;
    }

    // Bisection on the smallest feasible level (T60 decreases monotonically
    // with the level), so the prescription adds no more absorption than the
    // tolerance band requires.
    let low = 0;
    let high = 1;
    for (let step = 0; step < SURFACE_BISECTION_STEPS; step += 1) {
      ctx.iterations += 1;
      const mid = (low + high) / 2;
      if (tAt(mid) > spec.upper) {
        low = mid;
      } else {
        high = mid;
      }
    }
    levels.set(spec.band, high);
  }

  // Best achievable: candidates saturated at 1 in every deficient band.
  const saturatedRoom = cloneRoom(resolved.room);
  for (const spec of specs) {
    if (spec.baseline > spec.upper) {
      for (const { index } of candidateIndexes) {
        saturatedRoom.surfaces[index]!.coefficients[spec.band] = 1;
      }
    }
  }
  const bestAchievable = runForward(ctx, saturatedRoom, resolved.existingResonators);

  // Build the treated room once: each candidate surface takes the max level
  // across the pinned bands (surface treatments are band-local, so they do
  // not couple, but the final prescription is one consistent room).
  const treatedRoom = cloneRoom(resolved.room);
  const treatments: SurfaceTreatment[] = [];
  for (const spec of specs) {
    const level = levels.get(spec.band)!;
    if (level <= 0 || spec.baseline <= spec.upper) {
      continue;
    }
    let added = 0;
    const perSurface = candidateIndexes.map(({ surface, index }) => {
      const previous = surface.coefficients[spec.band];
      const newCoefficient = Math.max(previous, level);
      const targetSurface = treatedRoom.surfaces[index]!;
      targetSurface.coefficients[spec.band] = Math.max(
        targetSurface.coefficients[spec.band],
        newCoefficient,
      );
      added += surface.area * (newCoefficient - previous);
      return {
        name: surface.name,
        areaSquareMeters: surface.area,
        previousCoefficient: previous,
        newCoefficient: round4(newCoefficient),
      };
    });
    treatments.push({
      frequencyHz: spec.band,
      surfaceNames: resolved.candidateSurfaceNames,
      targetCoefficient: round4(level),
      perSurface,
      additionalAbsorptionAreaSquareMeters: round4(Math.max(added, 0)),
    });
  }

  return {
    status: limitingBands.length > 0 ? 'unreachable' : 'solved',
    treatments,
    treatedRoom,
    limitingBands,
    bestAchievable,
  };
}

// ---------------------------------------------------------------------------
// Resonator path: integer group counts, coupled through the Lorentzian tails
// ---------------------------------------------------------------------------

interface ResonatorBank {
  band: OctaveBandHz;
  model: ResonatorModel;
  input: ResonatorInput;
}

interface ResonatorPlan {
  status: PrescriptionResult['status'];
  treatments: ResonatorTreatment[];
  limitingBands: OctaveBandHz[];
  spilloverBands: OctaveBandHz[];
  quantizationBands: OctaveBandHz[];
  bestResult: CalculationResult;
  /** Shortest T60 reachable per band when every bank saturates the group cap. */
  cappedT60ByBand: ReadonlyMap<OctaveBandHz, number>;
}

/**
 * Solve the coupled resonator problem.
 *
 * The forward kernel is linear in the group counts: for every pinned band j,
 * the effective denominator D_j (Sabine total absorption A, or the Eyring
 * denominator read back from a forward run) obeys
 *
 *     D_j(counts) = D0_j + sum_i counts_i * G[i][j]
 *
 * where G[i][j] is one unit's Lorentzian absorption at band j — taken
 * straight from the forward resonator model, never re-derived. The target
 * window becomes the linear interval
 *
 *     L_j = K V / (T*(1+tol))  <=  D_j  <=  U_j = K V / (T*(1-tol)).
 *
 * Two phases: (1) raise counts until every active band clears its lower
 * denominator bound (the positive Lorentzian tails of groups bought for one
 * band help the others, and that coupling is included in the bookkeeping);
 * (2) repair bands pushed past the UPPER denominator bound (T60 below the
 * lower tolerance edge) by removing units only while no band re-opens a
 * lower-bound gap. The second phase is exactly where spillover can make a
 * target infeasible — that is reported honestly instead of hidden.
 */
function solveResonatorPath(
  ctx: SolveContext,
  baseline: CalculationResult,
): ResonatorPlan {
  const { resolved } = ctx;
  const volume = resolved.room.volume;
  const specs = buildBandSpecs(resolved, baseline);
  const active = specs.filter((spec) => spec.baseline > spec.upper);

  const banks: ResonatorBank[] = active.map((spec) => {
    const designed = designResonatorForBand(spec.band, resolved.resonatorTemplate, ctx);
    return {
      band: spec.band,
      model: designed.model,
      input: {
        neckArea: resolved.resonatorTemplate.neckArea,
        neckLength: resolved.resonatorTemplate.neckLength,
        cavityVolume: designed.cavityVolume,
        temperatureC: resolved.resonatorTemplate.temperatureC,
        count: 1,
      },
    };
  });

  const evaluate = (counts: number[]): CalculationResult => {
    const added: ResonatorInput[] = banks
      .map((bank, index) => ({ ...bank.input, count: counts[index] ?? 0 }))
      .filter((resonator) => resonator.count > 0);
    return runForward(ctx, resolved.room, [...resolved.existingResonators, ...added]);
  };

  // Linear problem data, all of it sourced from forward-model evaluations.
  const d0 = specs.map((spec) =>
    effectiveDenominator(baseline, spec.band, volume, resolved.model),
  );
  const lower = specs.map((spec) => (SABINE_COEFFICIENT * volume) / spec.upper);
  const upper = specs.map((spec) => (SABINE_COEFFICIENT * volume) / spec.lower);
  // G[i][j]: absorption one unit of bank i adds at pinned band j.
  const spillover = banks.map((bank) =>
    specs.map((spec) => bank.model.absorptionAreaAt(spec.band)),
  );

  const counts = new Array<number>(banks.length).fill(0);
  const denominatorOf = (bandIndex: number): number =>
    d0[bandIndex]! +
    spillover.reduce(
      (sum, contributions, bankIndex) =>
        sum + counts[bankIndex]! * contributions[bandIndex]!,
      0,
    );

  // ---- Phase 1: satisfy the lower denominator bound in every band --------
  let changed = true;
  let guard = 0;
  while (changed) {
    changed = false;
    guard += 1;
    if (guard > RESONATOR_SWEEP_LIMIT) {
      throw new Error('resonator count search did not converge within its sweep limit');
    }
    // Largest relative shortfall first: the band driving the most groups.
    const order = specs
      .map((spec, bandIndex) => ({
        bandIndex,
        shortfall: (lower[bandIndex]! - denominatorOf(bandIndex)) / lower[bandIndex]!,
      }))
      .filter((entry) => entry.shortfall > 0)
      .sort((a, b) => b.shortfall - a.shortfall);

    for (const { bandIndex } of order) {
      const deficit = lower[bandIndex]! - denominatorOf(bandIndex);
      if (deficit <= 0) continue;
      // Own tuned bank is the most efficient lever (largest G at this band).
      const ownIndex = banks.findIndex(
        (bank) => bank.band === specs[bandIndex]!.band,
      );
      if (ownIndex < 0) continue; // passive band: can only be helped by others
      const perUnit = spillover[ownIndex]![bandIndex]!;
      const headroom = resolved.maxResonatorGroups - counts[ownIndex]!;
      if (headroom <= 0) continue; // own bank saturated; other banks may still help
      const add = Math.min(headroom, Math.ceil(deficit / perUnit));
      counts[ownIndex] = counts[ownIndex]! + add;
      ctx.iterations += 1;
      changed = true;
    }
  }

  let result = evaluate(counts);

  // ---- Phase 2: repair OVER-treatment (T60 below the lower edge) ----------
  // Phase 1 drove every denominator up to at least L; integer rounding and
  // other banks' Lorentzian tails can push a band past U. Remove units in
  // batches, always keeping every denominator >= L. A band that cannot be
  // relieved without re-opening someone else's lower-bound gap is the
  // genuine spillover coupling — reported, never papered over.
  const spilloverBands: OctaveBandHz[] = [];
  const quantizationBands: OctaveBandHz[] = [];
  const tAt = (res: CalculationResult, bandIndex: number): number =>
    readT60(res, specs[bandIndex]!.band, resolved.model);

  for (let repairRound = 0; repairRound < RESONATOR_SWEEP_LIMIT; repairRound += 1) {
    ctx.iterations += 1;
    // Bands currently over-treated (too dead), largest relative excess first.
    const overTreated: number[] = specs
      .map((spec, bandIndex) => ({
        bandIndex,
        excess: (spec.lower - tAt(result, bandIndex)) / spec.lower,
      }))
      .filter((entry) => entry.excess > 0)
      .sort((a, b) => b.excess - a.excess)
      .map((entry) => entry.bandIndex);
    if (overTreated.length === 0) break;

    let progressed = false;
    for (const bandIndex of overTreated) {
      // Remove one unit from the bank whose tail contributes most at THIS
      // band, provided no band's denominator falls below its lower bound.
      const candidates = banks
        .map((bank, bankIndex) => {
          if (counts[bankIndex] === 0) return null;
          const relief = spillover[bankIndex]![bandIndex]!;
          const safe = specs.every(
            (_, otherIndex) =>
              denominatorOf(otherIndex) - spillover[bankIndex]![otherIndex]! + 1e-9 >=
              lower[otherIndex]!,
          );
          return safe ? { bankIndex, relief } : null;
        })
        .filter((candidate): candidate is { bankIndex: number; relief: number } => candidate !== null)
        .filter((candidate) => candidate.relief > 0)
        .sort((a, b) => b.relief - a.relief);

      const choice = candidates[0];
      if (choice === undefined) {
        // Over-treat by less than one smallest available unit: integer
        // quantization, not a structural coupling failure.
        const excess = denominatorOf(bandIndex) - upper[bandIndex]!;
        const granularity = Math.max(
          ...spillover.map((contributions) => contributions[bandIndex]!),
        );
        if (excess <= granularity + 1e-9) {
          quantizationBands.push(specs[bandIndex]!.band);
        } else {
          spilloverBands.push(specs[bandIndex]!.band);
        }
        continue;
      }

      // Remove as many units as possible in one step: enough to bring this
      // band into its denominator window, but never enough to open a
      // lower-bound gap in any other band.
      const overBy = denominatorOf(bandIndex) - upper[bandIndex]!;
      let step = Math.max(1, Math.ceil(overBy / spillover[choice.bankIndex]![bandIndex]!));
      step = Math.min(step, counts[choice.bankIndex]!);
      for (const otherIndex of specs.map((_, i) => i)) {
        const ownContribution = spillover[choice.bankIndex]![otherIndex]!;
        if (ownContribution <= 0) continue;
        const slack = denominatorOf(otherIndex) - lower[otherIndex]!;
        const maxForBand = Math.floor((slack + 1e-9) / ownContribution);
        step = Math.min(step, maxForBand);
      }
      if (step < 1) {
        spilloverBands.push(specs[bandIndex]!.band);
        continue;
      }
      counts[choice.bankIndex] = counts[choice.bankIndex]! - step;
      progressed = true;
    }

    if (!progressed) break;
    result = evaluate(counts);
  }

  const liveBands: number[] = [];
  specs.forEach((spec, bandIndex) => {
    if (tAt(result, bandIndex) > spec.upper) liveBands.push(bandIndex);
  });

  // Bands still live after phase 1: saturate EVERY bank at the group cap
  // and re-check. Tails from the other capped banks can close the residual
  // gap. If a band still fails, the group cap is the physical limit.
  let cappedT60ByBand: ReadonlyMap<OctaveBandHz, number> = new Map();
  let cappedCounts: number[] | null = null;
  if (liveBands.length > 0) {
    cappedCounts = banks.map(() => resolved.maxResonatorGroups);
    const cappedResult = evaluate(cappedCounts);
    cappedT60ByBand = new Map(
      specs.map((spec, bandIndex) => [spec.band, tAt(cappedResult, bandIndex)]),
    );
  }

  // Bands the all-caps configuration still leaves live are genuinely
  // group-cap limited. If all-caps DOES close every gap, use it as the
  // prescription (it is the only configuration that does).
  const limitingBands: OctaveBandHz[] = [];
  for (const bandIndex of liveBands) {
    const cappedT = cappedT60ByBand.get(specs[bandIndex]!.band)!;
    if (cappedT > specs[bandIndex]!.upper) {
      limitingBands.push(specs[bandIndex]!.band);
    }
  }
  if (liveBands.length > 0 && limitingBands.length === 0) {
    counts.splice(0, counts.length, ...cappedCounts!);
    result = evaluate(counts);
    cappedCounts = null;
  }

  const treatments: ResonatorTreatment[] = [];
  counts.forEach((groupCount, index) => {
    const bank = banks[index]!;
    if (groupCount <= 0) return;
    const report = bank.model.report;
    treatments.push({
      frequencyHz: bank.band,
      groupCount,
      resonator: { ...bank.input, count: groupCount },
      tunedFrequencyHz: round4(report.resonanceFrequencyHz),
      cavityVolumeCubicMeters: round4(bank.input.cavityVolume),
      peakAbsorptionAreaSquareMeters: round4(report.peakAbsorptionAreaSquareMeters),
      additionalAbsorptionAreaAtBandSquareMeters: round4(
        groupCount * report.peakAbsorptionAreaSquareMeters,
      ),
    });
  });

  const status: PrescriptionResult['status'] =
    limitingBands.length > 0 ||
    spilloverBands.length > 0 ||
    quantizationBands.length > 0
      ? 'unreachable'
      : 'solved';

  return {
    status,
    treatments,
    limitingBands,
    spilloverBands,
    quantizationBands,
    bestResult: result,
    cappedT60ByBand,
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export interface SolvePrescriptionOptions {
  /** Echo of the caller's (already validated) request, for callers that persist it. */
  request?: PrescriptionRequest;
  resolved: ResolvedPrescriptionRequest;
}

export function solvePrescription(options: SolvePrescriptionOptions): PrescriptionResult {
  const { resolved } = options;
  const ctx: SolveContext = {
    resolved,
    forwardEvaluations: 0,
    iterations: 0,
  };

  const baseline = runForward(ctx, resolved.room, resolved.existingResonators);
  const specs = buildBandSpecs(resolved, baseline);
  const attempts: PrescriptionAttempt[] = [];

  // Added absorption can only shorten T60: a band already at or below the
  // upper tolerance edge needs nothing. The request as a whole is a
  // no-treatment when EVERY pinned band is in that situation.
  const alreadyCompliant = specs.every((spec) => spec.baseline <= spec.upper);
  if (alreadyCompliant) {
    return {
      status: 'already-compliant',
      model: resolved.model,
      strategyUsed: 'none',
      fallbackUsed: false,
      toleranceRatio: resolved.toleranceRatio,
      targets: targetStatuses(
        specs,
        baseline,
        baseline,
        resolved.room.volume,
        resolved.model,
      ),
      prescription: { surfaceTreatments: [], resonators: [] },
      verification: baseline,
      attempts: [
        {
          strategy: 'none',
          status: 'already-compliant',
          limitingBands: [],
          note: 'every pinned band already lies at or below its upper tolerance edge; no additional absorption is required',
        },
      ],
      solver: {
        iterations: ctx.iterations,
        forwardEvaluations: ctx.forwardEvaluations,
      },
    };
  }

  const failingBands = (result: CalculationResult): OctaveBandHz[] =>
    specs
      .map((spec) => spec.band)
      .filter((band) => {
        const t = readT60(result, band, resolved.model);
        const spec = specs.find((s) => s.band === band)!;
        return spec.baseline > spec.upper && (t < spec.lower || t > spec.upper);
      });

  // Independent verification: rebuild the treated scheme and re-run the
  // complete forward calculation from scratch.
  const buildResult = (
    status: PrescriptionResult['status'],
    strategyUsed: 'surface' | 'resonator',
    fallbackUsed: boolean,
    treatments: { surface: SurfaceTreatment[]; resonators: ResonatorTreatment[] },
    treatedRoom: RoomInput,
    extraResonators: ResonatorInput[],
    bestAchievable: CalculationResult | undefined,
    unreachableDetails: PrescriptionResult['unreachableDetails'],
    note: string,
  ): PrescriptionResult => {
    const verification = runForward(ctx, treatedRoom, [
      ...resolved.existingResonators,
      ...extraResonators,
    ]);
    attempts.push({
      strategy: strategyUsed,
      status,
      limitingBands: failingBands(verification),
      note,
    });
    return {
      status,
      model: resolved.model,
      strategyUsed,
      fallbackUsed,
      toleranceRatio: resolved.toleranceRatio,
      targets: targetStatuses(
        specs,
        verification,
        baseline,
        resolved.room.volume,
        resolved.model,
      ),
      prescription: {
        surfaceTreatments: treatments.surface,
        resonators: treatments.resonators,
      },
      verification,
      ...(bestAchievable !== undefined ? { bestAchievable } : {}),
      ...(unreachableDetails !== undefined && unreachableDetails.length > 0
        ? { unreachableDetails }
        : {}),
      attempts,
      solver: {
        iterations: ctx.iterations,
        forwardEvaluations: ctx.forwardEvaluations,
      },
    };
  };

  const unreachableSurfaceDetails = (
    plan: SurfacePlan,
  ): NonNullable<PrescriptionResult['unreachableDetails']> =>
    plan.limitingBands.map((band) => ({
      frequencyHz: band,
      limitation: 'surface-coefficient-ceiling' as const,
      bestAchievableT60Seconds: round4(
        readT60(plan.bestAchievable, band, resolved.model),
      ),
    }));

  // --- Surface path (also the first leg of 'auto') -------------------------
  if (resolved.strategy === 'surface' || resolved.strategy === 'auto') {
    const plan = solveSurfacePath(ctx, baseline);
    if (plan.status === 'solved') {
      return buildResult(
        'solved',
        'surface',
        false,
        { surface: plan.treatments, resonators: [] },
        plan.treatedRoom,
        [],
        undefined,
        undefined,
        'candidate-surface coefficients raised until every pinned band entered its tolerance band',
      );
    }
    if (resolved.strategy === 'surface') {
      return buildResult(
        'unreachable',
        'surface',
        false,
        { surface: [], resonators: [] },
        resolved.room,
        [],
        plan.bestAchievable,
        unreachableSurfaceDetails(plan),
        'saturating every candidate surface at coefficient 1 still leaves pinned bands above their tolerance band; resonator fallback was not requested',
      );
    }
    // auto: record the failed surface leg, then fall through to resonators.
    attempts.push({
      strategy: 'surface',
      status: 'unreachable',
      limitingBands: plan.limitingBands,
      note: 'candidate surfaces at coefficient 1 cannot meet the target; falling back to tuned resonators',
    });
  }

  // --- Resonator path (explicit, or the 'auto' fallback) -------------------
  const plan = solveResonatorPath(ctx, baseline);
  const extraResonators = plan.treatments.map((treatment) => treatment.resonator);
  if (plan.status === 'solved') {
    return buildResult(
      'solved',
      'resonator',
      resolved.strategy === 'auto',
      { surface: [], resonators: plan.treatments },
      resolved.room,
      extraResonators,
      undefined,
      undefined,
      resolved.strategy === 'auto'
        ? 'surface path infeasible; tuned resonator groups bring every pinned band into its tolerance band'
        : 'tuned resonator groups bring every pinned band into its tolerance band, Lorentzian spillover included',
    );
  }

  const t60Of = (result: CalculationResult, band: OctaveBandHz): number =>
    readT60(result, band, resolved.model);

  const details: NonNullable<PrescriptionResult['unreachableDetails']> = [
    ...plan.limitingBands.map((band) => ({
      frequencyHz: band,
      limitation: 'resonator-group-cap' as const,
      bestAchievableT60Seconds: round4(plan.cappedT60ByBand.get(band) ?? t60Of(plan.bestResult, band)),
    })),
    ...plan.spilloverBands.map((band) => ({
      frequencyHz: band,
      limitation: 'resonator-spillover' as const,
      bestAchievableT60Seconds: round4(t60Of(plan.bestResult, band)),
    })),
    ...plan.quantizationBands.map((band) => ({
      frequencyHz: band,
      limitation: 'resonator-quantization' as const,
      bestAchievableT60Seconds: round4(t60Of(plan.bestResult, band)),
    })),
  ];
  return buildResult(
    'unreachable',
    'resonator',
    resolved.strategy === 'auto',
    { surface: [], resonators: plan.treatments },
    resolved.room,
    extraResonators,
    plan.bestResult,
    details,
    plan.limitingBands.length > 0
      ? `even with ${resolved.maxResonatorGroups} resonator groups per band the pinned bands cannot reach their tolerance band`
      : 'absorption required by the pinned bands leaves some bands outside their tolerance band (Lorentzian spillover or integer group granularity)',
  );
}
