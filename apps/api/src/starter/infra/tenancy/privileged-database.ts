import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { ENV, type Env } from '../../config/env';

@Injectable()
export class PrivilegedDatabase implements OnApplicationShutdown {
  private readonly logger = new Logger(PrivilegedDatabase.name);
  private pool: Pool | undefined;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.ensurePool().query<R>(
      text,
      values === undefined ? undefined : [...values],
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.pool) return;
    this.logger.log('Closing privileged Postgres pool');
    await this.pool.end();
  }

  private ensurePool(): Pool {
    if (this.pool) return this.pool;

    const connectionString = this.env.POSTGRES_CROSS_TENANT_URL;
    if (!connectionString) {
      throw new Error(
        'POSTGRES_CROSS_TENANT_URL is required to use the privileged handle.',
      );
    }

    this.pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on('error', (error) => {
      this.logger.warn(`Idle privileged Postgres client error: ${error.message}`);
    });
    return this.pool;
  }
}
