import { loadConfig } from './config';
import { InMemoryCalculationRepository, InMemoryPrescriptionRepository } from './persistence/memory';
import {
  PostgresCalculationRepository,
  PostgresPrescriptionRepository,
} from './persistence/postgres';
import type {
  CalculationRepository,
  PrescriptionRepository,
} from './persistence/repository';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();

  let repository: CalculationRepository;
  let prescriptionRepository: PrescriptionRepository;
  if (config.databaseUrl !== undefined && config.databaseUrl !== '') {
    const postgres = new PostgresCalculationRepository(config.databaseUrl);
    await postgres.migrate();
    repository = postgres;
    prescriptionRepository = new PostgresPrescriptionRepository(config.databaseUrl);
    console.log('Persistence: PostgreSQL');
  } else {
    repository = new InMemoryCalculationRepository();
    prescriptionRepository = new InMemoryPrescriptionRepository();
    console.warn(
      'DATABASE_URL is not set — falling back to in-memory persistence (records are lost on restart).',
    );
  }

  const app = buildServer({ repository, prescriptionRepository, logger: true });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down.`);
    await app.close();
    await repository.close();
    await prescriptionRepository.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
