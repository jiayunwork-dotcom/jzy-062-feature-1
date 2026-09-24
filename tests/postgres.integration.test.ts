import { describe, expect, it, afterAll } from 'vitest';
import { computeAcoustics } from '../src/acoustics';
import { CLASSROOM_EXAMPLE } from '../src/examples/classroom';
import { PostgresCalculationRepository } from '../src/persistence/postgres';
import { validateCalculationRequest } from '../src/validation';
import { randomUUID } from 'node:crypto';
import type { CalculationRecord } from '../src/types';

/**
 * PostgreSQL integration test. Skipped unless TEST_DATABASE_URL points at a
 * reachable PostgreSQL 16 instance, e.g.:
 *   TEST_DATABASE_URL=postgres://acoustics:acoustics@localhost:5432/acoustics npm test
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('PostgresCalculationRepository (integration)', () => {
  const repository = new PostgresCalculationRepository(databaseUrl!);

  afterAll(async () => {
    await repository.close();
  });

  it('migrates, saves and reads back isolated records', async () => {
    await repository.migrate();

    const makeRecord = (name: string, volume: number): CalculationRecord => {
      const request = validateCalculationRequest({
        room: { ...structuredClone(CLASSROOM_EXAMPLE.room), name, volume },
        resonators: [],
      });
      return {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        request,
        result: computeAcoustics(request.room, request.resonators),
      };
    };

    const [a, b] = [makeRecord('pg-room-a', 120), makeRecord('pg-room-b', 360)];
    await Promise.all([repository.save(a), repository.save(b)]);

    const fetchedA = await repository.findById(a.id);
    const fetchedB = await repository.findById(b.id);
    expect(fetchedA?.request.room.name).toBe('pg-room-a');
    expect(fetchedB?.request.room.name).toBe('pg-room-b');
    expect(fetchedA?.result.room.volume).toBeCloseTo(120, 9);
    expect(fetchedB?.result.room.volume).toBeCloseTo(360, 9);
    expect(fetchedA?.result).toEqual(a.result);

    const listed = await repository.list(100);
    const ids = listed.map((record) => record.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    expect(await repository.findById(randomUUID())).toBeNull();
  });
});
