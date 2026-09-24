import { describe, expect, it } from 'vitest';
import { computeAcoustics } from '../src/acoustics';
import {
  CRITICAL_DISTANCE_COEFFICIENT,
  OCTAVE_BANDS_HZ,
  SABINE_COEFFICIENT,
  SCHROEDER_COEFFICIENT,
} from '../src/constants';
import { CLASSROOM_EXAMPLE } from '../src/examples/classroom';
import type { BandResult, RoomInput } from '../src/types';

function band(result: { bands: BandResult[] }, frequencyHz: number): BandResult {
  const found = result.bands.find((b) => b.frequencyHz === frequencyHz);
  if (!found) throw new Error(`band ${frequencyHz} missing`);
  return found;
}

/** Scale every absorption coefficient, clamping to the physical range. */
function scaledRoom(room: RoomInput, factor: number): RoomInput {
  return {
    ...room,
    surfaces: room.surfaces.map((surface) => ({
      ...surface,
      coefficients: Object.fromEntries(
        Object.entries(surface.coefficients).map(([frequency, alpha]) => [
          frequency,
          Math.min(1, alpha * factor),
        ]),
      ) as RoomInput['surfaces'][number]['coefficients'],
    })),
  };
}

describe('classroom example sanity', () => {
  const result = computeAcoustics(CLASSROOM_EXAMPLE.room);

  it('produces a result for every pinned octave band', () => {
    expect(result.bands.map((b) => b.frequencyHz)).toEqual([...OCTAVE_BANDS_HZ]);
  });

  it('has mid-frequency Sabine T60 in a plausible classroom range (0.1–2 s)', () => {
    for (const frequency of [500, 1000, 2000]) {
      const t60 = band(result, frequency).sabine.t60Seconds;
      expect(t60).not.toBeNull();
      expect(t60!).toBeGreaterThan(0.1);
      expect(t60!).toBeLessThan(2);
    }
  });

  it('never produces a negative or zero T60 in any band, for either model', () => {
    for (const b of result.bands) {
      expect(b.sabine.t60Seconds).not.toBeNull();
      expect(b.eyring.t60Seconds).not.toBeNull();
      expect(b.sabine.t60Seconds!).toBeGreaterThan(0);
      expect(b.eyring.t60Seconds!).toBeGreaterThan(0);
    }
  });

  it('reports total absorption = surface + air + resonators', () => {
    for (const b of result.bands) {
      expect(b.absorption.total).toBeCloseTo(
        b.absorption.surface + b.absorption.air + b.absorption.resonators,
        3,
      );
    }
  });

  it('includes air attenuation 4*m*V in the Sabine absorption', () => {
    for (const b of result.bands) {
      expect(b.absorption.air).toBeGreaterThan(0);
    }
  });
});

describe('derived quantities use the T60 from this very calculation', () => {
  const result = computeAcoustics(CLASSROOM_EXAMPLE.room);
  const volume = CLASSROOM_EXAMPLE.room.volume;

  it('critical distance follows dc = 0.057 * sqrt(V / T60)', () => {
    for (const b of result.bands) {
      const expected =
        CRITICAL_DISTANCE_COEFFICIENT * Math.sqrt(volume / b.sabine.t60Seconds!);
      expect(b.sabine.criticalDistanceMeters!).toBeCloseTo(expected, 1);
    }
  });

  it('Schroeder frequency follows fs = 2000 * sqrt(T60 / V)', () => {
    for (const b of result.bands) {
      const expected =
        SCHROEDER_COEFFICIENT * Math.sqrt(b.sabine.t60Seconds! / volume);
      expect(b.sabine.schroederFrequencyHz!).toBeCloseTo(expected, 0);
    }
  });

  it('Sabine T60 equals 0.161 * V / A_total recomputed from the breakdown', () => {
    for (const b of result.bands) {
      const expected = (SABINE_COEFFICIENT * volume) / b.absorption.total;
      expect(b.sabine.t60Seconds!).toBeCloseTo(expected, 2);
    }
  });
});

describe('monotonicity: more absorption => shorter T60, larger critical distance', () => {
  const base = computeAcoustics(CLASSROOM_EXAMPLE.room);
  const treated = computeAcoustics(scaledRoom(CLASSROOM_EXAMPLE.room, 1.5));

  it('T60 decreases in every band for both models', () => {
    for (const frequency of OCTAVE_BANDS_HZ) {
      const before = band(base, frequency);
      const after = band(treated, frequency);
      expect(after.sabine.t60Seconds!).toBeLessThan(before.sabine.t60Seconds!);
      expect(after.eyring.t60Seconds!).toBeLessThan(before.eyring.t60Seconds!);
    }
  });

  it('critical distance increases in every band for both models', () => {
    for (const frequency of OCTAVE_BANDS_HZ) {
      const before = band(base, frequency);
      const after = band(treated, frequency);
      expect(after.sabine.criticalDistanceMeters!).toBeGreaterThan(
        before.sabine.criticalDistanceMeters!,
      );
      expect(after.eyring.criticalDistanceMeters!).toBeGreaterThan(
        before.eyring.criticalDistanceMeters!,
      );
    }
  });
});

describe('Sabine vs Eyring agreement limits', () => {
  const bareRoom: RoomInput = {
    name: 'bare-box',
    volume: 200,
    surfaces: [
      {
        name: 'all-surfaces',
        area: 220,
        coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
      },
    ],
  };

  it('low absorption: the two models nearly coincide', () => {
    const result = computeAcoustics(bareRoom);
    for (const b of result.bands) {
      const sabine = b.sabine.t60Seconds!;
      const eyring = b.eyring.t60Seconds!;
      expect(Math.abs(sabine - eyring) / sabine).toBeLessThan(0.05);
    }
  });

  it('high absorption: Eyring is markedly shorter than Sabine (sign guard)', () => {
    const liveRoom = scaledRoom(bareRoom, 45); // alpha -> 0.9 everywhere
    const result = computeAcoustics(liveRoom);
    for (const b of result.bands) {
      const sabine = b.sabine.t60Seconds!;
      const eyring = b.eyring.t60Seconds!;
      // A flipped sign in -S*ln(1-a) would make Eyring negative or longer
      // than Sabine; both must be impossible here.
      expect(eyring).toBeGreaterThan(0);
      expect(eyring).toBeLessThan(0.7 * sabine);
    }
  });

  it('mean absorption coefficient is A_surface / S', () => {
    const result = computeAcoustics(CLASSROOM_EXAMPLE.room);
    const surfaceArea = result.room.totalSurfaceArea;
    for (const b of result.bands) {
      expect(b.meanAbsorptionCoefficient).toBeCloseTo(
        b.absorption.surface / surfaceArea,
        3,
      );
    }
  });
});
