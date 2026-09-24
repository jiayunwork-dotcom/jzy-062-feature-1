import { describe, expect, it } from 'vitest';
import {
  HELMHOLTZ_END_CORRECTION,
  REFERENCE_TEMPERATURE_C,
  speedOfSoundMetersPerSecond,
} from '../src/constants';
import { buildResonator } from '../src/helmholtz';
import { validateResonator, ValidationError } from '../src/validation';

const TUNED_500HZ = {
  neckArea: 0.002,
  neckLength: 0.02,
  cavityVolume: 0.00038,
};

describe('speed of sound convention', () => {
  it('is about 343 m/s at the 20 °C reference temperature', () => {
    expect(speedOfSoundMetersPerSecond(REFERENCE_TEMPERATURE_C)).toBeCloseTo(343, 0);
  });

  it('increases with temperature', () => {
    expect(speedOfSoundMetersPerSecond(30)).toBeGreaterThan(
      speedOfSoundMetersPerSecond(10),
    );
  });
});

describe('Helmholtz resonator physics', () => {
  it('applies the end correction L_eff = L + delta * sqrt(S_n / pi)', () => {
    const model = buildResonator(TUNED_500HZ);
    const expected =
      TUNED_500HZ.neckLength +
      HELMHOLTZ_END_CORRECTION * Math.sqrt(TUNED_500HZ.neckArea / Math.PI);
    expect(model.report.effectiveNeckLengthMeters).toBeCloseTo(expected, 12);
  });

  it('computes f0 = (c / 2pi) * sqrt(S_n / (V_c * L_eff))', () => {
    const model = buildResonator(TUNED_500HZ);
    const c = speedOfSoundMetersPerSecond(REFERENCE_TEMPERATURE_C);
    const lEff = model.report.effectiveNeckLengthMeters;
    const expected =
      (c / (2 * Math.PI)) *
      Math.sqrt(TUNED_500HZ.neckArea / (TUNED_500HZ.cavityVolume * lEff));
    expect(model.report.resonanceFrequencyHz).toBeCloseTo(expected, 12);
  });

  it('tunes the documented example geometry to the 500 Hz band', () => {
    const model = buildResonator(TUNED_500HZ);
    expect(model.report.resonanceFrequencyHz).toBeGreaterThan(450);
    expect(model.report.resonanceFrequencyHz).toBeLessThan(550);
  });

  it('keeps c, wavelength and f0 temperature-consistent', () => {
    const model = buildResonator({ ...TUNED_500HZ, temperatureC: 30 });
    const c = speedOfSoundMetersPerSecond(30);
    expect(model.report.speedOfSoundMetersPerSecond).toBeCloseTo(c, 12);
    expect(model.report.wavelengthMeters).toBeCloseTo(
      c / model.report.resonanceFrequencyHz,
      12,
    );
    // Warmer air => faster sound => higher resonance.
    const cooler = buildResonator({ ...TUNED_500HZ, temperatureC: 10 });
    expect(model.report.resonanceFrequencyHz).toBeGreaterThan(
      cooler.report.resonanceFrequencyHz,
    );
  });

  it('concentrates absorption near f0 (Lorentzian band profile)', () => {
    const model = buildResonator(TUNED_500HZ);
    const at500 = model.absorptionAreaAt(500);
    const at250 = model.absorptionAreaAt(250);
    const at1000 = model.absorptionAreaAt(1000);
    const at4000 = model.absorptionAreaAt(4000);
    expect(at500).toBeGreaterThan(10 * at250);
    expect(at500).toBeGreaterThan(10 * at1000);
    expect(at500).toBeGreaterThan(100 * at4000);
  });

  it('scales linearly with the unit count', () => {
    const single = buildResonator(TUNED_500HZ);
    const bank = buildResonator({ ...TUNED_500HZ, count: 40 });
    expect(bank.absorptionAreaAt(500)).toBeCloseTo(40 * single.absorptionAreaAt(500), 9);
  });
});

describe('resonator geometry validation', () => {
  it('rejects a negative neck length with a reason', () => {
    expect(() => validateResonator({ ...TUNED_500HZ, neckLength: -0.01 }, 0)).toThrow(
      ValidationError,
    );
    try {
      validateResonator({ ...TUNED_500HZ, neckLength: -0.01 }, 0);
      expect.unreachable();
    } catch (error) {
      const details = (error as ValidationError).details;
      expect(details.some((d) => d.field === 'resonators[0].neckLength')).toBe(true);
    }
  });

  it('rejects a zero cavity volume', () => {
    expect(() => validateResonator({ ...TUNED_500HZ, cavityVolume: 0 }, 0)).toThrow(
      /cavityVolume/,
    );
  });

  it('rejects a non-positive neck area', () => {
    expect(() => validateResonator({ ...TUNED_500HZ, neckArea: 0 }, 0)).toThrow(
      /neckArea/,
    );
    expect(() => validateResonator({ ...TUNED_500HZ, neckArea: -1 }, 0)).toThrow(
      /neckArea/,
    );
  });

  it('rejects a non-integer or non-positive count', () => {
    expect(() => validateResonator({ ...TUNED_500HZ, count: 2.5 }, 0)).toThrow(/count/);
    expect(() => validateResonator({ ...TUNED_500HZ, count: 0 }, 0)).toThrow(/count/);
  });

  it('accepts a zero neck length (neck-less facing)', () => {
    const resonator = validateResonator({ ...TUNED_500HZ, neckLength: 0 }, 0);
    expect(resonator.neckLength).toBe(0);
  });
});
