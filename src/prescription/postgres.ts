import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { PrescriptionRecord } from './types';
import type { PrescriptionRepository } from './repository';

const { Pool } = pg;

interface PrescriptionRow {
  id: string;
  created_at: Date;
  request: PrescriptionRecord['request'];
  result: PrescriptionRecord['result'];
}

function toRecord(row: PrescriptionRow): PrescriptionRecord {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    request: row.request,
    result: row.result,
  };
}

/**
 * PostgreSQL 16 backed prescription repository. Decoupled from the
 * calculation repository (its own pool, its own table); each prescription is
 * written atomically, so concurrent requests can never see each other's data.
 */
export class PostgresPrescriptionRepository implements PrescriptionRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  /** Apply the prescription schema, retrying while the database starts up. */
  async migrate(attempts = 30, delayMs = 1000): Promise<void> {
    const schema = readFileSync(path.join(__dirname, 'prescription-schema.sql'), 'utf8');
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.pool.query(schema);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async save(record: PrescriptionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO prescriptions (id, request, result, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        record.id,
        JSON.stringify(record.request),
        JSON.stringify(record.result),
        record.createdAt,
      ],
    );
  }

  async findById(id: string): Promise<PrescriptionRecord | null> {
    const { rows } = await this.pool.query<PrescriptionRow>(
      'SELECT id, created_at, request, result FROM prescriptions WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async list(limit: number): Promise<PrescriptionRecord[]> {
    const { rows } = await this.pool.query<PrescriptionRow>(
      'SELECT id, created_at, request, result FROM prescriptions ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toRecord);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
