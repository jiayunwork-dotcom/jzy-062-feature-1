import { afterAll, describe, expect, it } from 'vitest';
import {
  InMemoryCalculationRepository,
  InMemoryPrescriptionRepository,
} from '../src/persistence/memory';
import { buildServer } from '../src/server';
import {
  CLASSROOM_EXAMPLE,
  CLASSROOM_RESONATOR_EXAMPLE,
} from '../src/examples/classroom';
import { LIVE_STUDIO_EXAMPLE } from '../src/examples/liveStudio';
import type { CalculationRecord, PrescriptionRecord } from '../src/types';

const repository = new InMemoryCalculationRepository();
const prescriptionRepository = new InMemoryPrescriptionRepository();
const app = buildServer({ repository, prescriptionRepository });

afterAll(async () => {
  await app.close();
  await prescriptionRepository.close();
});

async function postCalculation(body: unknown) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/calculations',
    payload: body as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.json() };
}

describe('HTTP API', () => {
  it('answers the health check', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('exposes the shared constants', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/constants' });
    expect(response.statusCode).toBe(200);
    const constants = response.json();
    expect(constants.sabineCoefficient).toBeCloseTo(0.161, 9);
    expect(constants.octaveBandsHz).toEqual([125, 250, 500, 1000, 2000, 4000]);
    expect(constants.speedOfSoundAtReferenceMetersPerSecond).toBeCloseTo(343, 0);
  });

  it('serves the preset classroom example', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/examples/classroom' });
    expect(response.statusCode).toBe(200);
    expect(response.json().room.volume).toBeCloseTo(201.6, 6);
  });

  it('computes and persists a classroom calculation', async () => {
    const { status, body } = await postCalculation(CLASSROOM_EXAMPLE);
    expect(status).toBe(201);
    const record = body as CalculationRecord;
    expect(record.id).toBeTruthy();
    expect(record.result.bands).toHaveLength(6);

    const band500 = record.result.bands.find((b) => b.frequencyHz === 500)!;
    expect(band500.sabine.t60Seconds!).toBeGreaterThan(0.1);
    expect(band500.sabine.t60Seconds!).toBeLessThan(2);

    // The record must be retrievable afterwards (persistence trail).
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/calculations/${record.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(record);
  });

  it('applies the resonator through the API: 500 Hz drops, neighbours stay put', async () => {
    const plain = (await postCalculation(CLASSROOM_EXAMPLE)).body as CalculationRecord;
    const treated = (await postCalculation(CLASSROOM_RESONATOR_EXAMPLE))
      .body as CalculationRecord;

    const t60 = (record: CalculationRecord, frequency: number) =>
      record.result.bands.find((b) => b.frequencyHz === frequency)!.sabine.t60Seconds!;

    const drop500 = t60(plain, 500) - t60(treated, 500);
    expect(drop500).toBeGreaterThan(0);
    for (const frequency of [250, 1000]) {
      expect(Math.abs(t60(plain, frequency) - t60(treated, frequency))).toBeLessThan(
        drop500 / 5,
      );
    }
  });

  it('rejects invalid input with a structured 400 error carrying reasons', async () => {
    const bad = structuredClone(CLASSROOM_EXAMPLE) as {
      room: { volume: number; surfaces: { coefficients: Record<string, number> }[] };
    };
    bad.room.volume = -1;
    bad.room.surfaces[0]!.coefficients['500'] = 1.7;

    const { status, body } = await postCalculation(bad);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const fields = body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('room.volume');
    expect(fields).toContain('room.surfaces[0].coefficients.500');
    for (const detail of body.error.details) {
      expect(typeof detail.reason).toBe('string');
      expect(detail.reason.length).toBeGreaterThan(0);
    }
  });

  it('rejects malformed JSON with a 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/calculations',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('returns a structured 404 for unknown calculations', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/calculations/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('lists persisted calculations, most recent first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/calculations?limit=100' });
    expect(response.statusCode).toBe(200);
    const { count, calculations } = response.json();
    expect(count).toBeGreaterThan(0);
    expect(calculations.length).toBe(count);
    for (let i = 1; i < calculations.length; i += 1) {
      expect(
        calculations[i - 1].createdAt >= calculations[i].createdAt,
      ).toBe(true);
    }
  });
});

describe('goal-driven prescription endpoint', () => {
  const liveRoom = LIVE_STUDIO_EXAMPLE.room;

  async function postPrescription(body: unknown) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/prescriptions',
      payload: body as Record<string, unknown>,
    });
    return { status: response.statusCode, body: response.json() };
  }

  it('solves a live room target and returns the forward-verified prescription', async () => {
    const { status, body } = await postPrescription({
      room: liveRoom,
      targets: { 500: 0.6 },
      toleranceRatio: 0.05,
      preferences: {
        strategy: 'surface',
        candidateSurfaceNames: ['ceiling (hard plaster)', 'walls (block + paint)'],
      },
    });
    expect(status).toBe(201);
    const record = body as PrescriptionRecord;
    expect(record.id).toBeTruthy();
    expect(record.result.status).toBe('solved');
    const achieved = record.result.verification.bands.find((b) => b.frequencyHz === 500)!
      .sabine.t60Seconds!;
    expect(achieved).toBeGreaterThanOrEqual(0.57);
    expect(achieved).toBeLessThanOrEqual(0.63);

    // Persisted and retrievable afterwards (audit trail).
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${record.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(record);
  });

  it('returns an empty 201 prescription for a target that is already met', async () => {
    const { status, body } = await postPrescription({
      room: liveRoom,
      targets: { 500: 4 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'resonator' },
    });
    expect(status).toBe(201);
    const record = body as PrescriptionRecord;
    expect(record.result.status).toBe('already-compliant');
    expect(record.result.prescription.resonators).toHaveLength(0);
    expect(record.result.prescription.surfaceTreatments).toHaveLength(0);
  });

  it('returns a structured 422 (with the persisted record) for an unreachable target', async () => {
    const { status, body } = await postPrescription({
      room: liveRoom,
      targets: { 500: 0.05 },
      toleranceRatio: 0.02,
      preferences: { strategy: 'resonator', maxResonatorGroups: 10 },
    });
    expect(status).toBe(422);
    expect(body.error.code).toBe('TARGET_UNREACHABLE');
    expect(body.error.details[0]!.frequencyHz).toBe(500);
    // The record — including best achievable — rides along and was persisted.
    const record = body.record as PrescriptionRecord;
    expect(record.result.status).toBe('unreachable');
    expect(
      record.result.unreachableDetails![0]!.bestAchievableT60Seconds,
    ).toBeGreaterThan(0.05 * 1.02);
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${record.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().result.status).toBe('unreachable');
  });

  it('auto-falls-back to resonators when the surface ceiling is insufficient', async () => {
    const { status, body } = await postPrescription({
      room: liveRoom,
      targets: { 500: 0.3 },
      toleranceRatio: 0.05,
      preferences: {
        strategy: 'auto',
        candidateSurfaceNames: ['floor (sealed concrete)'],
      },
    });
    expect(status).toBe(201);
    const record = body as PrescriptionRecord;
    expect(record.result.status).toBe('solved');
    expect(record.result.strategyUsed).toBe('resonator');
    expect(record.result.fallbackUsed).toBe(true);
    const achieved = record.result.verification.bands.find((b) => b.frequencyHz === 500)!
      .sabine.t60Seconds!;
    expect(achieved).toBeGreaterThanOrEqual(0.285);
    expect(achieved).toBeLessThanOrEqual(0.315);
  });

  it('keeps multiple pinned bands simultaneously in band via resonators', async () => {
    const { status, body } = await postPrescription({
      room: liveRoom,
      targets: { 500: 0.6, 1000: 0.6 },
      toleranceRatio: 0.05,
      preferences: { strategy: 'resonator', maxResonatorGroups: 5000 },
    });
    expect(status).toBe(201);
    const record = body as PrescriptionRecord;
    expect(record.result.status).toBe('solved');
    for (const frequency of [500, 1000]) {
      const t = record.result.verification.bands.find((b) => b.frequencyHz === frequency)!
        .sabine.t60Seconds!;
      expect(t).toBeGreaterThanOrEqual(0.57);
      expect(t).toBeLessThanOrEqual(0.63);
    }
  });

  it('rejects invalid prescription input with a structured 400', async () => {
    const { status, body } = await postPrescription({
      room: liveRoom,
      targets: { 500: -0.6 },
      toleranceRatio: 0.9,
      preferences: {
        strategy: 'surface',
        candidateSurfaceNames: ['no such wall'],
      },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const fields = body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('targets.500');
    expect(fields.some((f: string) => f.includes('toleranceRatio'))).toBe(true);
    expect(fields.some((f: string) => f.includes('candidateSurfaceNames'))).toBe(true);
  });

  it('isolates parallel prescription solves from each other', async () => {
    const payloads = [0.5, 0.7, 0.9, 1.1].map((target) => ({
      room: structuredClone(liveRoom),
      targets: { 500: target },
      toleranceRatio: 0.05,
      preferences: { strategy: 'resonator', maxResonatorGroups: 5000 },
    }));
    const responses = await Promise.all(payloads.map((payload) => postPrescription(payload)));
    const records = responses.map(({ status, body }) => {
      expect(status).toBe(201);
      return body as PrescriptionRecord;
    });
    expect(new Set(records.map((r) => r.id)).size).toBe(payloads.length);
    records.forEach((record, index) => {
      const target = payloads[index]!.targets[500]!;
      const t = record.result.verification.bands.find((b) => b.frequencyHz === 500)!
        .sabine.t60Seconds!;
      expect(t).toBeGreaterThanOrEqual(target * 0.95);
      expect(t).toBeLessThanOrEqual(target * 1.05);
    });
  });

  it('lists prescriptions most recent first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/prescriptions?limit=100' });
    expect(response.statusCode).toBe(200);
    const { count, prescriptions } = response.json();
    expect(count).toBeGreaterThan(0);
    for (let i = 1; i < prescriptions.length; i += 1) {
      expect(prescriptions[i - 1].createdAt >= prescriptions[i].createdAt).toBe(true);
    }
  });
});

describe('concurrent submissions stay isolated', () => {
  it('keeps results of simultaneously submitted rooms separate', async () => {
    // Eight rooms, same materials, different volumes — submitted in parallel.
    const requests = Array.from({ length: 8 }, (_, index) => {
      const request = structuredClone(CLASSROOM_EXAMPLE);
      request.room.name = `concurrent-room-${index}`;
      request.room.volume = 80 + index * 50;
      return request;
    });

    const responses = await Promise.all(
      requests.map((payload) =>
        app.inject({ method: 'POST', url: '/api/v1/calculations', payload }),
      ),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(201);
    }
    const records = responses.map((r) => r.json() as CalculationRecord);

    // Distinct ids, and each result must correspond to its own request.
    expect(new Set(records.map((r) => r.id)).size).toBe(requests.length);
    records.forEach((record, index) => {
      expect(record.request.room.volume).toBeCloseTo(requests[index]!.room.volume, 9);
      expect(record.result.room.volume).toBeCloseTo(requests[index]!.room.volume, 9);
      expect(record.result.room.name).toBe(`concurrent-room-${index}`);
    });

    // Larger volume => longer T60 for identical materials: proves each
    // record carries its own physics, not a neighbour's.
    const t60of = (record: CalculationRecord) =>
      record.result.bands.find((b) => b.frequencyHz === 500)!.sabine.t60Seconds!;
    const sorted = [...records].sort((a, b) => a.request.room.volume - b.request.room.volume);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(t60of(sorted[i]!)).toBeGreaterThan(t60of(sorted[i - 1]!));
    }

    // Every record is individually retrievable and matches what was returned.
    for (const record of records) {
      const fetched = await app.inject({
        method: 'GET',
        url: `/api/v1/calculations/${record.id}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().result.room.name).toBe(record.result.room.name);
    }
  });
});
