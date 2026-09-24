import type { CalculationRecord, PrescriptionRecord } from '../types';

/**
 * Persistence port for calculation records. Implementations must keep
 * records of concurrent submissions fully isolated from each other.
 */
export interface CalculationRepository {
  save(record: CalculationRecord): Promise<void>;
  findById(id: string): Promise<CalculationRecord | null>;
  /** Most recent first. */
  list(limit: number): Promise<CalculationRecord[]>;
  close(): Promise<void>;
}

/**
 * Persistence port for goal-driven prescription solves. Kept as a separate
 * port so the inverse-solver module never depends on how its audit trail is
 * stored; isolation guarantees mirror the calculation repository.
 */
export interface PrescriptionRepository {
  save(record: PrescriptionRecord): Promise<void>;
  findById(id: string): Promise<PrescriptionRecord | null>;
  /** Most recent first. */
  list(limit: number): Promise<PrescriptionRecord[]>;
  close(): Promise<void>;
}
