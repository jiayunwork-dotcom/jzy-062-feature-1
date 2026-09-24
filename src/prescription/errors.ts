import type { PrescriptionRecord } from '../types';

/**
 * Raised when the solver has proven that no physically allowed prescription
 * can meet the pinned targets within tolerance. It is NOT a validation
 * failure: the request was well-formed, but the physical ceiling (surface
 * coefficient ≤ 1, finite resonator groups, Lorentzian spillover) is below
 * the demand. The carried record includes the closest achievable result and
 * is persisted before the error surfaces to the HTTP layer.
 */
export class UnreachableTargetError extends Error {
  readonly record: PrescriptionRecord;

  constructor(record: PrescriptionRecord) {
    super(
      `Target reverberation time is physically unreachable${
        record.result.unreachableDetails
          ? ` for band(s) ${record.result.unreachableDetails
              .map((detail) => `${detail.frequencyHz} Hz`)
              .join(', ')}`
          : ''
      }.`,
    );
    this.name = 'UnreachableTargetError';
    this.record = record;
  }
}
