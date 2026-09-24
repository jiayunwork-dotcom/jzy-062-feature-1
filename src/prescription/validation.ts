import { OCTAVE_BANDS_HZ, type OctaveBandHz } from '../constants';
import { buildResonator } from '../helmholtz';
import {
  validateResonator,
  validateRoom,
  ValidationError,
  type FieldError,
} from '../validation';

export { ValidationError };
export type { FieldError };
import {
  DEFAULT_MAX_RESONATOR_GROUPS_PER_BAND,
  DEFAULT_REVERBERATION_MODEL,
  DEFAULT_TOLERANCE_RATIO,
  DEFAULT_TREATMENT_STRATEGY,
  HARD_MAX_RESONATOR_GROUPS_PER_BAND,
  MAX_TOLERANCE_RATIO,
  MIN_TOLERANCE_RATIO,
  type PrescriptionRequest,
  type ResonatorTemplateInput,
  type ReverberationModel,
  type TargetMapInput,
  type TreatmentStrategy,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collect(
  errors: FieldError[],
  section: () => void,
): void {
  try {
    section();
  } catch (error) {
    if (error instanceof ValidationError) {
      errors.push(...error.details);
    } else {
      throw error;
    }
  }
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

function validateTolerance(
  value: unknown,
  field: string,
  errors: FieldError[],
): number | null {
  if (!validateFiniteNumber(value, field, errors)) return null;
  const ratio = value as number;
  if (ratio < MIN_TOLERANCE_RATIO || ratio > MAX_TOLERANCE_RATIO) {
    errors.push({
      field,
      reason: `must be between ${MIN_TOLERANCE_RATIO} and ${MAX_TOLERANCE_RATIO} inclusive, got ${ratio}`,
    });
    return null;
  }
  return ratio;
}

/**
 * Validate a resonator *template*. Unlike the forward API's resonator input,
 * `count` must not be present (the solver decides the number of groups) and
 * `cavityVolume` is optional — when omitted the solver derives it so the
 * bank tunes to the pinned band.
 */
function validateTemplate(raw: unknown): {
  template: ResonatorTemplateInput | null;
  errors: FieldError[];
} {
  const errors: FieldError[] = [];
  const field = 'resonatorUnit';
  if (!isRecord(raw)) {
    return { template: null, errors: [{ field, reason: 'must be an object' }] };
  }
  if (raw.count !== undefined) {
    errors.push({
      field: `${field}.count`,
      reason: 'must not be given on a unit template; the solver determines the number of groups',
    });
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
  let cavityVolume: number | undefined;
  if (raw.cavityVolume !== undefined) {
    if (validateFiniteNumber(raw.cavityVolume, `${field}.cavityVolume`, errors)) {
      if ((raw.cavityVolume as number) <= 0) {
        errors.push({ field: `${field}.cavityVolume`, reason: `must be positive, got ${raw.cavityVolume}` });
      } else {
        cavityVolume = raw.cavityVolume as number;
      }
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
  if (errors.length > 0) return { template: null, errors };
  const template: ResonatorTemplateInput = {
    neckArea: raw.neckArea as number,
    neckLength: raw.neckLength as number,
    ...(cavityVolume !== undefined ? { cavityVolume } : {}),
    ...(temperatureC !== undefined ? { temperatureC } : {}),
  };
  return { template, errors };
}

function validateTargets(
  raw: unknown,
  errors: FieldError[],
): { targets: TargetMapInput; pinnedBands: OctaveBandHz[] } {
  const field = 'targets';
  const targets: TargetMapInput = {};
  const pinnedBands: OctaveBandHz[] = [];
  if (!isRecord(raw)) {
    errors.push({ field, reason: 'must be an object keyed by octave-band frequency' });
    return { targets, pinnedBands };
  }
  const allowed = new Set<string>(OCTAVE_BANDS_HZ.map(String));
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        field: `${field}.${key}`,
        reason: `is not a supported octave band; supported bands are ${OCTAVE_BANDS_HZ.join(', ')} Hz`,
      });
    }
  }
  for (const band of OCTAVE_BANDS_HZ) {
    const entry = raw[String(band)];
    if (entry === undefined || entry === null) continue; // unpinned band
    const entryField = `${field}.${band}`;
    if (!isRecord(entry)) {
      errors.push({ field: entryField, reason: 'must be an object with t60Seconds' });
      continue;
    }
    let bandOk = true;
    let t60: number | null = null;
    if (!validateFiniteNumber(entry.t60Seconds, `${entryField}.t60Seconds`, errors)) {
      bandOk = false;
    } else if ((entry.t60Seconds as number) <= 0) {
      errors.push({
        field: `${entryField}.t60Seconds`,
        reason: `must be positive, got ${entry.t60Seconds}`,
      });
      bandOk = false;
    } else {
      t60 = entry.t60Seconds as number;
    }
    let toleranceRatio: number | undefined;
    if (entry.toleranceRatio !== undefined) {
      const validated = validateTolerance(
        entry.toleranceRatio,
        `${entryField}.toleranceRatio`,
        errors,
      );
      if (validated === null) {
        bandOk = false;
      } else {
        toleranceRatio = validated;
      }
    }
    if (bandOk) {
      targets[band] = {
        t60Seconds: t60!,
        ...(toleranceRatio !== undefined ? { toleranceRatio } : {}),
      };
      pinnedBands.push(band);
    }
  }
  if (pinnedBands.length === 0 && !errors.some((e) => e.field.startsWith(field))) {
    errors.push({
      field,
      reason: 'must pin at least one octave band to a target reverberation time',
    });
  }
  return { targets, pinnedBands };
}

/**
 * Validate the full body of POST /prescriptions. Reuses the forward
 * validator for room and baseline resonators — the same rejection style and
 * field paths the existing API uses.
 */
export function validatePrescriptionRequest(raw: unknown): PrescriptionRequest {
  if (!isRecord(raw)) {
    throw new ValidationError([{ field: 'body', reason: 'must be a JSON object' }]);
  }

  const errors: FieldError[] = [];

  let room = null as PrescriptionRequest['room'] | null;
  collect(errors, () => {
    room = validateRoom(raw.room);
  });

  const resonators: PrescriptionRequest['resonators'] = [];
  if (raw.resonators !== undefined) {
    if (!Array.isArray(raw.resonators)) {
      errors.push({ field: 'resonators', reason: 'must be an array' });
    } else {
      raw.resonators.forEach((resonator, index) => {
        collect(errors, () => {
          resonators.push(validateResonator(resonator, index));
        });
      });
    }
  }

  let model: ReverberationModel = DEFAULT_REVERBERATION_MODEL;
  if (raw.model !== undefined) {
    if (raw.model !== 'sabine' && raw.model !== 'eyring') {
      errors.push({
        field: 'model',
        reason: `must be 'sabine' or 'eyring', got ${JSON.stringify(raw.model)}`,
      });
    } else {
      model = raw.model;
    }
  }

  let strategy: TreatmentStrategy = DEFAULT_TREATMENT_STRATEGY;
  if (raw.strategy !== undefined) {
    if (raw.strategy !== 'surface' && raw.strategy !== 'resonator' && raw.strategy !== 'auto') {
      errors.push({
        field: 'strategy',
        reason: `must be 'surface', 'resonator' or 'auto', got ${JSON.stringify(raw.strategy)}`,
      });
    } else {
      strategy = raw.strategy;
    }
  }

  let toleranceRatio = DEFAULT_TOLERANCE_RATIO;
  if (raw.toleranceRatio !== undefined) {
    const validated = validateTolerance(raw.toleranceRatio, 'toleranceRatio', errors);
    if (validated !== null) toleranceRatio = validated;
  }

  const { targets, pinnedBands } = validateTargets(raw.targets, errors);

  const candidateSurfaceNames: string[] = [];
  if (raw.candidateSurfaces !== undefined) {
    if (!Array.isArray(raw.candidateSurfaces)) {
      errors.push({ field: 'candidateSurfaces', reason: 'must be an array of surface names' });
    } else {
      for (const [index, name] of raw.candidateSurfaces.entries()) {
        if (typeof name !== 'string' || name.trim() === '') {
          errors.push({
            field: `candidateSurfaces[${index}]`,
            reason: 'must be a non-empty surface name',
          });
        } else if (!candidateSurfaceNames.includes(name)) {
          candidateSurfaceNames.push(name);
        }
      }
    }
  }

  let resonatorTemplate: ResonatorTemplateInput | null = null;
  if (raw.resonatorUnit !== undefined) {
    const { template, errors: templateErrors } = validateTemplate(raw.resonatorUnit);
    errors.push(...templateErrors);
    if (template !== null) resonatorTemplate = template;
  }

  let maxGroups = DEFAULT_MAX_RESONATOR_GROUPS_PER_BAND;
  if (raw.maxResonatorGroupsPerBand !== undefined) {
    const field = 'maxResonatorGroupsPerBand';
    const value = raw.maxResonatorGroupsPerBand;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > HARD_MAX_RESONATOR_GROUPS_PER_BAND
    ) {
      errors.push({
        field,
        reason: `must be a positive integer no greater than ${HARD_MAX_RESONATOR_GROUPS_PER_BAND}, got ${JSON.stringify(value)}`,
      });
    } else {
      maxGroups = value;
    }
  }

  // Candidate surfaces must really exist in the submitted room.
  if (room !== null) {
    const roomNames = new Set(room.surfaces.map((surface) => surface.name));
    for (const name of candidateSurfaceNames) {
      if (!roomNames.has(name)) {
        errors.push({
          field: 'candidateSurfaces',
          reason: `no surface named '${name}' exists in room.surfaces (known surfaces: ${room.surfaces
            .map((s) => `'${s.name}'`)
            .join(', ')})`,
        });
      }
    }
  }

  // Strategy/parameters consistency.
  if (candidateSurfaceNames.length === 0 && strategy !== 'resonator') {
    errors.push({
      field: 'candidateSurfaces',
      reason: `is required for strategy '${strategy}' (pin at least one existing surface, or use strategy 'resonator')`,
    });
  }
  if (resonatorTemplate === null && strategy === 'resonator') {
    errors.push({
      field: 'resonatorUnit',
      reason: `is required for strategy 'resonator' (give neckArea/neckLength; cavityVolume is optional and derived when omitted)`,
    });
  }

  // A fixed-cavity template must actually tune to every pinned band.
  if (resonatorTemplate !== null && resonatorTemplate.cavityVolume !== undefined) {
    for (const band of pinnedBands) {
      const modelOfUnit = buildResonator({
        neckArea: resonatorTemplate.neckArea,
        neckLength: resonatorTemplate.neckLength,
        cavityVolume: resonatorTemplate.cavityVolume!,
        ...(resonatorTemplate.temperatureC !== undefined
          ? { temperatureC: resonatorTemplate.temperatureC }
          : {}),
        count: 1,
      });
      const f0 = modelOfUnit.report.resonanceFrequencyHz;
      const [low, high] = [band / Math.SQRT2, band * Math.SQRT2];
      if (f0 < low || f0 > high) {
        errors.push({
          field: 'resonatorUnit.cavityVolume',
          reason: `the template resonates at ${f0.toFixed(1)} Hz, outside the ${band} Hz octave band [${low.toFixed(
            0,
          )}, ${high.toFixed(0)}] Hz; omit cavityVolume to let the solver tune it to ${band} Hz`,
        });
      }
    }
  }

  if (errors.length > 0 || room === null) {
    throw new ValidationError(errors);
  }

  return {
    room,
    resonators,
    model,
    strategy,
    toleranceRatio,
    targets,
    candidateSurfaceNames,
    resonatorTemplate,
    maxResonatorGroupsPerBand: maxGroups,
  };
}
