import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { solvePrescription } from '../src/prescription/solver';
import { validatePrescriptionRequest } from '../src/prescription/validation';
import { PostgresPrescriptionRepository } from '../src/prescription/postgres';
import type { PrescriptionRecord } from '../src/prescription/types';

/**
 * PostgreSQL integration test for the prescription repository. Skipped
 * unless TEST_DATABASE_URL points at a reachable PostgreSQL 16 instance:
 *   TEST_DATABASE_URL=postgres://acoustics:acoustics@localhost:5432/acoustics npm test
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('PostgresPrescriptionRepository (integration)', () => {
  const repository = new PostgresPrescriptionRepository(databaseUrl!);

  afterAll(async () => {
    await repository.close();
  });

  const room = {
    name: 'pg-live',
    volume: 120,
    surfaces: [
      {
        name: 'ceiling',
        area: 40,
        coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
      },
    ],
  };

  const makeRecord = (name: string, target: number): PrescriptionRecord => {
    const request = validatePrescriptionRequest({
      room: { ...structuredClone(room), name },
      targets: { 500: { t60Seconds: target } },
      toleranceRatio: 0.05,
      strategy: 'resonator',
      resonatorUnit: { neckArea: 0.002, neckLength: 0.02 },
    });
    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      request,
      result: solvePrescription(request),
    };
  };

  it('migrates, saves and reads back isolated prescriptions', async () => {
    await repository.migrate();

    const [a, b] = [makeRecord('pg-room-a', 1.2), makeRecord('pg-room-b', 0.8)];
    await Promise.all([repository.save(a), repository.save(b)]);

    const fetchedA = await repository.findById(a.id);
    const fetchedB = await repository.findById(b.id);
    expect(fetchedA?.request.room.name).toBe('pg-room-a');
    expect(fetchedB?.request.room.name).toBe('pg-room-b');
    expect(fetchedA?.result.status).toBe(a.result.status);
    expect(fetchedA?.result).toEqual(a.result);

    const listed = await repository.list(100);
    const ids = listed.map((record) => record.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    expect(await repository.findById(randomUUID())).toBeNull();
  });
});
