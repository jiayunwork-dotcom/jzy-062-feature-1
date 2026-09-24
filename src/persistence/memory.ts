import type { CalculationRecord } from '../types';
import type { CalculationRepository } from './repository';

/**
 * In-memory repository used for tests and for running the service without a
 * database (development fallback). Each record is stored under its own id;
 * nothing is shared between submissions.
 */
export class InMemoryCalculationRepository implements CalculationRepository {
  private readonly records = new Map<string, CalculationRecord>();

  async save(record: CalculationRecord): Promise<void> {
    // Deep-freeze a copy so later mutations of the caller's object cannot
    // leak into the stored record (and vice versa).
    this.records.set(record.id, structuredClone(record));
  }

  async findById(id: string): Promise<CalculationRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(limit: number): Promise<CalculationRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async close(): Promise<void> {
    this.records.clear();
  }
}
