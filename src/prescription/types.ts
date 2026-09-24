import type { OctaveBandHz } from '../constants';
import type {
  CalculationResult,
  ResonatorInput,
  RoomInput,
  SurfaceInput,
} from '../types';

export type ReverberationModel = 'sabine' | 'eyring';

/**
 * Which treatment path the solver is allowed to use:
 *  - 'surface': raise coefficients on the candidate surfaces only;
 *  - 'resonator': deploy tuned Helmholtz banks only;
 *  - 'auto': prefer the surface path, fall back to resonators when raising
 *    the candidate surfaces cannot meet every pinned band.
 */
export type TreatmentStrategy = 'surface' | 'resonator' | 'auto';

export type PrescriptionStatus = 'not-needed' | 'solved' | 'unreachable';
export type UsedTreatment = 'none' | 'surface' | 'resonator';

/**
 * Unit template for resonator banks. `count` is never supplied here — the
 * solver determines the number of groups. When `cavityVolume` is omitted the
 * cavity is derived (from the shared Helmholtz conventions) so that f0 lands
 * exactly on the pinned band centre.
 */
export interface ResonatorTemplateInput {
  neckArea: number;
  neckLength: number;
  cavityVolume?: number;
  temperatureC?: number;
}

export interface BandTargetInput {
  t60Seconds: number;
  /** Overrides the request-level toleranceRatio for this band only. */
  toleranceRatio?: number;
}

/** Sparse target map: only the pinned octave bands need an entry. */
export type TargetMapInput = Partial<Record<OctaveBandHz, BandTargetInput>>;

export interface PrescriptionRequest {
  room: RoomInput;
  /** Resonators already installed in the submitted room (baseline). */
  resonators: ResonatorInput[];
  model: ReverberationModel;
  strategy: TreatmentStrategy;
  toleranceRatio: number;
  targets: TargetMapInput;
  candidateSurfaceNames: string[];
  resonatorTemplate: ResonatorTemplateInput | null;
  maxResonatorGroupsPerBand: number;
}

export interface BandTargetSpec {
  frequencyHz: OctaveBandHz;
  targetT60Seconds: number;
  toleranceRatio: number;
  lowerT60Seconds: number;
  upperT60Seconds: number;
}

export interface SurfaceBandPrescription {
  frequencyHz: OctaveBandHz;
  /**
   * The uniform coefficient the candidate surfaces are levelled to for this
   * band (water-fill level). Null when the band needs no added absorption.
   */
  targetCoefficient: number | null;
  /** Candidate surfaces whose existing coefficient was below that level. */
  raisedSurfaceNames: string[];
  /** Extra equivalent absorption area assigned for this band, in m^2. */
  requiredAdditionalAbsorptionSquareMeters: number;
  /** False when even coefficients of 1 on every candidate cannot reach it. */
  feasible: boolean;
}

export interface SurfacePrescription {
  candidateSurfaceNames: string[];
  /**
   * The treated room materials: every surface, all six bands, ready to feed
   * straight back into POST /calculations. Non-candidate surfaces and
   * non-pinned bands are returned unchanged.
   */
  surfaces: SurfaceInput[];
  bands: SurfaceBandPrescription[];
}

export interface ResonatorBankPrescription {
  frequencyHz: OctaveBandHz;
  /** Fully specified bank (count = groups), ready for POST /calculations. */
  resonator: ResonatorInput;
  groups: number;
  /** f0 as reported by the forward resonator model (never re-derived here). */
  resonanceFrequencyHz: number;
  /** Single-unit peak absorption cross-section sigma_0, in m^2. */
  peakAbsorptionAreaSquareMeters: number;
}

export interface ResonatorBandPrescription {
  frequencyHz: OctaveBandHz;
  /** Groups deployed in the bank tuned to this band. */
  groups: number;
  /** Continuous absorption area (m^2) needed to hit the target centre. */
  requiredAdditionalAbsorptionSquareMeters: number;
  /**
   * Absorption this final multi-bank configuration actually contributes at
   * this band — including spillover from the neighbouring banks.
   */
  deliveredAdditionalAbsorptionSquareMeters: number;
  reachedTolerance: boolean;
}

export interface ResonatorPrescription {
  banks: ResonatorBankPrescription[];
  bands: ResonatorBandPrescription[];
}

export interface BandVerification {
  frequencyHz: OctaveBandHz;
  targetT60Seconds: number;
  toleranceRatio: number;
  lowerT60Seconds: number;
  upperT60Seconds: number;
  baselineT60Seconds: number | null;
  achievedT60Seconds: number | null;
  withinTolerance: boolean;
}

export interface UnreachableReport {
  reason: string;
  attemptedStrategy: Exclude<UsedTreatment, 'none'>;
  /** Forward re-check of the best configuration the solver could reach. */
  bestAchievable: CalculationResult;
  bestAchievableBandVerification: BandVerification[];
}

export interface PrescriptionResult {
  status: PrescriptionStatus;
  model: ReverberationModel;
  strategyUsed: UsedTreatment;
  targets: BandTargetSpec[];
  /** Forward calculation on the submitted room (and its baseline resonators). */
  baseline: CalculationResult;
  surface: SurfacePrescription | null;
  resonators: ResonatorPrescription | null;
  /**
   * The authoritative forward re-check: baseline room with the prescribed
   * treatment applied (identical to `baseline` for a not-needed result, and
   * to the best achievable configuration for an unreachable result).
   */
  verification: CalculationResult;
  bandVerification: BandVerification[];
  unreachable: UnreachableReport | null;
}

export interface PrescriptionRecord {
  id: string;
  createdAt: string;
  request: PrescriptionRequest;
  result: PrescriptionResult;
}

// ---- Solver/validation shared boundary values ------------------------------

export const DEFAULT_REVERBERATION_MODEL: ReverberationModel = 'sabine';
export const DEFAULT_TREATMENT_STRATEGY: TreatmentStrategy = 'auto';
/** Target ±5 % if the caller does not configure a tolerance band. */
export const DEFAULT_TOLERANCE_RATIO = 0.05;
/** Tightest configurable tolerance (leaves headroom over 4-dp output rounding). */
export const MIN_TOLERANCE_RATIO = 0.001;
/** Widest configurable tolerance: a band spanning target ±50 %. */
export const MAX_TOLERANCE_RATIO = 0.5;
export const DEFAULT_MAX_RESONATOR_GROUPS_PER_BAND = 2000;
export const HARD_MAX_RESONATOR_GROUPS_PER_BAND = 100_000;
