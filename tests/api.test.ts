import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryCalculationRepository } from '../src/persistence/memory';
import { buildServer } from '../src/server';
import {
  CLASSROOM_EXAMPLE,
  CLASSROOM_RESONATOR_EXAMPLE,
} from '../src/examples/classroom';
import type { CalculationRecord } from '../src/types';

const repository = new InMemoryCalculationRepository();
const app = buildServer({ repository });

afterAll(async () => {
  await app.close();
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
