import {
  HELMHOLTZ_END_CORRECTION,
  REFERENCE_TEMPERATURE_C,
  RESONATOR_QUALITY_FACTOR,
  speedOfSoundMetersPerSecond,
} from './constants';
import type { ResonatorInput, ResonatorReport } from './types';

export interface ResonatorModel {
  report: ResonatorReport;
  /**
   * Total equivalent absorption area (all units of `count`) contributed at
   * the given frequency, in m^2. Lorentzian in frequency with half-width
   * gamma = f0 / (2 * Q).
   */
  absorptionAreaAt(frequencyHz: number): number;
}

/**
 * Build the physical model of one Helmholtz resonator (or `count` identical
 * ones). Input must already be validated (positive neck area and cavity
 * volume, non-negative neck length).
 *
 * All three of speed of sound, wavelength and resonance frequency derive
 * from the same temperature, so they stay mutually consistent.
 */
export function buildResonator(input: ResonatorInput): ResonatorModel {
  const temperatureC = input.temperatureC ?? REFERENCE_TEMPERATURE_C;
  const count = input.count ?? 1;

  const c = speedOfSoundMetersPerSecond(temperatureC);
  const effectiveNeckLength =
    input.neckLength + HELMHOLTZ_END_CORRECTION * Math.sqrt(input.neckArea / Math.PI);
  const resonanceFrequency =
    (c / (2 * Math.PI)) *
    Math.sqrt(input.neckArea / (input.cavityVolume * effectiveNeckLength));
  const wavelength = c / resonanceFrequency;

  // Peak absorption cross-section of one resonator at f0 (matched-loss
  // resonator): sigma_0 = lambda^2 / (2*pi).
  const peakAbsorptionArea = (wavelength * wavelength) / (2 * Math.PI);

  // Lorentzian half-width at half-maximum, fixed via the shared Q factor.
  const halfWidth = resonanceFrequency / (2 * RESONATOR_QUALITY_FACTOR);

  const report: ResonatorReport = {
    input: {
      neckArea: input.neckArea,
      neckLength: input.neckLength,
      cavityVolume: input.cavityVolume,
      temperatureC,
      count,
    },
    speedOfSoundMetersPerSecond: c,
    effectiveNeckLengthMeters: effectiveNeckLength,
    resonanceFrequencyHz: resonanceFrequency,
    wavelengthMeters: wavelength,
    peakAbsorptionAreaSquareMeters: peakAbsorptionArea,
  };

  return {
    report,
    absorptionAreaAt(frequencyHz: number): number {
      const detuning = (frequencyHz - resonanceFrequency) / halfWidth;
      return (count * peakAbsorptionArea) / (1 + detuning * detuning);
    },
  };
}
