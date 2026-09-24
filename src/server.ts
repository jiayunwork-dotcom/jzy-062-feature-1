import Fastify, { type FastifyInstance } from 'fastify';
import {
  CalculationRepository,
  PrescriptionRepository,
} from './persistence/repository';
import { UnreachableTargetError } from './prescription/errors';
import { registerRoutes } from './routes';
import { ValidationError } from './validation';

export interface BuildServerOptions {
  repository: CalculationRepository;
  prescriptionRepository: PrescriptionRepository;
  logger?: boolean;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request failed validation.',
          details: error.details,
        },
      });
    }
    if (error instanceof UnreachableTargetError) {
      // Physically impossible, well-formed request: the body carries the
      // complete persisted solve including the closest achievable result.
      return reply.status(422).send({
        error: {
          code: 'TARGET_UNREACHABLE',
          message:
            'The requested reverberation time cannot be reached within the given tolerance; see details and bestAchievable in the record.',
          details: error.record.result.unreachableDetails ?? [],
        },
        record: error.record,
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 400) {
      // Malformed JSON bodies and similar client errors surfaced by Fastify.
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Bad request.',
        },
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });

  registerRoutes(app, options.repository, options.prescriptionRepository);
  return app;
}
