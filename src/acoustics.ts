import {
  AIR_ATTENUATION_NP_PER_M,
  CRITICAL_DISTANCE_COEFFICIENT,
  OCTAVE_BANDS_HZ,
  SABINE_COEFFICIENT,
  SCHROEDER_COEFFICIENT,
  publicConstants,
} from './constants';
import { buildResonator } from './helmholtz';
import type {
  BandAbsorption,
  BandResult,
  CalculationResult,
  ModelBandResult,
  ResonatorInput,
  RoomInput,
} from './types';

/** Round to 4 decimal places for a stable, readable API payload. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Map non-finite results (degenerate zero/full absorption) to JSON-safe null. */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? round4(value) : null;
}

/**
 * Derived room quantities for one model, from the T60 the model has just
 * produced. The Schroeder frequency is deliberately computed from THIS
 * calculation's T60 — never from a decoupled constant.
 */
function derivedQuantities(volume: number, t60: number): ModelBandResult {
  return {
    t60Seconds: finiteOrNull(t60),
    criticalDistanceMeters: finiteOrNull(
      CRITICAL_DISTANCE_COEFFICIENT * Math.sqrt(volume / t60),
    ),
    schroederFrequencyHz: finiteOrNull(
      SCHROEDER_COEFFICIENT * Math.sqrt(t60 / volume),
    ),
  };
}

export function totalSurfaceArea(room: RoomInput): number {
  return room.surfaces.reduce((sum, surface) => sum + surface.area, 0);
}

/** Surface absorption per band A_surface = sum of S_i * alpha_i, in m^2. */
export function surfaceAbsorptionPerBand(room: RoomInput): Map<number, number> {
  const result = new Map<number, number>();
  for (const band of OCTAVE_BANDS_HZ) {
    let sum = 0;
    for (const surface of room.surfaces) {
      sum += surface.area * surface.coefficients[band];
    }
    result.set(band, sum);
  }
  return result;
}

/**
 * Run the full reverberation calculation for a validated room plus zero or
 * more validated Helmholtz resonators.
 *
 * Sabine:  A = A_surface + 4*m*V + A_resonators,  T60 = 0.161*V / A.
 * Eyring:  T60 = 0.161*V / (-S*ln(1 - alphaBar) + 4*m*V + A_resonators),
 *          with the mean coefficient alphaBar = A_surface / S taken over
 *          surfaces only. The air term 4*m*V is shared with Sabine so both
 *          models coincide as alphaBar -> 0 (a hard requirement); the model
 *          difference lives entirely in the -S*ln(1 - alphaBar) surface
 *          term. NOTE the minus sign: -ln(1 - a) is positive for 0 < a < 1.
 *          Flipping it would make high-absorption rooms diverge in the
 *          wrong direction, which the test-suite guards against.
 */
export function computeAcoustics(
  room: RoomInput,
  resonators: ResonatorInput[] = [],
): CalculationResult {
  const volume = room.volume;
  const surfaceArea = totalSurfaceArea(room);
  const surfaceAbsorption = surfaceAbsorptionPerBand(room);
  const resonatorModels = resonators.map(buildResonator);

  const bands: BandResult[] = OCTAVE_BANDS_HZ.map((band) => {
    const surface = surfaceAbsorption.get(band)!;
    const air = 4 * AIR_ATTENUATION_NP_PER_M[band] * volume;
    const resonatorAbsorption = resonatorModels.reduce(
      (sum, model) => sum + model.absorptionAreaAt(band),
      0,
    );

    const absorption: BandAbsorption = {
      surface: round4(surface),
      air: round4(air),
      resonators: round4(resonatorAbsorption),
      total: round4(surface + air + resonatorAbsorption),
    };

    // Sabine: air attenuation and resonators are part of the total A.
    const sabineT60 =
      (SABINE_COEFFICIENT * volume) / (surface + air + resonatorAbsorption);

    // Eyring: mean coefficient over surfaces only; air attenuation and
    // resonators enter as discrete equivalent absorption areas added to
    // the surface term -S*ln(1 - alphaBar).
    const meanAlpha = surface / surfaceArea;
    const eyringDenominator =
      meanAlpha >= 1
        ? Number.POSITIVE_INFINITY
        : -surfaceArea * Math.log(1 - meanAlpha) + air + resonatorAbsorption;
    const eyringT60 = (SABINE_COEFFICIENT * volume) / eyringDenominator;

    return {
      frequencyHz: band,
      absorption,
      meanAbsorptionCoefficient: round4(meanAlpha),
      sabine: derivedQuantities(volume, sabineT60),
      eyring: derivedQuantities(volume, eyringT60),
    };
  });

  return {
    room: {
      name: room.name,
      volume,
      totalSurfaceArea: round4(surfaceArea),
      surfaces: room.surfaces,
    },
    resonators: resonatorModels.map((model) => model.report),
    constants: publicConstants(),
    bands,
  };
}
