import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { CalculationRecord, PrescriptionRecord } from '../types';
import type {
  CalculationRepository,
  PrescriptionRepository,
} from './repository';

const { Pool } = pg;

interface CalculationRow {
  id: string;
  created_at: Date;
  request: CalculationRecord['request'];
  result: CalculationRecord['result'];
}

function toRecord(row: CalculationRow): CalculationRecord {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    request: row.request,
    result: row.result,
  };
}

/**
 * PostgreSQL 16 backed repository. Every calculation is written inside its
 * own transaction (room row + calculation row), so concurrent submissions
 * can never see each other's data.
 */
export class PostgresCalculationRepository implements CalculationRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  /** Apply the schema, retrying while the database is still starting up. */
  async migrate(attempts = 30, delayMs = 1000): Promise<void> {
    const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
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

  async save(record: CalculationRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const roomId = randomUUID();
      await client.query(
        'INSERT INTO rooms (id, name, volume, surfaces) VALUES ($1, $2, $3, $4)',
        [
          roomId,
          record.request.room.name,
          record.request.room.volume,
          JSON.stringify(record.request.room.surfaces),
        ],
      );
      await client.query(
        `INSERT INTO calculations (id, room_id, request, result, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          record.id,
          roomId,
          JSON.stringify(record.request),
          JSON.stringify(record.result),
          record.createdAt,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<CalculationRecord | null> {
    const { rows } = await this.pool.query<CalculationRow>(
      'SELECT id, created_at, request, result FROM calculations WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async list(limit: number): Promise<CalculationRecord[]> {
    const { rows } = await this.pool.query<CalculationRow>(
      'SELECT id, created_at, request, result FROM calculations ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toRecord);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface PrescriptionRow {
  id: string;
  created_at: Date;
  request: PrescriptionRecord['request'];
  result: PrescriptionRecord['result'];
}

function toPrescriptionRecord(row: PrescriptionRow): PrescriptionRecord {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    request: row.request,
    result: row.result,
  };
}

/**
 * PostgreSQL 16 backed repository for inverse-solver prescriptions. Every
 * solve is written in its own transaction, so concurrent prescriptions can
 * never see each other's intermediate or final state.
 */
export class PostgresPrescriptionRepository implements PrescriptionRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async save(record: PrescriptionRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO prescriptions (id, request, result, created_at)
         VALUES ($1, $2, $3, $4)`,
        [
          record.id,
          JSON.stringify(record.request),
          JSON.stringify(record.result),
          record.createdAt,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<PrescriptionRecord | null> {
    const { rows } = await this.pool.query<PrescriptionRow>(
      'SELECT id, created_at, request, result FROM prescriptions WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? toPrescriptionRecord(row) : null;
  }

  async list(limit: number): Promise<PrescriptionRecord[]> {
    const { rows } = await this.pool.query<PrescriptionRow>(
      'SELECT id, created_at, request, result FROM prescriptions ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toPrescriptionRecord);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
