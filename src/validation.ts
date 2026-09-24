import { OCTAVE_BANDS_HZ, type OctaveBandHz } from './constants';
import type {
  BandCoefficients,
  CalculationRequest,
  ResonatorInput,
  RoomInput,
  SurfaceInput,
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
