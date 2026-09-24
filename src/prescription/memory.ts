import type { PrescriptionRecord } from './types';
import type { PrescriptionRepository } from './repository';

/**
 * In-memory prescription store, mirroring the in-memory calculation
 * repository: each record under its own id, deep-cloned on save and read so
 * that concurrent solvers' intermediate objects can never leak into storage.
 */
export class InMemoryPrescriptionRepository implements PrescriptionRepository {
  private readonly records = new Map<string, PrescriptionRecord>();

  async save(record: PrescriptionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async findById(id: string): Promise<PrescriptionRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(limit: number): Promise<PrescriptionRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async close(): Promise<void> {
    this.records.clear();
  }
}
