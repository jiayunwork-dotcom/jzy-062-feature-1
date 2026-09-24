import Fastify, { type FastifyInstance } from 'fastify';
import type { CalculationRepository } from './persistence/repository';
import { registerRoutes } from './routes';
import { ValidationError } from './validation';

export interface BuildServerOptions {
  repository: CalculationRepository;
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

  registerRoutes(app, options.repository);
  return app;
}
