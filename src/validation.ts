import {
  OCTAVE_BANDS_HZ,
  REFERENCE_TEMPERATURE_C,
  type OctaveBandHz,
} from './constants';
import type {
  BandCoefficients,
  CalculationRequest,
  ResolvedPrescriptionRequest,
  ResonatorInput,
  ReverberationModel,
  RoomInput,
  SurfaceInput,
  T60Targets,
  TreatmentStrategy,
} from './types';

export interface FieldError {
  field: string;
  reason: string;
}

/**
 * Raised whenever input geometry or material data is invalid. Carries a
 * structured, per-field reason list so the HTTP layer can reject the
 * request with a meaningful error body.
 */
export class ValidationError extends Error {
  readonly details: FieldError[];

  constructor(details: FieldError[]) {
    super(
      `Validation failed: ${details
        .map((d) => `${d.field} ${d.reason}`)
        .join('; ')}`,
    );
    this.name = 'ValidationError';
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFiniteNumber(
  value: unknown,
  field: string,
  errors: FieldError[],
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field, reason: 'must be a finite number' });
    return false;
  }
  return true;
}

function validateCoefficients(
  raw: unknown,
  field: string,
  errors: FieldError[],
): BandCoefficients | null {
  if (!isRecord(raw)) {
    errors.push({ field, reason: 'must be an object keyed by octave-band frequency' });
    return null;
  }
  const allowed = new Set<string>(OCTAVE_BANDS_HZ.map(String));
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        field: `${field}.${key}`,
        reason: `is not a supported octave band; supported bands are ${OCTAVE_BANDS_HZ.join(', ')} Hz`,
      });
      ok = false;
    }
  }
  const coefficients = {} as Record<OctaveBandHz, number>;
  for (const band of OCTAVE_BANDS_HZ) {
    const value = raw[String(band)];
    if (value === undefined) {
      errors.push({ field: `${field}.${band}`, reason: 'is required (all six octave bands must be given)' });
      ok = false;
      continue;
    }
    if (!validateFiniteNumber(value, `${field}.${band}`, errors)) {
      ok = false;
      continue;
    }
    if (value < 0 || value > 1) {
      errors.push({
        field: `${field}.${band}`,
        reason: `must be between 0 and 1 inclusive, got ${value}`,
      });
      ok = false;
      continue;
    }
    coefficients[band] = value;
  }
  return ok ? coefficients : null;
}

function validateSurface(raw: unknown, index: number, errors: FieldError[]): SurfaceInput | null {
  const field = `room.surfaces[${index}]`;
  if (!isRecord(raw)) {
    errors.push({ field, reason: 'must be an object' });
    return null;
  }
  let ok = true;

  let name = `surface-${index + 1}`;
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
      errors.push({ field: `${field}.name`, reason: 'must be a non-empty string when given' });
      ok = false;
    } else {
      name = raw.name;
    }
  }

  if (!validateFiniteNumber(raw.area, `${field}.area`, errors)) {
    ok = false;
  } else if ((raw.area as number) <= 0) {
    errors.push({ field: `${field}.area`, reason: `must be positive, got ${raw.area}` });
    ok = false;
  }

  const coefficients = validateCoefficients(raw.coefficients, `${field}.coefficients`, errors);
  if (coefficients === null) ok = false;

  return ok ? { name, area: raw.area as number, coefficients: coefficients! } : null;
}

export function validateRoom(raw: unknown): RoomInput {
  const errors: FieldError[] = [];

  if (!isRecord(raw)) {
    throw new ValidationError([{ field: 'room', reason: 'must be an object' }]);
  }

  let ok = true;

  let name = 'unnamed-room';
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
      errors.push({ field: 'room.name', reason: 'must be a non-empty string when given' });
      ok = false;
    } else {
      name = raw.name;
    }
  }

  if (!validateFiniteNumber(raw.volume, 'room.volume', errors)) {
    ok = false;
  } else if ((raw.volume as number) <= 0) {
    errors.push({ field: 'room.volume', reason: `must be positive, got ${raw.volume}` });
    ok = false;
  }

  const surfaces: SurfaceInput[] = [];
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0) {
    errors.push({ field: 'room.surfaces', reason: 'must be a non-empty array of surfaces' });
    ok = false;
  } else {
    raw.surfaces.forEach((surface, index) => {
      const validated = validateSurface(surface, index, errors);
      if (validated === null) {
        ok = false;
      } else {
        surfaces.push(validated);
      }
    });
  }

  if (!ok || errors.length > 0) {
    throw new ValidationError(errors);
  }
  return { name, volume: raw.volume as number, surfaces };
}

export function validateResonator(raw: unknown, index: number): ResonatorInput {
  const field = `resonators[${index}]`;
  const errors: FieldError[] = [];
  if (!isRecord(raw)) {
    throw new ValidationError([{ field, reason: 'must be an object' }]);
  }

  if (validateFiniteNumber(raw.neckArea, `${field}.neckArea`, errors)) {
    if ((raw.neckArea as number) <= 0) {
      errors.push({ field: `${field}.neckArea`, reason: `must be positive, got ${raw.neckArea}` });
    }
  }
  if (validateFiniteNumber(raw.neckLength, `${field}.neckLength`, errors)) {
    if ((raw.neckLength as number) < 0) {
      errors.push({ field: `${field}.neckLength`, reason: `must not be negative, got ${raw.neckLength}` });
    }
  }
  if (validateFiniteNumber(raw.cavityVolume, `${field}.cavityVolume`, errors)) {
    if ((raw.cavityVolume as number) <= 0) {
      errors.push({ field: `${field}.cavityVolume`, reason: `must be positive, got ${raw.cavityVolume}` });
    }
  }

  let temperatureC: number | undefined;
  if (raw.temperatureC !== undefined) {
    if (validateFiniteNumber(raw.temperatureC, `${field}.temperatureC`, errors)) {
      const t = raw.temperatureC as number;
      if (t <= -273.15) {
        errors.push({ field: `${field}.temperatureC`, reason: 'must be above absolute zero' });
      } else {
        temperatureC = t;
      }
    }
  }

  let count: number | undefined;
  if (raw.count !== undefined) {
    if (
      typeof raw.count !== 'number' ||
      !Number.isInteger(raw.count) ||
      raw.count < 1
    ) {
      errors.push({ field: `${field}.count`, reason: 'must be a positive integer' });
    } else {
      count = raw.count;
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
  return {
    neckArea: raw.neckArea as number,
    neckLength: raw.neckLength as number,
    cavityVolume: raw.cavityVolume as number,
    ...(temperatureC !== undefined ? { temperatureC } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

/** Validate the full POST /calculations body. Throws ValidationError. */
export function validateCalculationRequest(raw: unknown): CalculationRequest {
  if (!isRecord(raw)) {
    throw new ValidationError([{ field: 'body', reason: 'must be a JSON object' }]);
  }

  // Collect room and resonator problems in a single pass so the caller sees
  // every rejection reason at once.
  const errors: FieldError[] = [];
  const collect = (section: () => void): void => {
    try {
      section();
    } catch (error) {
      if (error instanceof ValidationError) {
        errors.push(...error.details);
      } else {
        throw error;
      }
    }
  };

  let room: RoomInput | null = null;
  collect(() => {
    room = validateRoom(raw.room);
  });

  const resonators: ResonatorInput[] = [];
  if (raw.resonators !== undefined) {
    if (!Array.isArray(raw.resonators)) {
      errors.push({ field: 'resonators', reason: 'must be an array' });
    } else {
      raw.resonators.forEach((resonator, index) => {
        collect(() => {
          resonators.push(validateResonator(resonator, index));
        });
      });
    }
  }

  if (errors.length > 0 || room === null) {
    throw new ValidationError(errors);
  }
  return { room, resonators };
}

// ---------------------------------------------------------------------------
// Goal-driven prescription request validation
// ---------------------------------------------------------------------------

/** Solver-side input limits (documented in README.md). */
export const PRESCRIPTION_LIMITS = {
  toleranceMin: 0.0,
  toleranceMax: 0.5,
  maxResonatorGroupsMax: 1_000_000,
} as const;

const TREATMENT_STRATEGIES: readonly TreatmentStrategy[] = ['surface', 'resonator', 'auto'];
const REVERBERATION_MODELS: readonly ReverberationModel[] = ['sabine', 'eyring'];

/**
 * Validate the POST /prescriptions body and resolve every solver default.
 * Reuses the same room/resonator validators and the same ValidationError
 * shape as ordinary calculation requests.
 */
export function validatePrescriptionRequest(raw: unknown): ResolvedPrescriptionRequest {
  if (!isRecord(raw)) {
    throw new ValidationError([{ field: 'body', reason: 'must be a JSON object' }]);
  }

  const errors: FieldError[] = [];
  const collect = (section: () => void): void => {
    try {
      section();
    } catch (error) {
      if (error instanceof ValidationError) {
        errors.push(...error.details);
      } else {
        throw error;
      }
    }
  };

  let room: RoomInput | null = null;
  collect(() => {
    room = validateRoom(raw.room);
  });

  const existingResonators: ResonatorInput[] = [];
  if (raw.resonators !== undefined) {
    if (!Array.isArray(raw.resonators)) {
      errors.push({ field: 'resonators', reason: 'must be an array' });
    } else {
      raw.resonators.forEach((resonator, index) => {
        collect(() => {
          existingResonators.push(validateResonator(resonator, index));
        });
      });
    }
  }

  // ---- Targets: sparse map keyed by octave band, positive T60 values ------
  const targets: T60Targets = {};
  const pinnedBands: OctaveBandHz[] = [];
  if (!isRecord(raw.targets)) {
    errors.push({
      field: 'targets',
      reason:
        'must be an object mapping octave-band frequency to a positive target T60 in seconds',
    });
  } else {
    const allowed = new Set<string>(OCTAVE_BANDS_HZ.map(String));
    for (const key of Object.keys(raw.targets)) {
      if (!allowed.has(key)) {
        errors.push({
          field: `targets.${key}`,
          reason: `is not a supported octave band; supported bands are ${OCTAVE_BANDS_HZ.join(', ')} Hz`,
        });
        continue;
      }
      const value = (raw.targets as Record<string, unknown>)[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ field: `targets.${key}`, reason: 'must be a finite number of seconds' });
        continue;
      }
      if (value <= 0) {
        errors.push({ field: `targets.${key}`, reason: `must be positive, got ${value}` });
        continue;
      }
      const band = Number(key) as OctaveBandHz;
      targets[band] = value;
      pinnedBands.push(band);
    }
    if (pinnedBands.length === 0) {
      errors.push({
        field: 'targets',
        reason: 'must pin at least one octave band to a positive target T60',
      });
    }
    pinnedBands.sort((a, b) => OCTAVE_BANDS_HZ.indexOf(a) - OCTAVE_BANDS_HZ.indexOf(b));
  }

  // ---- Tolerance ratio ----------------------------------------------------
  let toleranceRatio = 0.05;
  if (raw.toleranceRatio !== undefined) {
    if (
      typeof raw.toleranceRatio !== 'number' ||
      !Number.isFinite(raw.toleranceRatio)
    ) {
      errors.push({ field: 'toleranceRatio', reason: 'must be a finite number' });
    } else if (
      raw.toleranceRatio < PRESCRIPTION_LIMITS.toleranceMin ||
      raw.toleranceRatio > PRESCRIPTION_LIMITS.toleranceMax
    ) {
      errors.push({
        field: 'toleranceRatio',
        reason: `must be between ${PRESCRIPTION_LIMITS.toleranceMin} and ${PRESCRIPTION_LIMITS.toleranceMax} inclusive (a fraction of the target), got ${raw.toleranceRatio}`,
      });
    } else {
      toleranceRatio = raw.toleranceRatio;
    }
  }

  // ---- Model preference ---------------------------------------------------
  let model: ReverberationModel = 'sabine';
  if (raw.model !== undefined) {
    if (
      typeof raw.model !== 'string' ||
      !REVERBERATION_MODELS.includes(raw.model as ReverberationModel)
    ) {
      errors.push({
        field: 'model',
        reason: `must be one of ${REVERBERATION_MODELS.join(', ')}`,
      });
    } else {
      model = raw.model as ReverberationModel;
    }
  }

  // ---- Treatment preferences ---------------------------------------------
  let strategy: TreatmentStrategy = 'auto';
  let candidateSurfaceNames: string[] = [];
  let resonatorTemplate = {
    neckArea: 0.002,
    neckLength: 0.02,
    temperatureC: REFERENCE_TEMPERATURE_C,
  };
  let maxResonatorGroups = 2000;

  const preferences = raw.preferences;
  if (preferences !== undefined && !isRecord(preferences)) {
    errors.push({ field: 'preferences', reason: 'must be an object when given' });
  }
  const prefs = isRecord(preferences) ? preferences : {};

  if (prefs.strategy !== undefined) {
    if (
      typeof prefs.strategy !== 'string' ||
      !TREATMENT_STRATEGIES.includes(prefs.strategy as TreatmentStrategy)
    ) {
      errors.push({
        field: 'preferences.strategy',
        reason: `must be one of ${TREATMENT_STRATEGIES.join(', ')}`,
      });
    } else {
      strategy = prefs.strategy as TreatmentStrategy;
    }
  }

  if (prefs.candidateSurfaceNames !== undefined) {
    if (!Array.isArray(prefs.candidateSurfaceNames)) {
      errors.push({ field: 'preferences.candidateSurfaceNames', reason: 'must be an array of surface names' });
    } else {
      const seen = new Set<string>();
      prefs.candidateSurfaceNames.forEach((name, index) => {
        if (typeof name !== 'string' || name.trim() === '') {
          errors.push({
            field: `preferences.candidateSurfaceNames[${index}]`,
            reason: 'must be a non-empty surface name',
          });
          return;
        }
        if (seen.has(name)) {
          errors.push({
            field: `preferences.candidateSurfaceNames[${index}]`,
            reason: `duplicate candidate surface '${name}'`,
          });
          return;
        }
        seen.add(name);
        if (room !== null && !room.surfaces.some((surface) => surface.name === name)) {
          errors.push({
            field: `preferences.candidateSurfaceNames[${index}]`,
            reason: `no surface named '${name}' exists in the submitted room`,
          });
          return;
        }
        candidateSurfaceNames.push(name);
      });
    }
  }
  if (
    (strategy === 'surface' || strategy === 'auto') &&
    isRecord(preferences) &&
    prefs.candidateSurfaceNames !== undefined &&
    candidateSurfaceNames.length === 0 &&
    !errors.some((error) => error.field === 'preferences.candidateSurfaceNames')
  ) {
    errors.push({
      field: 'preferences.candidateSurfaceNames',
      reason: `must name at least one existing surface when strategy is '${strategy}'`,
    });
  }
  if (
    (strategy === 'surface' || strategy === 'auto') &&
    isRecord(preferences) &&
    prefs.candidateSurfaceNames === undefined
  ) {
    errors.push({
      field: 'preferences.candidateSurfaceNames',
      reason: `is required when strategy is '${strategy}' (name the surfaces whose coefficient may be raised)`,
    });
  }

  if (prefs.resonatorTemplate !== undefined) {
    if (!isRecord(prefs.resonatorTemplate)) {
      errors.push({ field: 'preferences.resonatorTemplate', reason: 'must be an object when given' });
    } else {
      const template = prefs.resonatorTemplate;
      if (template.neckArea !== undefined) {
        if (
          typeof template.neckArea !== 'number' ||
          !Number.isFinite(template.neckArea) ||
          template.neckArea <= 0
        ) {
          errors.push({
            field: 'preferences.resonatorTemplate.neckArea',
            reason: `must be a positive number in m^2, got ${String(template.neckArea)}`,
          });
        } else {
          resonatorTemplate.neckArea = template.neckArea;
        }
      }
      if (template.neckLength !== undefined) {
        if (
          typeof template.neckLength !== 'number' ||
          !Number.isFinite(template.neckLength) ||
          template.neckLength < 0
        ) {
          errors.push({
            field: 'preferences.resonatorTemplate.neckLength',
            reason: `must be a non-negative number in m, got ${String(template.neckLength)}`,
          });
        } else {
          resonatorTemplate.neckLength = template.neckLength;
        }
      }
      if (template.temperatureC !== undefined) {
        if (
          typeof template.temperatureC !== 'number' ||
          !Number.isFinite(template.temperatureC) ||
          template.temperatureC <= -273.15
        ) {
          errors.push({
            field: 'preferences.resonatorTemplate.temperatureC',
            reason: 'must be a finite temperature above absolute zero',
          });
        } else {
          resonatorTemplate.temperatureC = template.temperatureC;
        }
      }
    }
  }

  if (prefs.maxResonatorGroups !== undefined) {
    const max = prefs.maxResonatorGroups;
    if (typeof max !== 'number' || !Number.isFinite(max)) {
      errors.push({ field: 'preferences.maxResonatorGroups', reason: 'must be a finite number' });
    } else if (!Number.isInteger(max) || max < 1) {
      errors.push({
        field: 'preferences.maxResonatorGroups',
        reason: `must be a positive integer, got ${String(max)}`,
      });
    } else if (max > PRESCRIPTION_LIMITS.maxResonatorGroupsMax) {
      errors.push({
        field: 'preferences.maxResonatorGroups',
        reason: `must not exceed ${PRESCRIPTION_LIMITS.maxResonatorGroupsMax} groups per band`,
      });
    } else {
      maxResonatorGroups = max;
    }
  }

  if (errors.length > 0 || room === null) {
    throw new ValidationError(errors);
  }

  return {
    room,
    existingResonators,
    targets,
    pinnedBands,
    toleranceRatio,
    model,
    strategy,
    candidateSurfaceNames,
    resonatorTemplate,
    maxResonatorGroups,
  };
}
