import type { CalculationRecord } from '../types';

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
