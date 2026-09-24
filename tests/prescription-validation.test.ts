import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_RATIO,
} from '../src/prescription/types';
import { validatePrescriptionRequest, ValidationError } from '../src/prescription/validation';
import type { FieldError } from '../src/validation';

const VALID_ROOM = {
  name: 'live-studio',
  volume: 120,
  surfaces: [
    {
      name: 'floor',
      area: 40,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
    {
      name: 'ceiling',
      area: 40,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
  ],
};

const VALID_BODY = {
  room: VALID_ROOM,
  targets: { 500: { t60Seconds: 0.6 } },
  toleranceRatio: 0.05,
  strategy: 'surface',
  candidateSurfaces: ['ceiling'],
};

function expectFieldError(body: unknown, fieldPrefix: string): FieldError[] {
  try {
    validatePrescriptionRequest(body);
    expect.unreachable('should have thrown ValidationError');
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    const details = (error as ValidationError).details;
    expect(details.some((d) => d.field.startsWith(fieldPrefix))).toBe(true);
    for (const detail of details) {
      expect(typeof detail.reason).toBe('string');
      expect(detail.reason.length).toBeGreaterThan(0);
    }
    return details;
  }
  return [];
}

describe('prescription request validation', () => {
  it('accepts a well-formed surface request and fills defaults', () => {
    const request = validatePrescriptionRequest({
      room: VALID_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      candidateSurfaces: ['ceiling'],
    });
    expect(request.model).toBe('sabine');
    expect(request.strategy).toBe('auto');
    expect(request.toleranceRatio).toBe(DEFAULT_TOLERANCE_RATIO);
    expect(request.maxResonatorGroupsPerBand).toBeGreaterThan(0);
    expect(request.resonators).toEqual([]);
  });

  it('rejects a non-object body', () => {
    expectFieldError(null, 'body');
    expectFieldError('nope', 'body');
  });

  it('rejects non-positive target reverberation times', () => {
    expectFieldError(
      { ...VALID_BODY, targets: { 500: { t60Seconds: 0 } } },
      'targets.500.t60Seconds',
    );
    expectFieldError(
      { ...VALID_BODY, targets: { 500: { t60Seconds: -1 } } },
      'targets.500.t60Seconds',
    );
  });

  it('rejects non-finite target reverberation times', () => {
    expectFieldError(
      { ...VALID_BODY, targets: { 500: { t60Seconds: 'soon' } } },
      'targets.500.t60Seconds',
    );
  });

  it('rejects targets on unsupported octave bands', () => {
    expectFieldError(
      { ...VALID_BODY, targets: { 750: { t60Seconds: 0.5 } } },
      'targets.750',
    );
  });

  it('rejects an empty target map (nothing pinned)', () => {
    expectFieldError({ ...VALID_BODY, targets: {} }, 'targets');
  });

  it('rejects out-of-range tolerances at request and per-band level', () => {
    expectFieldError({ ...VALID_BODY, toleranceRatio: 0 }, 'toleranceRatio');
    expectFieldError({ ...VALID_BODY, toleranceRatio: 0.9 }, 'toleranceRatio');
    expectFieldError({ ...VALID_BODY, toleranceRatio: -0.05 }, 'toleranceRatio');
    expectFieldError(
      { ...VALID_BODY, targets: { 500: { t60Seconds: 0.6, toleranceRatio: 0 } } },
      'targets.500.toleranceRatio',
    );
    expectFieldError(
      { ...VALID_BODY, targets: { 500: { t60Seconds: 0.6, toleranceRatio: 2 } } },
      'targets.500.toleranceRatio',
    );
  });

  it('rejects candidate surfaces that do not exist in the submitted room', () => {
    expectFieldError(
      { ...VALID_BODY, candidateSurfaces: ['back-wall'] },
      'candidateSurfaces',
    );
  });

  it('rejects a non-array or empty-name candidate surface list entries', () => {
    expectFieldError({ ...VALID_BODY, candidateSurfaces: 'ceiling' }, 'candidateSurfaces');
    expectFieldError({ ...VALID_BODY, candidateSurfaces: [''] }, 'candidateSurfaces[0]');
  });

  it('requires candidate surfaces for the surface strategy', () => {
    const { candidateSurfaces: _omit, ...body } = VALID_BODY;
    void _omit;
    expectFieldError(body, 'candidateSurfaces');
  });

  it('requires a resonator unit for the resonator strategy', () => {
    expectFieldError(
      {
        room: VALID_ROOM,
        targets: { 500: { t60Seconds: 0.6 } },
        strategy: 'resonator',
      },
      'resonatorUnit',
    );
  });

  it('rejects malformed resonator templates', () => {
    const base = {
      room: VALID_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      strategy: 'resonator',
    };
    expectFieldError(
      { ...base, resonatorUnit: { neckArea: 0, neckLength: 0.02 } },
      'resonatorUnit.neckArea',
    );
    expectFieldError(
      { ...base, resonatorUnit: { neckArea: 0.002, neckLength: -0.01 } },
      'resonatorUnit.neckLength',
    );
    expectFieldError(
      { ...base, resonatorUnit: { neckArea: 0.002, neckLength: 0.02, cavityVolume: 0 } },
      'resonatorUnit.cavityVolume',
    );
    expectFieldError(
      { ...base, resonatorUnit: { neckArea: 0.002, neckLength: 0.02, count: 12 } },
      'resonatorUnit.count',
    );
  });

  it('rejects a fixed-cavity template that tunes outside the pinned band', () => {
    // 0.01 m^3 cavity with the small neck tunes far below 500 Hz.
    expectFieldError(
      {
        room: VALID_ROOM,
        targets: { 500: { t60Seconds: 0.6 } },
        strategy: 'resonator',
        resonatorUnit: { neckArea: 0.002, neckLength: 0.02, cavityVolume: 0.01 },
      },
      'resonatorUnit.cavityVolume',
    );
  });

  it('rejects bad model and strategy enumerations', () => {
    expectFieldError({ ...VALID_BODY, model: 'norris' }, 'model');
    expectFieldError({ ...VALID_BODY, strategy: 'whatever' }, 'strategy');
  });

  it('rejects out-of-bound resonator group caps', () => {
    expectFieldError(
      {
        room: VALID_ROOM,
        targets: { 500: { t60Seconds: 0.6 } },
        strategy: 'resonator',
        resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
        maxResonatorGroupsPerBand: 0,
      },
      'maxResonatorGroupsPerBand',
    );
    expectFieldError(
      {
        room: VALID_ROOM,
        targets: { 500: { t60Seconds: 0.6 } },
        strategy: 'resonator',
        resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
        maxResonatorGroupsPerBand: 1.5,
      },
      'maxResonatorGroupsPerBand',
    );
  });

  it('reuses the forward room validation (negative volume, bad coefficients)', () => {
    const details = expectFieldError(
      {
        ...VALID_BODY,
        room: { ...VALID_ROOM, volume: -5 },
      },
      'room.volume',
    );
    expect(details.some((d) => d.field === 'room.volume')).toBe(true);
  });

  it('reuses the forward baseline resonator validation', () => {
    expectFieldError(
      {
        ...VALID_BODY,
        resonators: [{ neckArea: 0, neckLength: 0.02, cavityVolume: 0.00038, count: 1 }],
      },
      'resonators[0].neckArea',
    );
  });

  it('accepts a derived-cavity resonator template (cavityVolume omitted)', () => {
    const request = validatePrescriptionRequest({
      room: VALID_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      strategy: 'resonator',
      resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
    });
    expect(request.resonatorTemplate?.cavityVolume).toBeUndefined();
  });
});
