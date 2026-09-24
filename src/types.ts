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

// ---------------------------------------------------------------------------
// Goal-driven absorption prescriptions (inverse solver)
// ---------------------------------------------------------------------------

export type ReverberationModel = 'sabine' | 'eyring';
export type TreatmentStrategy = 'surface' | 'resonator' | 'auto';

/** Sparse map: only the pinned octave bands carry a target T60 (seconds). */
export type T60Targets = Partial<Record<OctaveBandHz, number>>;

/** Caller-supplied geometry hints for resonators the solver may design. */
export interface ResonatorTemplateInput {
  neckArea?: number;
  neckLength?: number;
  temperatureC?: number;
}

export interface PrescriptionPreferencesInput {
  /** Preferred treatment path; 'auto' tries surfaces first, then resonators. */
  strategy?: TreatmentStrategy;
  /** Surfaces whose coefficient may be raised (matched by surface name). */
  candidateSurfaceNames?: string[];
  /** Geometry template for designed resonators (cavity is always tuned by the solver). */
  resonatorTemplate?: ResonatorTemplateInput;
  /** Hard cap on resonator groups (units) per tuned band. */
  maxResonatorGroups?: number;
}

export interface PrescriptionRequest {
  room: RoomInput;
  /** Resonators already installed in the submitted scheme; the solver adds on top. */
  resonators?: ResonatorInput[];
  targets: T60Targets;
  /** Acceptable band half-width as a fraction of target, e.g. 0.05 = ±5 %. */
  toleranceRatio?: number;
  model?: ReverberationModel;
  preferences?: PrescriptionPreferencesInput;
}

/** Validated request with every solver default resolved. */
export interface ResolvedPrescriptionRequest {
  room: RoomInput;
  existingResonators: ResonatorInput[];
  targets: T60Targets;
  pinnedBands: OctaveBandHz[];
  toleranceRatio: number;
  model: ReverberationModel;
  strategy: TreatmentStrategy;
  candidateSurfaceNames: string[];
  resonatorTemplate: {
    neckArea: number;
    neckLength: number;
    temperatureC: number;
  };
  maxResonatorGroups: number;
}

export type TargetBandState =
  /** Baseline T60 sits inside the tolerance band; the band was left alone. */
  | 'already-compliant'
  /** Baseline T60 is already shorter than the target minus tolerance. */
  | 'already-better-than-target'
  /** The prescription brought an over-long band into the tolerance band. */
  | 'within-tolerance'
  /** Best effort still leaves the band above the tolerance band. */
  | 'unreachable'
  /** Absorption needed for other pinned bands pushes it below the lower edge. */
  | 'over-treated';

export interface PrescriptionTargetStatus {
  frequencyHz: OctaveBandHz;
  targetT60Seconds: number;
  lowerBoundSeconds: number;
  upperBoundSeconds: number;
  baselineT60Seconds: number;
  achievedT60Seconds: number;
  state: TargetBandState;
  /** Extra equivalent absorption (m^2) the target demands over baseline, > 0 only. */
  requiredAdditionalAbsorptionSquareMeters: number;
}

export interface SurfaceTreatment {
  frequencyHz: OctaveBandHz;
  surfaceNames: string[];
  /** Common coefficient level the candidate surfaces are raised to (≤ 1). */
  targetCoefficient: number;
  perSurface: Array<{
    name: string;
    areaSquareMeters: number;
    previousCoefficient: number;
    newCoefficient: number;
  }>;
  /** Added equivalent absorption area at the tuned band, in m^2. */
  additionalAbsorptionAreaSquareMeters: number;
}

export interface ResonatorTreatment {
  frequencyHz: OctaveBandHz;
  /** Number of identical resonator units tuned to this band (>= 1). */
  groupCount: number;
  /** Ready-to-submit resonator (same shape as POST /calculations accepts). */
  resonator: ResonatorInput;
  /** Achieved tuning, reported by the forward resonator model. */
  tunedFrequencyHz: number;
  cavityVolumeCubicMeters: number;
  peakAbsorptionAreaSquareMeters: number;
  /** Added equivalent absorption at the tuned band: count * sigma0, in m^2. */
  additionalAbsorptionAreaAtBandSquareMeters: number;
}

export interface Prescription {
  surfaceTreatments: SurfaceTreatment[];
  resonators: ResonatorTreatment[];
}

export type PrescriptionStatus = 'already-compliant' | 'solved' | 'unreachable';
export type UsedStrategy = 'none' | 'surface' | 'resonator';

export interface PrescriptionAttempt {
  strategy: UsedStrategy;
  status: PrescriptionStatus;
  /** Bands this attempt could not bring into the tolerance band, if any. */
  limitingBands: OctaveBandHz[];
  note: string;
}

export interface PrescriptionResult {
  status: PrescriptionStatus;
  model: ReverberationModel;
  strategyUsed: UsedStrategy;
  /** True when the surface path was tried first and could not meet the targets. */
  fallbackUsed: boolean;
  toleranceRatio: number;
  targets: PrescriptionTargetStatus[];
  prescription: Prescription;
  /** Full forward re-run (computeAcoustics) of the room WITH the prescription. */
  verification: CalculationResult;
  /** For unreachable targets: the closest point the search could reach. */
  bestAchievable?: CalculationResult;
  unreachableDetails?: Array<{
    frequencyHz: OctaveBandHz;
    limitation:
      | 'surface-coefficient-ceiling'
      | 'resonator-group-cap'
      | 'resonator-spillover'
      | 'resonator-quantization';
    bestAchievableT60Seconds: number;
  }>;
  attempts: PrescriptionAttempt[];
  solver: {
    iterations: number;
    forwardEvaluations: number;
  };
}

/** A persisted prescription solve: request snapshot + solver result. */
export interface PrescriptionRecord {
  id: string;
  createdAt: string;
  request: PrescriptionRequest;
  result: PrescriptionResult;
}
