import { describe, expect, it } from 'vitest';
import { CLASSROOM_EXAMPLE } from '../src/examples/classroom';
import {
  validateCalculationRequest,
  validateRoom,
  ValidationError,
} from '../src/validation';

function expectValidationError(fn: () => unknown, fieldFragment: string): void {
  try {
    fn();
    expect.unreachable(`expected a ValidationError mentioning ${fieldFragment}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    const details = (error as ValidationError).details;
    expect(Array.isArray(details)).toBe(true);
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(typeof detail.field).toBe('string');
      expect(typeof detail.reason).toBe('string');
    }
    expect(details.some((d) => d.field.includes(fieldFragment))).toBe(true);
  }
}

describe('room geometry and material validation', () => {
  it('accepts the preset classroom example', () => {
    const room = validateRoom(CLASSROOM_EXAMPLE.room);
    expect(room.volume).toBeCloseTo(201.6, 9);
    expect(room.surfaces).toHaveLength(3);
  });

  it('rejects a non-positive volume with a reason', () => {
    const room = structuredClone(CLASSROOM_EXAMPLE.room);
    expectValidationError(() => validateRoom({ ...room, volume: 0 }), 'room.volume');
    expectValidationError(() => validateRoom({ ...room, volume: -10 }), 'room.volume');
  });

  it('rejects a non-finite volume', () => {
    const room = structuredClone(CLASSROOM_EXAMPLE.room);
    expectValidationError(
      () => validateRoom({ ...room, volume: Number.NaN }),
      'room.volume',
    );
  });

  it('rejects a non-positive surface area with a reason', () => {
    const room = structuredClone(CLASSROOM_EXAMPLE.room);
    room.surfaces[1]!.area = 0;
    expectValidationError(() => validateRoom(room), 'room.surfaces[1].area');
    room.surfaces[1]!.area = -5;
    expectValidationError(() => validateRoom(room), 'room.surfaces[1].area');
  });

  it('rejects absorption coefficients outside [0, 1] with a reason', () => {
    const room = structuredClone(CLASSROOM_EXAMPLE.room);
    room.surfaces[0]!.coefficients[500] = 1.4;
    expectValidationError(
      () => validateRoom(room),
      'room.surfaces[0].coefficients.500',
    );

    const room2 = structuredClone(CLASSROOM_EXAMPLE.room);
    room2.surfaces[2]!.coefficients[125] = -0.1;
    expectValidationError(
      () => validateRoom(room2),
      'room.surfaces[2].coefficients.125',
    );
  });

  it('rejects missing octave bands', () => {
    const room = structuredClone(CLASSROOM_EXAMPLE.room);
    const coefficients = room.surfaces[0]!.coefficients as Record<string, number>;
    delete coefficients['4000'];
    expectValidationError(() => validateRoom(room), 'coefficients.4000');
  });

  it('rejects unknown band keys', () => {
    const room = structuredClone(CLASSROOM_EXAMPLE.room);
    (room.surfaces[0]!.coefficients as Record<string, number>)['1250'] = 0.5;
    expectValidationError(() => validateRoom(room), 'coefficients.1250');
  });

  it('rejects an empty surface list', () => {
    expectValidationError(
      () => validateRoom({ name: 'x', volume: 100, surfaces: [] }),
      'room.surfaces',
    );
  });

  it('rejects malformed calculation requests', () => {
    expectValidationError(() => validateCalculationRequest(null), 'body');
    expectValidationError(() => validateCalculationRequest({}), 'room');
    expectValidationError(
      () =>
        validateCalculationRequest({
          room: structuredClone(CLASSROOM_EXAMPLE.room),
          resonators: 'not-an-array',
        }),
      'resonators',
    );
  });
});
