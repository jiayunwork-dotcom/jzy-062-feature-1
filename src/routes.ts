import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { computeAcoustics } from './acoustics';
import { publicConstants } from './constants';
import { CLASSROOM_EXAMPLE, CLASSROOM_RESONATOR_EXAMPLE } from './examples/classroom';
import type { CalculationRepository } from './persistence/repository';
import type { CalculationRecord } from './types';
import { validateCalculationRequest } from './validation';

export function registerRoutes(app: FastifyInstance, repository: CalculationRepository): void {
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
}
