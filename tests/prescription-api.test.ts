import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryCalculationRepository } from '../src/persistence/memory';
import { InMemoryPrescriptionRepository } from '../src/prescription/memory';
import { buildServer } from '../src/server';
import type { PrescriptionRecord } from '../src/prescription/types';

const repository = new InMemoryCalculationRepository();
const prescriptionRepository = new InMemoryPrescriptionRepository();
const app = buildServer({ repository, prescriptionRepository });

afterAll(async () => {
  await app.close();
});

const LIVE_ROOM = {
  name: 'live-studio',
  volume: 120,
  surfaces: [
    {
      name: 'floor',
      area: 40,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
    {
      name: 'ceiling',
      area: 40,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
    {
      name: 'walls',
      area: 70,
      coefficients: { 125: 0.02, 250: 0.02, 500: 0.02, 1000: 0.02, 2000: 0.02, 4000: 0.02 },
    },
  ],
};

async function postPrescription(body: unknown) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/prescriptions',
    payload: body as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.json() };
}

describe('POST /api/v1/prescriptions', () => {
  it('solves a live room toward the 500 Hz target and returns the forward re-check', async () => {
    const { status, body } = await postPrescription({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.6 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling', 'walls'],
    });
    expect(status).toBe(200);
    const record = body as PrescriptionRecord;
    expect(record.id).toBeTruthy();
    expect(record.result.status).toBe('solved');
    const check = record.result.bandVerification.find((v) => v.frequencyHz === 500)!;
    expect(check.withinTolerance).toBe(true);
    expect(check.achievedT60Seconds).toBeGreaterThanOrEqual(0.57);
    expect(check.achievedT60Seconds).toBeLessThanOrEqual(0.63);
  });

  it('persists the prescription and makes it retrievable', async () => {
    const { body } = await postPrescription({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.7 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling'],
    });
    const created = body as PrescriptionRecord;
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${created.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(created);
  });

  it('returns not-needed with an empty prescription for an already-met target', async () => {
    const { status, body } = await postPrescription({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 6.0, toleranceRatio: 0.1 } },
      strategy: 'surface',
      candidateSurfaces: ['ceiling'],
    });
    expect(status).toBe(200);
    const record = body as PrescriptionRecord;
    expect(record.result.status).toBe('not-needed');
    expect(record.result.strategyUsed).toBe('none');
    expect(record.result.surface).toBeNull();
    expect(record.result.resonators).toBeNull();
  });

  it('reports 200 + status unreachable for a physically impossible target', async () => {
    const { status, body } = await postPrescription({
      room: LIVE_ROOM,
      targets: { 500: { t60Seconds: 0.05 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling'],
    });
    expect(status).toBe(200);
    const record = body as PrescriptionRecord;
    expect(record.result.status).toBe('unreachable');
    expect(record.result.unreachable).not.toBeNull();
    expect(record.result.unreachable!.reason.length).toBeGreaterThan(0);
    const check = record.result.bandVerification.find((v) => v.frequencyHz === 500)!;
    expect(check.withinTolerance).toBe(false);
    expect(check.achievedT60Seconds).not.toBeNull();
    // Never a fabricated out-of-range coefficient.
    for (const surface of record.result.surface!.surfaces) {
      expect(surface.coefficients[500]).toBeLessThanOrEqual(1);
    }
  });

  it('rejects invalid input with the same structured 400 style as /calculations', async () => {
    const { status, body } = await postPrescription({
      room: LIVE_ROOM,
      targets: { 750: { t60Seconds: -1 } },
      strategy: 'surface',
      candidateSurfaces: ['nope'],
      toleranceRatio: 3,
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const fields = body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('targets.750');
    expect(fields.some((f: string) => f.startsWith('candidateSurfaces'))).toBe(true);
    expect(fields).toContain('toleranceRatio');
  });

  it('404s on unknown prescription ids', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/prescriptions/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('lists prescriptions, most recent first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/prescriptions?limit=100' });
    expect(response.statusCode).toBe(200);
    const { count, prescriptions } = response.json();
    expect(count).toBeGreaterThan(1);
    for (let i = 1; i < prescriptions.length; i += 1) {
      expect(prescriptions[i - 1].createdAt >= prescriptions[i].createdAt).toBe(true);
    }
  });
});

describe('concurrent prescription requests stay isolated', () => {
  it('keeps parallel prescriptions and their intermediate states separate', async () => {
    const payloads = Array.from({ length: 8 }, (_, index) => ({
      room: { ...structuredClone(LIVE_ROOM), name: `parallel-room-${index}`, volume: 90 + index * 20 },
      targets: { 500: { t60Seconds: 0.6 } },
      toleranceRatio: 0.05,
      strategy: 'surface',
      candidateSurfaces: ['ceiling', 'walls'],
    }));
    const responses = await Promise.all(
      payloads.map((payload) =>
        app.inject({ method: 'POST', url: '/api/v1/prescriptions', payload }),
      ),
    );
    for (const response of responses) expect(response.statusCode).toBe(200);
    const records = responses.map((r) => r.json() as PrescriptionRecord);
    expect(new Set(records.map((r) => r.id)).size).toBe(payloads.length);
    records.forEach((record, index) => {
      expect(record.result.verification.room.name).toBe(`parallel-room-${index}`);
      expect(record.result.verification.room.volume).toBeCloseTo(90 + index * 20, 9);
      const check = record.result.bandVerification.find((v) => v.frequencyHz === 500)!;
      expect(check.withinTolerance).toBe(true);
    });
  });
});
