export interface ServiceConfig {
  host: string;
  port: number;
  /** When unset, the service falls back to the in-memory repository. */
  databaseUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number.parseInt(env.PORT ?? '3000', 10),
    databaseUrl: env.DATABASE_URL,
  };
}
