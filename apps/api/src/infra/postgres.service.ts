import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { ENV, type Env } from '../config/env';

/**
 * Owns the Postgres connection pool for the runtime role.
 *
 * Deliberately shaped like MongoService and RedisService: one validated URL from
 * config, an injected client, a `ping` for the readiness check, and a shutdown hook that
 * drains rather than drops. There should be one way to do this in the codebase, not two.
 *
 * The pool is size-limited (POSTGRES_POOL_MAX). The migration connection is NOT here —
 * it is a one-shot in `db:migrate:pg`, so the owner credentials never enter the serving
 * process.
 */
@Injectable()
export class PostgresService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostgresService.name);
  readonly pool: Pool;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.pool = new Pool({
      connectionString: this.env.POSTGRES_URL,
      max: this.env.POSTGRES_POOL_MAX,
      // Fail a checkout fast when the server is unreachable rather than hanging until a
      // far-away socket timeout — the readiness probe must be able to answer quickly.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });

    // A pool with no error listener crashes the process when a backend drops an idle
    // connection. Log and let the pool replace it.
    this.pool.on('error', (error) => {
      this.logger.warn(`Idle Postgres client error: ${error.message}`);
    });
  }

  /**
   * Readiness probe. `SELECT 1` is the cheapest statement that proves the server is
   * reachable and the pool can hand out a usable connection. It needs no tenant context,
   * so it stays a check rather than a query.
   */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing Postgres pool');
    await this.pool.end();
  }
}
