import { describe, expect, it } from 'vitest';
import { computeAcoustics } from '../src/acoustics';
import { SABINE_COEFFICIENT } from '../src/constants';
import {
  CLASSROOM_EXAMPLE,
  CLASSROOM_RESONATOR_EXAMPLE,
} from '../src/examples/classroom';
import type { BandResult } from '../src/types';

function band(result: { bands: BandResult[] }, frequencyHz: number): BandResult {
  const found = result.bands.find((b) => b.frequencyHz === frequencyHz);
  if (!found) throw new Error(`band ${frequencyHz} missing`);
  return found;
}

const baseline = computeAcoustics(CLASSROOM_EXAMPLE.room);
const treated = computeAcoustics(
  CLASSROOM_RESONATOR_EXAMPLE.room,
  CLASSROOM_RESONATOR_EXAMPLE.resonators,
);

describe('Helmholtz resonator integrated into the reverberation calculation', () => {
  it('reports the resonator as tuned to the 500 Hz band', () => {
    expect(treated.resonators).toHaveLength(1);
    const f0 = treated.resonators[0]!.resonanceFrequencyHz;
    expect(f0).toBeGreaterThan(450);
    expect(f0).toBeLessThan(550);
  });

  it('lowers the 500 Hz band T60 (both models)', () => {
    expect(band(treated, 500).sabine.t60Seconds!).toBeLessThan(
      band(baseline, 500).sabine.t60Seconds!,
    );
    expect(band(treated, 500).eyring.t60Seconds!).toBeLessThan(
      band(baseline, 500).eyring.t60Seconds!,
    );
  });

  it('leaves neighbouring bands far less affected than the tuned band', () => {
    const drop = (frequency: number) =>
      band(baseline, frequency).sabine.t60Seconds! -
      band(treated, frequency).sabine.t60Seconds!;

    const target = drop(500);
    expect(target).toBeGreaterThan(0);
    for (const neighbour of [125, 250, 1000, 2000, 4000]) {
      expect(Math.abs(drop(neighbour))).toBeLessThan(target / 5);
    }
  });

  it('adds the resonator absorption almost exclusively to the 500 Hz band', () => {
    const added500 = band(treated, 500).absorption.resonators;
    expect(added500).toBeGreaterThan(0);
    for (const frequency of [125, 250, 1000, 2000, 4000]) {
      expect(band(treated, frequency).absorption.resonators).toBeLessThan(added500 / 10);
    }
  });

  it('recomputes T60 from the new total absorption instead of adjusting the old curve', () => {
    // The reported T60 must equal 0.161 * V / A_total with A_total already
    // containing the resonator contribution — i.e. a fresh pass through the
    // Sabine kernel, not baseline-minus-a-delta.
    const volume = CLASSROOM_EXAMPLE.room.volume;
    for (const b of treated.bands) {
      const recomputed = (SABINE_COEFFICIENT * volume) / b.absorption.total;
      expect(b.sabine.t60Seconds!).toBeCloseTo(recomputed, 2);
    }
    // And the 500 Hz drop must be exactly what the added absorption implies.
    const before = band(baseline, 500);
    const after = band(treated, 500);
    const expectedTotal =
      before.absorption.surface + before.absorption.air + after.absorption.resonators;
    expect(after.absorption.total).toBeCloseTo(expectedTotal, 3);
    const expectedT60 = (SABINE_COEFFICIENT * volume) / expectedTotal;
    expect(after.sabine.t60Seconds!).toBeCloseTo(expectedT60, 2);
  });

  it('keeps every band T60 positive after treatment', () => {
    for (const b of treated.bands) {
      expect(b.sabine.t60Seconds!).toBeGreaterThan(0);
      expect(b.eyring.t60Seconds!).toBeGreaterThan(0);
    }
  });
});
