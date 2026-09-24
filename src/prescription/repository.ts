import type { PrescriptionRecord } from './types';

/**
 * Persistence port for goal-driven prescription records. Kept separate from
 * the calculation repository so the two streams evolve independently.
 * Implementations must keep concurrent prescription requests isolated.
 */
export interface PrescriptionRepository {
  save(record: PrescriptionRecord): Promise<void>;
  findById(id: string): Promise<PrescriptionRecord | null>;
  /** Most recent first. */
  list(limit: number): Promise<PrescriptionRecord[]>;
  close(): Promise<void>;
}
