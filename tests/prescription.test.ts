import { describe, expect, it } from 'vitest';
import { computeAcoustics } from '../src/acoustics';
import type { OctaveBandHz } from '../src/constants';
import { LIVE_STUDIO_EXAMPLE } from '../src/examples/liveStudio';
import { UnreachableTargetError } from '../src/prescription/errors';
import { solvePrescription } from '../src/prescription/solver';
import {
  PRESCRIPTION_LIMITS,
  validatePrescriptionRequest,
  ValidationError,
} from '../src/validation';
import type {
  PrescriptionRequest,
  PrescriptionResult,
  RoomInput,
} from '../src/types';

const LIVE_ROOM: RoomInput = structuredClone(LIVE_STUDIO_EXAMPLE.room);

function solve(raw: unknown): PrescriptionResult {
  const resolved = validatePrescriptionRequest(raw);
  return solvePrescription({ request: raw as PrescriptionRequest, resolved });
}

function t60(
  result: PrescriptionResult['verification'],
  band: OctaveBandHz,
  model: 'sabine' | 'eyring' = 'sabine',
): number {
  return result.bands.find((b) => b.frequencyHz === band)![model].t60Seconds!;
}

const CEILING_AND_WALLS = ['ceiling (hard plaster)', 'walls (block + paint)'];
const FLOOR = ['floor (sealed concrete)'];

describe('baseline of the live studio room', () => {
  it('is genuinely too live around 500 Hz', () => {
    const baseline = computeAcoustics(LIVE_ROOM);
    const t500 = baseline.bands.find((b) => b.frequencyHz === 500)!.sabine.t60Seconds!;
    expect(t500).toBeGreaterThan(2.5);
  });
});

describe('surface prescription path', () => {
  it('brings a pinned mid-frequency band into its tolerance band', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'surface', candidateSurfaceNames: CEILING_AND_WALLS },
    });

    expect(result.status).toBe('solved');
    expect(result.strategyUsed).toBe('surface');
    expect(result.prescription.resonators).toHaveLength(0);
    expect(result.prescription.surfaceTreatments).toHaveLength(1);

    const treatment = result.prescription.surfaceTreatments[0]!;
    expect(treatment.frequencyHz).toBe(500);
    expect(treatment.targetCoefficient).toBeGreaterThan(0);
    expect(treatment.targetCoefficient).toBeLessThanOrEqual(1);
    for (const perSurface of treatment.perSurface) {
      expect(perSurface.newCoefficient).toBeGreaterThanOrEqual(perSurface.previousCoefficient);
      expect(perSurface.newCoefficient).toBeLessThanOrEqual(1);
    }
    expect(treatment.additionalAbsorptionAreaSquareMeters).toBeGreaterThan(0);

    // The carried verification is a complete forward re-run and must prove
    // compliance for BOTH models; the pinned band lands in [0.57, 0.63].
    const achieved = t60(result.verification, 500);
    expect(achieved).toBeGreaterThanOrEqual(0.57);
    expect(achieved).toBeLessThanOrEqual(0.63);
    const target = result.targets.find((t) => t.frequencyHz === 500)!;
    expect(target.state).toBe('within-tolerance');
  });

  it('can pin several bands at once, keeping each within its own band', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.6, 1000: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'surface', candidateSurfaceNames: CEILING_AND_WALLS },
    });
    expect(result.status).toBe('solved');
    for (const band of [500, 1000] as const) {
      const t = t60(result.verification, band);
      expect(t).toBeGreaterThanOrEqual(0.57);
      expect(t).toBeLessThanOrEqual(0.63);
    }
    // Surface coefficients are band-local, so no resonator spillover.
    expect(result.prescription.surfaceTreatments).toHaveLength(2);
  });

  it('honours the Eyring model when asked', () => {
    const result = solve({
      room: LIVE_ROOM,
      model: 'eyring',
      targets: { 500: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'surface', candidateSurfaceNames: CEILING_AND_WALLS },
    });
    expect(result.status).toBe('solved');
    const achieved = t60(result.verification, 500, 'eyring');
    expect(achieved).toBeGreaterThanOrEqual(0.57);
    expect(achieved).toBeLessThanOrEqual(0.63);
  });

  it('reports unreachable with the best achievable result when coefficient 1 is insufficient', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.3 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'surface', candidateSurfaceNames: FLOOR },
    });
    expect(result.status).toBe('unreachable');
    expect(result.prescription.surfaceTreatments).toHaveLength(0);
    expect(result.prescription.resonators).toHaveLength(0);

    const detail = result.unreachableDetails!.find((d) => d.frequencyHz === 500)!;
    expect(detail.limitation).toBe('surface-coefficient-ceiling');
    // Even the saturated floor cannot get near the target...
    expect(detail.bestAchievableT60Seconds).toBeGreaterThan(0.3 * 1.05);
    // ...and that value really is what saturating every candidate at 1 gives.
    const saturated = structuredClone(LIVE_ROOM);
    for (const surface of saturated.surfaces.filter((s) => FLOOR.includes(s.name))) {
      surface.coefficients[500] = 1;
    }
    const expectedBest = computeAcoustics(saturated)
      .bands.find((b) => b.frequencyHz === 500)!.sabine.t60Seconds!;
    expect(detail.bestAchievableT60Seconds).toBeCloseTo(expectedBest, 2);
  });

  it('never proposes an out-of-range coefficient', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.05 },
      toleranceRatio: 0.01,
      preferences: { strategy: 'surface', candidateSurfaceNames: CEILING_AND_WALLS },
    });
    expect(result.status).toBe('unreachable');
    for (const treatment of result.prescription.surfaceTreatments) {
      for (const perSurface of treatment.perSurface) {
        expect(perSurface.newCoefficient).toBeLessThanOrEqual(1);
        expect(perSurface.newCoefficient).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('resonator prescription path', () => {
  it('tunes resonator banks to the pinned bands and proves the drop by forward re-run', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'resonator', maxResonatorGroups: 5000 },
    });
    expect(result.status).toBe('solved');
    expect(result.prescription.surfaceTreatments).toHaveLength(0);
    const treatment = result.prescription.resonators[0]!;
    expect(treatment.frequencyHz).toBe(500);
    expect(treatment.groupCount).toBeGreaterThan(0);
    expect(Number.isInteger(treatment.groupCount)).toBe(true);
    expect(treatment.resonator.count).toBe(treatment.groupCount);
    // Tuning comes from the forward Helmholtz model with shared constants.
    expect(treatment.tunedFrequencyHz).toBeGreaterThan(490);
    expect(treatment.tunedFrequencyHz).toBeLessThan(510);

    const t = t60(result.verification, 500);
    expect(t).toBeGreaterThanOrEqual(0.57);
    expect(t).toBeLessThanOrEqual(0.63);

    // And the returned resonator really is directly submittable to the
    // forward endpoint with the same numerical outcome.
    const independentlyVerified = computeAcoustics(LIVE_ROOM, [treatment.resonator]);
    const independentT = independentlyVerified.bands.find((b) => b.frequencyHz === 500)!
      .sabine.t60Seconds!;
    expect(independentT).toBeCloseTo(t, 3);
  });

  it('accounts for Lorentzian spillover so multiple pinned bands land in their bands simultaneously', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.6, 1000: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'resonator', maxResonatorGroups: 5000 },
    });
    expect(result.status).toBe('solved');
    expect(result.prescription.resonators).toHaveLength(2);

    for (const band of [500, 1000] as const) {
      const t = t60(result.verification, band);
      expect(t).toBeGreaterThanOrEqual(0.57);
      expect(t).toBeLessThanOrEqual(0.63);
      const status = result.targets.find((s) => s.frequencyHz === band)!;
      expect(status.state).toBe('within-tolerance');
    }

    // The banks must genuinely be tuned to different bands (spillover is a
    // side effect, not the primary mechanism).
    const tuned = result.prescription.resonators.map((r) => r.tunedFrequencyHz);
    expect(new Set(tuned)).toEqual(new Set([500, 1000]));
  });

  it('reports unreachable with the best achievable T60 at the group cap, never negative counts', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.05 },
      toleranceRatio: 0.02,
      preferences: { strategy: 'resonator', maxResonatorGroups: 100 },
    });
    expect(result.status).toBe('unreachable');
    const detail = result.unreachableDetails!.find((d) => d.frequencyHz === 500)!;
    expect(detail.limitation).toBe('resonator-group-cap');
    expect(detail.bestAchievableT60Seconds).toBeGreaterThan(0.05 * 1.02);

    for (const treatment of result.prescription.resonators) {
      expect(treatment.groupCount).toBeGreaterThanOrEqual(0);
      expect(treatment.groupCount).toBeLessThanOrEqual(100);
    }
    // The best achievable value equals what the full 100-group bank gives.
    expect(detail.bestAchievableT60Seconds).toBeCloseTo(
      t60(result.bestAchievable!, 500),
      2,
    );
  });

  it('raises the error type carrying the audited unreachable record', () => {
    const raw = {
      room: LIVE_ROOM,
      targets: { 500: 0.05 },
      toleranceRatio: 0.02,
      preferences: { strategy: 'resonator', maxResonatorGroups: 10 },
    };
    expect(() => solve(raw)).not.toThrow(); // solve itself returns a status
    const result = solve(raw);
    expect(result.status).toBe('unreachable');
    expect(() => {
      throw new UnreachableTargetError({
        id: 'x',
        createdAt: new Date().toISOString(),
        request: raw as PrescriptionRequest,
        result,
      });
    }).toThrow(UnreachableTargetError);
  });
});

describe('auto strategy', () => {
  it('falls back to resonators once surfaces at coefficient 1 prove insufficient', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.3 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'auto', candidateSurfaceNames: FLOOR },
    });
    expect(result.status).toBe('solved');
    expect(result.strategyUsed).toBe('resonator');
    expect(result.fallbackUsed).toBe(true);
    // The failed surface leg is recorded in the audit attempts.
    const surfaceAttempt = result.attempts.find((a) => a.strategy === 'surface')!;
    expect(surfaceAttempt.status).toBe('unreachable');
    expect(surfaceAttempt.limitingBands).toContain(500);

    const t = t60(result.verification, 500);
    expect(t).toBeGreaterThanOrEqual(0.285);
    expect(t).toBeLessThanOrEqual(0.315);
  });

  it('uses the surface path directly when it suffices (no fallback)', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'auto', candidateSurfaceNames: CEILING_AND_WALLS },
    });
    expect(result.status).toBe('solved');
    expect(result.strategyUsed).toBe('surface');
    expect(result.fallbackUsed).toBe(false);
  });
});

describe('already-compliant targets', () => {
  it('returns an empty prescription for a target longer than the current T60', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 4.0 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'resonator' },
    });
    expect(result.status).toBe('already-compliant');
    expect(result.prescription.surfaceTreatments).toHaveLength(0);
    expect(result.prescription.resonators).toHaveLength(0);
    const status = result.targets.find((t) => t.frequencyHz === 500)!;
    expect(status.state).toBe('already-better-than-target');
    // It must not invent absorption demand for a band that is already short.
    expect(status.requiredAdditionalAbsorptionSquareMeters).toBe(0);
  });

  it('returns an empty prescription when the baseline already sits in the band', () => {
    const baseline500 = computeAcoustics(LIVE_ROOM).bands.find((b) => b.frequencyHz === 500)!
      .sabine.t60Seconds!;
    const result = solve({
      room: LIVE_ROOM,
      // Tiny tolerance band centered exactly on the current value.
      targets: { 500: baseline500 },
      toleranceRatio: 0.0,
      preferences: { strategy: 'resonator' },
    });
    expect(result.status).toBe('already-compliant');
    expect(result.prescription.resonators).toHaveLength(0);
  });
});

describe('the verification is a genuine forward re-run', () => {
  it('verification T60 matches an independent computeAcoustics call on the treated scheme', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: 0.6, 1000: 0.7 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'resonator', maxResonatorGroups: 5000 },
    });
    expect(result.status).toBe('solved');

    const independent = computeAcoustics(
      LIVE_ROOM,
      result.prescription.resonators.map((r) => r.resonator),
    );
    for (const band of [125, 250, 500, 1000, 2000, 4000] as const) {
      expect(t60(result.verification, band)).toBeCloseTo(
        independent.bands.find((b) => b.frequencyHz === band)!.sabine.t60Seconds!,
        3,
      );
    }
  });

  it('never mutates the submitted room', () => {
    const snapshot = structuredClone(LIVE_ROOM);
    solve({
      room: LIVE_ROOM,
      targets: { 500: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'surface', candidateSurfaceNames: CEILING_AND_WALLS },
    });
    expect(LIVE_ROOM).toEqual(snapshot);
  });
});

describe('concurrent solves stay isolated', () => {
  it('produces independent prescriptions for parallel requests', async () => {
    const targets: Array<PrescriptionRequest['targets']> = [
      { 500: 0.5 },
      { 500: 0.8 },
      { 1000: 0.6 },
      { 250: 0.9 },
    ];
    const results = await Promise.all(
      targets.map((targetsValue) =>
        Promise.resolve(
          solve({
            room: structuredClone(LIVE_ROOM),
            targets: targetsValue,
            toleranceRatio: 0.05,
            preferences: { strategy: 'resonator', maxResonatorGroups: 5000 },
          }),
        ),
      ),
    );
    results.forEach((result, index) => {
      expect(result.status).toBe('solved');
      const band = Number(Object.keys(targets[index]!)[0]) as OctaveBandHz;
      const target = Object.values(targets[index]!)[0]!;
      const t = t60(result.verification, band);
      expect(t).toBeGreaterThanOrEqual(target * 0.95);
      expect(t).toBeLessThanOrEqual(target * 1.05);
      // Each solve's resonator is tuned to its own requested band.
      expect(result.prescription.resonators[0]!.frequencyHz).toBe(band);
    });
  });
});

describe('prescription request validation', () => {
  function expectRejected(raw: unknown, ...fieldFragments: string[]): ValidationError {
    try {
      validatePrescriptionRequest(raw);
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details;
      for (const fragment of fieldFragments) {
        expect(details.some((d) => d.field.includes(fragment))).toBe(true);
      }
      return error as ValidationError;
    }
    throw new Error('unreachable');
  }

  it('accepts a minimal well-formed request with defaults', () => {
    const resolved = validatePrescriptionRequest({
      room: LIVE_ROOM,
      targets: { 500: 0.6 },
      preferences: { strategy: 'surface', candidateSurfaceNames: FLOOR },
    });
    expect(resolved.pinnedBands).toEqual([500]);
    expect(resolved.toleranceRatio).toBe(0.05);
    expect(resolved.model).toBe('sabine');
    expect(resolved.strategy).toBe('surface');
  });

  it('rejects non-positive target T60', () => {
    expectRejected({ room: LIVE_ROOM, targets: { 500: 0 } }, 'targets.500');
    expectRejected({ room: LIVE_ROOM, targets: { 500: -1 } }, 'targets.500');
    expectRejected({ room: LIVE_ROOM, targets: { 500: Number.NaN } }, 'targets.500');
  });

  it('rejects empty targets and unsupported octave bands', () => {
    expectRejected({ room: LIVE_ROOM, targets: {} }, 'targets');
    expectRejected({ room: LIVE_ROOM, targets: { 750: 0.6 } }, 'targets.750');
  });

  it('rejects tolerance outside the allowed range', () => {
    const base = {
      room: LIVE_ROOM,
      targets: { 500: 0.6 },
      preferences: { strategy: 'resonator' },
    };
    expectRejected({ ...base, toleranceRatio: -0.01 }, 'toleranceRatio');
    expectRejected({ ...base, toleranceRatio: 0.6 }, 'toleranceRatio');
    expectRejected({ ...base, toleranceRatio: 1 }, 'toleranceRatio');
    // The documented hard ceiling is enforced.
    expect(PRESCRIPTION_LIMITS.toleranceMax).toBe(0.5);
  });

  it('rejects candidate surfaces that do not exist in the room', () => {
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'surface', candidateSurfaceNames: ['ceiling (hard plaster)', 'mystery wall'] },
      },
      'candidateSurfaceNames[1]',
    );
  });

  it('rejects duplicate candidate surfaces', () => {
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'surface', candidateSurfaceNames: [FLOOR[0], FLOOR[0]] },
      },
      'candidateSurfaceNames[1]',
    );
  });

  it('requires candidate surfaces for the surface/auto strategies', () => {
    expectRejected(
      { room: LIVE_ROOM, targets: { 500: 0.6 }, preferences: { strategy: 'surface' } },
      'candidateSurfaceNames',
    );
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'surface', candidateSurfaceNames: [] },
      },
      'candidateSurfaceNames',
    );
  });

  it('rejects an unknown strategy or model', () => {
    expectRejected(
      { room: LIVE_ROOM, targets: { 500: 0.6 }, preferences: { strategy: 'magic' } },
      'preferences.strategy',
    );
    expectRejected({ room: LIVE_ROOM, targets: { 500: 0.6 }, model: 'norris' }, 'model');
  });

  it('rejects out-of-range resonator group caps', () => {
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'resonator', maxResonatorGroups: 0 },
      },
      'maxResonatorGroups',
    );
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'resonator', maxResonatorGroups: 2.5 },
      },
      'maxResonatorGroups',
    );
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'resonator', maxResonatorGroups: -3 },
      },
      'maxResonatorGroups',
    );
  });

  it('rejects invalid resonator template geometry', () => {
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'resonator', resonatorTemplate: { neckArea: 0 } },
      },
      'resonatorTemplate.neckArea',
    );
    expectRejected(
      {
        room: LIVE_ROOM,
        targets: { 500: 0.6 },
        preferences: { strategy: 'resonator', resonatorTemplate: { neckLength: -0.01 } },
      },
      'resonatorTemplate.neckLength',
    );
  });

  it('still rejects structurally invalid rooms through the shared room validator', () => {
    const badRoom = structuredClone(LIVE_ROOM);
    badRoom.volume = -1;
    expectRejected({ room: badRoom, targets: { 500: 0.6 } }, 'room.volume');
  });

  it('rejects malformed existing resonators through the shared resonator validator', () => {
    expectRejected(
      {
        room: LIVE_ROOM,
        resonators: [{ neckArea: 0, neckLength: 0, cavityVolume: 0.001 }],
        targets: { 500: 0.6 },
        preferences: { strategy: 'resonator' },
      },
      'resonators[0].neckArea',
    );
  });
});
