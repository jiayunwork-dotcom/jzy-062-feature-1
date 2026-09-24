import type { OctaveBandHz } from './constants';

/** Absorption coefficients keyed by octave-band centre frequency. */
export type BandCoefficients = Record<OctaveBandHz, number>;

export interface SurfaceInput {
  name: string;
  area: number;
  coefficients: BandCoefficients;
}

export interface RoomInput {
  name: string;
  volume: number;
  surfaces: SurfaceInput[];
}

export interface ResonatorInput {
  /** Neck cross-section area S_n in m^2. Must be > 0. */
  neckArea: number;
  /** Neck length L in m. Must be >= 0 (0 = neck-less perforated facing). */
  neckLength: number;
  /** Cavity volume V_c in m^3. Must be > 0. */
  cavityVolume: number;
  /** Air temperature in °C; defaults to the reference temperature. */
  temperatureC?: number;
  /** Number of identical resonators installed; defaults to 1. */
  count?: number;
}

export interface CalculationRequest {
  room: RoomInput;
  resonators: ResonatorInput[];
}

/** Per-band absorption budget in m^2 (equivalent absorption area). */
export interface BandAbsorption {
  surface: number;
  air: number;
  resonators: number;
  total: number;
}

export interface ModelBandResult {
  /** Reverberation time in seconds; null when the value is non-finite. */
  t60Seconds: number | null;
  criticalDistanceMeters: number | null;
  schroederFrequencyHz: number | null;
}

export interface BandResult {
  frequencyHz: OctaveBandHz;
  absorption: BandAbsorption;
  /** Mean surface absorption coefficient A_surface / S (surface only). */
  meanAbsorptionCoefficient: number;
  sabine: ModelBandResult;
  eyring: ModelBandResult;
}

/** Derived, temperature-consistent description of one resonator. */
export interface ResonatorReport {
  input: Required<ResonatorInput>;
  speedOfSoundMetersPerSecond: number;
  effectiveNeckLengthMeters: number;
  resonanceFrequencyHz: number;
  wavelengthMeters: number;
  /** Peak absorption cross-section of a single unit at f0, in m^2. */
  peakAbsorptionAreaSquareMeters: number;
}

export interface ConstantsSnapshot {
  referenceTemperatureC: number;
  speedOfSoundAtReferenceMetersPerSecond: number;
  sabineCoefficient: number;
  criticalDistanceCoefficient: number;
  schroederCoefficient: number;
  helmholtzEndCorrection: number;
  resonatorQualityFactor: number;
  octaveBandsHz: number[];
  airAttenuationNpPerM: Record<string, number>;
}

export interface CalculationResult {
  room: {
    name: string;
    volume: number;
    totalSurfaceArea: number;
    surfaces: SurfaceInput[];
  };
  resonators: ResonatorReport[];
  constants: ConstantsSnapshot;
  bands: BandResult[];
}

/** A persisted calculation: request snapshot + computed result. */
export interface CalculationRecord {
  id: string;
  createdAt: string;
  request: CalculationRequest;
  result: CalculationResult;
}
