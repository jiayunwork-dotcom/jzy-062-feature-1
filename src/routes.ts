import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { computeAcoustics } from './acoustics';
import { publicConstants } from './constants';
import { CLASSROOM_EXAMPLE, CLASSROOM_RESONATOR_EXAMPLE } from './examples/classroom';
import { UnreachableTargetError } from './prescription/errors';
import { solvePrescription } from './prescription/solver';
import type {
  CalculationRepository,
  PrescriptionRepository,
} from './persistence/repository';
import type { CalculationRecord, PrescriptionRecord } from './types';
import {
  validateCalculationRequest,
  validatePrescriptionRequest,
} from './validation';

export function registerRoutes(
  app: FastifyInstance,
  repository: CalculationRepository,
  prescriptionRepository: PrescriptionRepository,
): void {
  app.get('/health', async () => ({ status: 'ok' }));

  /** The shared physical constants, for traceability. */
  app.get('/api/v1/constants', async () => publicConstants());

  /** The preset classroom-scale example payloads. */
  app.get('/api/v1/examples/classroom', async () => CLASSROOM_EXAMPLE);
  app.get('/api/v1/examples/classroom-with-resonator', async () => CLASSROOM_RESONATOR_EXAMPLE);

  /** Validate, compute and persist one room-acoustics calculation. */
  app.post('/api/v1/calculations', async (request, reply) => {
    const calculationRequest = validateCalculationRequest(request.body);
    const result = computeAcoustics(calculationRequest.room, calculationRequest.resonators);

    const record: CalculationRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      request: calculationRequest,
      result,
    };
    await repository.save(record);

    return reply.status(201).send(record);
  });

  app.get('/api/v1/calculations', async (request) => {
    const { limit: rawLimit } = request.query as { limit?: string };
    const parsed = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10);
    const limit = Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 50;
    const records = await repository.list(limit);
    return { count: records.length, calculations: records };
  });

  app.get('/api/v1/calculations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await repository.findById(id);
    if (record === null) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `No calculation found with id '${id}'.`,
        },
      });
    }
    return reply.send(record);
  });

  /**
   * Goal-driven inverse solve: given sparse per-band T60 targets, find the
   * extra absorption (surface coefficients or tuned resonator groups) that
   * brings every pinned band into its tolerance band, and prove the result
   * by re-running the complete forward kernel on the treated scheme.
   */
  app.post('/api/v1/prescriptions', async (request, reply) => {
    const rawRequest = request.body;
    const resolved = validatePrescriptionRequest(rawRequest);
    const result = solvePrescription({
      request: rawRequest as PrescriptionRecord['request'],
      resolved,
    });

    const record: PrescriptionRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      request: rawRequest as PrescriptionRecord['request'],
      result,
    };
    // Unreachable solves are audited too — they carry the best achievable
    // result and the physical reason the target could not be met.
    await prescriptionRepository.save(record);

    if (result.status === 'unreachable') {
      throw new UnreachableTargetError(record);
    }
    return reply.status(201).send(record);
  });

  app.get('/api/v1/prescriptions', async (request) => {
    const { limit: rawLimit } = request.query as { limit?: string };
    const parsed = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10);
    const limit = Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 50;
    const records = await prescriptionRepository.list(limit);
    return { count: records.length, prescriptions: records };
  });

  app.get('/api/v1/prescriptions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await prescriptionRepository.findById(id);
    if (record === null) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `No prescription found with id '${id}'.`,
        },
      });
    }
    return reply.send(record);
  });
}
