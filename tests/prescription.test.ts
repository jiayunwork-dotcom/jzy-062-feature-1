import { describe, expect, it } from 'vitest';
import { computeAcoustics } from '../src/acoustics';
import { OCTAVE_BANDS_HZ } from '../src/constants';
import { validatePrescriptionRequest } from '../src/prescription/validation';
import { solvePrescription } from '../src/prescription/solver';
import type { PrescriptionRequest, PrescriptionResult } from '../src/prescription/types';
import type { RoomInput } from '../src/types';

// A deliberately "live" (reverberant) studio: hard plaster everywhere,
// V = 120 m^3, S = 150 m^2, alpha ~= 0.02 — mid-frequency Sabine T60 ~= 6 s.
const LIVE_ROOM: RoomInput = {
  name: 'live-studio',
  volume: 120,
  surfaces: [
    {
      name: 'floor',
      area: 40,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
    {
      name: 'ceiling',
      area: 40,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
    {
      name: 'walls',
      area: 70,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
  ],
};

function solve(raw: unknown): PrescriptionResult {
  return solvePrescription(validatePrescriptionRequest(raw));
}

function verificationBand(result: PrescriptionResult, band: number) {
  const found = result.bandVerification.find((v) => v.frequencyHz === band);
  if (!found) throw new Error(`no verification for band ${band}`);
  return found;
}

describe('live-room baseline sanity', () => {
  it('is genuinely reverberant at 500 Hz', () => {
    const baseline = computeAcoustics(LIVE_ROOM);
    const t500 = baseline.bands.find((b) => b.frequencyHz === 500)!.sabine.t60Seconds!;
    expect(t500).toBeGreaterThan(4);
  });
});

describe('surface path: inverse prescription verified through the forward kernel', () => {
  it('pulls 500 Hz into the target band and the forward re-check proves it', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling', 'walls'],
    });

    expect(result.status).toBe('solved');
    expect(result.strategyUsed).toBe('surface');
    const check = verificationBand(result, 500);
    expect(check.withinTolerance).toBe(true);
    // The achieved T60 is the value the UNMODIFIED forward kernel produced
    // when fed the prescribed materials.
    expect(check.achievedT60Seconds).toBeGreaterThanOrEqual(0.57 - 1e-9);
    expect(check.achievedT60Seconds).toBeLessThanOrEqual(0.63 + 1e-9);

    // Independently re-run the prescribed surfaces through the forward API.
    const rechecked = computeAcoustics(
      { ...LIVE_ROOM, surfaces: result.surface!.surfaces },
      [],
    );
    const t500 = rechecked.bands.find((b) => b.frequencyHz === 500)!.sabine.t60Seconds!;
    expect(t500).toBeGreaterThanOrEqual(0.57 - 1e-9);
    expect(t500).toBeLessThanOrEqual(0.63 + 1e-9);

    // Physical limit honoured: no coefficient exceeds 1.
    for (const surface of result.surface!.surfaces) {
      for (const band of OCTAVE_BANDS_HZ) {
        expect(surface.coefficients[band]).toBeLessThanOrEqual(1);
        expect(surface.coefficients[band]).toBeGreaterThanOrEqual(0);
      }
    }

    // Non-pinned bands are returned unchanged.
    const floor = result.surface!.surfaces.find((s) => s.name === 'floor')!;
    for (const band of OCTAVE_BANDS_HZ) expect(floor.coefficients[band]).toBe(0.02);
    const ceiling = result.surface!.surfaces.find((s) => s.name === 'ceiling')!;
    for (const band of [125, 250, 1000, 2000, 4000] as const) {
      expect(ceiling.coefficients[band]).toBe(0.02);
    }
  });

  it('prescribes additional equivalent absorption, not less than zero', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling', 'walls'],
    });
    const band = result.surface!.bands[0]!;
    expect(band.requiredAdditionalAbsorptionSquareMeters).toBeGreaterThan(0);
    expect(band.targetCoefficient).toBeGreaterThan(0.02);
    expect(band.targetCoefficient).toBeLessThanOrEqual(1);
  });

  it('levels every pinned band at once for multi-band targets', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.8 }, 1000: { t60Seconds: 0.9 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling', 'walls'],
    });
    expect(result.status).toBe('solved');
    expect(verificationBand(result, 500).withinTolerance).toBe(true);
    expect(verificationBand(result, 1000).withinTolerance).toBe(true);
  });
});

describe('already-compliant targets yield an empty prescription', () => {
  it('does not add any treatment when the baseline already sits in the band', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 6.0, toleranceRatio: 0.1 } },
      strategy: 'surface',
      candidateSurfaces: ['ceiling'],
    });
    expect(result.status).toBe('not-needed');
    expect(result.strategyUsed).toBe('none');
    expect(result.surface).toBeNull();
    expect(result.resonators).toBeNull();
    // The verification block still carries the forward re-check (baseline).
    expect(verificationBand(result, 500).withinTolerance).toBe(true);
  });

  it('a target longer than the baseline but NOT containing it is unreachable', () => {
    // Baseline 6.0 s; target 8 s ±5 % = [7.6, 8.4] — adding absorption cannot
    // lengthen the room, so this must not be quietly called "solved".
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 8 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling'],
    });
    expect(result.status).toBe('unreachable');
  });
});

describe('physically unreachable targets are reported honestly', () => {
  it('surface path: saturating candidates at alpha=1 still falls short', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.05 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling'],
    });
    expect(result.status).toBe('unreachable');
    expect(result.unreachable).not.toBeNull();
    expect(result.unreachable!.attemptedStrategy).toBe('surface');
    expect(result.unreachable!.reason).toMatch(/physical limit|cannot bring|cannot reach/);

    // Best achievable configuration + per-band forward re-check included.
    const best = verificationBand(result, 500);
    expect(best.achievedT60Seconds).not.toBeNull();
    expect(best.achievedT60Seconds).toBeGreaterThan(0.63 / 10); // a real, finite time
    expect(best.achievedT60Seconds).toBeGreaterThan(0.0525);
    // Saturation used the physical ceiling, never crossed it.
    for (const surface of result.surface!.surfaces) {
      expect(surface.coefficients[500]).toBeLessThanOrEqual(1);
    }
    const ceiling = result.surface!.surfaces.find((s) => s.name === 'ceiling')!;
    expect(ceiling.coefficients[500]).toBe(1);
    const band = result.surface!.bands[0]!;
    expect(band.feasible).toBe(false);
  });

  it('resonator path: hitting the group cap still falls short', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.2 } },
      toleranceRatio: 0.05,
      strategy: 'resonator',
      resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
      maxResonatorGroupsPerBand: 100,
    });
    expect(result.status).toBe('unreachable');
    expect(result.strategyUsed).toBe('resonator');
    // Exactly the capped number of groups — never negative, never over cap.
    expect(result.resonators!.banks[0]!.groups).toBe(100);
    expect(result.unreachable).not.toBeNull();
    expect(verificationBand(result, 500).achievedT60Seconds).toBeGreaterThan(0.21);
  });
});

describe('resonator path: Lorentzian spillover coupling is solved, not ignored', () => {
  it('meets both 500 and 1000 Hz simultaneously and reports spillover delivery', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 1.2 }, 1000: { t60Seconds: 1.5 } },
      toleranceRatio: 0.05,
      strategy: 'resonator',
      resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
    });
    expect(result.status).toBe('solved');
    expect(result.strategyUsed).toBe('resonator');
    for (const band of [500, 1000]) {
      const check = verificationBand(result, band);
      expect(check.withinTolerance).toBe(true);
    }

    // Two tuned banks, positive integer groups, f0 on the pinned bands.
    expect(result.resonators!.banks).toHaveLength(2);
    for (const bank of result.resonators!.banks) {
      expect(Number.isInteger(bank.groups)).toBe(true);
      expect(bank.groups).toBeGreaterThan(0);
      expect(bank.resonanceFrequencyHz).toBeGreaterThan(bank.frequencyHz / Math.SQRT2);
      expect(bank.resonanceFrequencyHz).toBeLessThan(bank.frequencyHz * Math.SQRT2);
    }

    // The solver had to account for each bank's Lorentzian tail on the other
    // pinned band: delivered absorption at a band exceeds its own bank's
    // contribution alone.
    const rechecked = computeAcoustics(LIVE_ROOM, result.resonators!.banks.map((b) => b.resonator));
    for (const band of [500, 1000]) {
      const t = rechecked.bands.find((b) => b.frequencyHz === band)!.sabine.t60Seconds!;
      const spec = result.targets.find((s) => s.frequencyHz === band)!;
      expect(t).toBeGreaterThanOrEqual(spec.lowerT60Seconds - 1e-9);
      expect(t).toBeLessThanOrEqual(spec.upperT60Seconds + 1e-9);
    }

    // Neighbouring unpinned bands were moved, but much less than pinned ones.
    const baseline = computeAcoustics(LIVE_ROOM);
    const drop = (band: number) =>
      baseline.bands.find((b) => b.frequencyHz === band)!.sabine.t60Seconds! -
      rechecked.bands.find((b) => b.frequencyHz === band)!.sabine.t60Seconds!;
    expect(Math.abs(drop(250))).toBeLessThan(drop(500));
    expect(Math.abs(drop(2000))).toBeLessThan(drop(1000));
  });

  it('uses a fixed-cavity template verbatim (validated to lie in the band)', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 1.0 } },
      toleranceRatio: 0.05,
      strategy: 'resonator',
      resonatorUnit: { neckArea: 0.002, neckLength: 0.02, cavityVolume: 0.00038 },
    });
    expect(result.status).toBe('solved');
    const bank = result.resonators!.banks[0]!;
    expect(bank.resonator.cavityVolume).toBeCloseTo(0.00038, 12);
    expect(bank.resonanceFrequencyHz).toBeGreaterThan(450);
    expect(bank.resonanceFrequencyHz).toBeLessThan(550);
  });
});

describe('auto strategy prefers surfaces and falls back to resonators', () => {
  it('uses surfaces when they alone can meet the target', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      toleranceRatio: 0.05,
      strategy: 'auto',
      candidateSurfaces: ['ceiling', 'walls'],
      resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
    });
    expect(result.status).toBe('solved');
    expect(result.strategyUsed).toBe('surface');
    expect(result.resonators).toBeNull();
  });

  it('falls back to resonators when the candidate surfaces cannot reach it', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.3 } },
      toleranceRatio: 0.05,
      strategy: 'auto',
      candidateSurfaces: ['ceiling'],
      resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
    });
    expect(result.status).toBe('solved');
    expect(result.strategyUsed).toBe('resonator');
    // The failed surface attempt is retained for inspection.
    expect(result.surface).not.toBeNull();
    expect(result.surface!.bands[0]!.feasible).toBe(false);
    expect(verificationBand(result, 500).withinTolerance).toBe(true);
  });
});

describe('model selection: Eyring targets invert through the Eyring kernel', () => {
  it('surface prescription hits the Eyring target and passes the Eyring re-check', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      toleranceRatio: 0.05,
      model: 'eyring',
      strategy: 'surface',
      candidateSurfaces: ['ceiling', 'walls'],
    });
    expect(result.status).toBe('solved');
    const check = verificationBand(result, 500);
    expect(check.withinTolerance).toBe(true);
    // Sabine would be longer than Eyring for high alpha, so the achieved
    // Sabine value need not be in the Eyring band — only Eyring is pinned.
    const rechecked = computeAcoustics(
      { ...LIVE_ROOM, surfaces: result.surface!.surfaces },
      [],
    );
    const tEyring = rechecked.bands.find((b) => b.frequencyHz === 500)!.eyring.t60Seconds!;
    expect(tEyring).toBeGreaterThanOrEqual(0.57 - 1e-9);
    expect(tEyring).toBeLessThanOrEqual(0.63 + 1e-9);
  });
});

describe('per-band tolerance overrides', () => {
  it('accepts a tight override for one band while another stays on the default', () => {
    const result = solve({
      room: LIVE_ROOM,
      targets: {
        500: { t60Seconds: 0.6, toleranceRatio: 0.01 },
        1000: { t60Seconds: 0.9 },
      },
      toleranceRatio: 0.1,
      strategy: 'surface',
      candidateSurfaces: ['ceiling', 'walls'],
    });
    expect(result.status).toBe('solved');
    const at500 = verificationBand(result, 500);
    expect(at500.toleranceRatio).toBe(0.01);
    expect(at500.achievedT60Seconds).toBeGreaterThanOrEqual(0.594 - 1e-9);
    expect(at500.achievedT60Seconds).toBeLessThanOrEqual(0.606 + 1e-9);
    expect(verificationBand(result, 1000).toleranceRatio).toBe(0.1);
  });
});

describe('solver is stateless: concurrent runs never bleed into each other', () => {
  it('eight parallel solves over different rooms keep their own prescriptions', async () => {
    const requests: PrescriptionRequest[] = Array.from({ length: 8 }, (_, index) =>
      validatePrescriptionRequest({
        room: {
          ...structuredClone(LIVE_ROOM),
          name: `parallel-${index}`,
          volume: 80 + index * 30,
        },
        targets: { 500: { t60Seconds: 0.6 } },
        toleranceRatio: 0.05,
        strategy: 'surface',
        candidateSurfaces: ['ceiling', 'walls'],
      }),
    );
    const results = await Promise.all(requests.map((r) => Promise.resolve(solvePrescription(r))));
    for (const [index, result] of results.entries()) {
      expect(result.status).toBe('solved');
      expect(result.verification.room.name).toBe(`parallel-${index}`);
      expect(result.verification.room.volume).toBeCloseTo(80 + index * 30, 9);
      expect(verificationBand(result, 500).withinTolerance).toBe(true);
    }
    // The original room object must not have been mutated.
    expect(LIVE_ROOM.surfaces[1]!.coefficients[500]).toBe(0.02);
  });
});
