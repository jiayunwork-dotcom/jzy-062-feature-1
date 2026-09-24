/**
 * Physical constants and conventions for the room-acoustics kernel.
 *
 * This module is the SINGLE source of truth for every constant used by the
 * Sabine model, the Eyring model, the derived quantities (critical distance,
 * Schroeder frequency) and the Helmholtz resonator model. Both reverberation
 * models import from here — coefficients must never be re-declared per model.
 *
 * Conventions (documented in README.md):
 *  - Reference temperature 20 °C, at which the speed of sound is ~343 m/s.
 *  - The metric Sabine coefficient 0.161 s/m is consistent with that speed.
 *  - Air attenuation `m` follows ISO 9613-1 at 20 °C / 70 % RH, converted
 *    from dB/km to Nepers/m by dividing by (1000 * 10*log10(e)) = 4343.
 */
export const REFERENCE_TEMPERATURE_C = 20;

/** Metric Sabine/Eyring coefficient in s/m (consistent with c ≈ 343 m/s). */
export const SABINE_COEFFICIENT = 0.161;

/**
 * Critical distance coefficient for an omnidirectional source (Q = 1) in a
 * diffuse field: dc = 0.057 * sqrt(V / T60), in metres.
 */
export const CRITICAL_DISTANCE_COEFFICIENT = 0.057;

/** Schroeder frequency: fs = 2000 * sqrt(T60 / V), in Hz. */
export const SCHROEDER_COEFFICIENT = 2000;

/** End-correction factor delta for the Helmholtz resonator effective neck. */
export const HELMHOLTZ_END_CORRECTION = 1.7;

/**
 * Quality factor of the resonator's Lorentzian absorption profile. The
 * half-width at half-maximum is gamma = f0 / (2 * Q) — one fixed choice,
 * shared by every resonator calculation in the service.
 */
export const RESONATOR_QUALITY_FACTOR = 5;

/** Pinned octave-band centre frequencies, in Hz. */
export const OCTAVE_BANDS_HZ = [125, 250, 500, 1000, 2000, 4000] as const;
export type OctaveBandHz = (typeof OCTAVE_BANDS_HZ)[number];

/**
 * Air attenuation coefficient m in Nepers/m per octave band.
 * Derived from ISO 9613-1 attenuation at 20 °C, 70 % relative humidity,
 * 101.325 kPa (dB/km) divided by 4343 (1000 * 10*log10(e)):
 *   125 Hz: 0.41 dB/km, 250 Hz: 1.04, 500 Hz: 1.96,
 *   1000 Hz: 3.66, 2000 Hz: 9.66, 4000 Hz: 32.8.
 */
export const AIR_ATTENUATION_NP_PER_M: Readonly<Record<OctaveBandHz, number>> = {
  125: 9.44e-5,
  250: 2.39e-4,
  500: 4.51e-4,
  1000: 8.43e-4,
  2000: 2.22e-3,
  4000: 7.55e-3,
};

/**
 * Speed of sound in air as a function of temperature, in m/s:
 * c(T) = 331.3 * sqrt(1 + T / 273.15). At 20 °C this gives ~343.2 m/s, which
 * is the same convention the Sabine coefficient above is built on, so the
 * reverberation kernel and the resonator model never disagree about c.
 */
export function speedOfSoundMetersPerSecond(temperatureC: number): number {
  return 331.3 * Math.sqrt(1 + temperatureC / 273.15);
}

/** Constants block exposed via the API for traceability of calculations. */
export function publicConstants(): import('./types').ConstantsSnapshot {
  return {
    referenceTemperatureC: REFERENCE_TEMPERATURE_C,
    speedOfSoundAtReferenceMetersPerSecond: speedOfSoundMetersPerSecond(
      REFERENCE_TEMPERATURE_C,
    ),
    sabineCoefficient: SABINE_COEFFICIENT,
    criticalDistanceCoefficient: CRITICAL_DISTANCE_COEFFICIENT,
    schroederCoefficient: SCHROEDER_COEFFICIENT,
    helmholtzEndCorrection: HELMHOLTZ_END_CORRECTION,
    resonatorQualityFactor: RESONATOR_QUALITY_FACTOR,
    octaveBandsHz: [...OCTAVE_BANDS_HZ],
    airAttenuationNpPerM: { ...AIR_ATTENUATION_NP_PER_M },
  };
}
