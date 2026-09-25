import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { MongoClient, type Db } from 'mongodb';
import { ENV, type Env } from '../config/env';

/**
 * Owns the MongoClient lifecycle.
 *
 * Note this deliberately uses the official driver rather than Mongoose. From Phase 3
 * onwards the persistence layer is an explicit repository interface with hand-written
 * document <-> domain mappers, so Mongoose's schema/model layer would be a second
 * modelling system sitting between two that already exist. The driver also keeps
 * index definitions, `explain()` output and aggregation pipelines visible rather than
 * generated — which is the whole point of the exercise.
 *
 * A single MongoClient is shared process-wide: it maintains its own connection pool
 * internally, so creating more than one is a pure waste of sockets.
 */
@Injectable()
export class MongoService implements OnApplicationShutdown {
  private readonly logger = new Logger(MongoService.name);
  /**
   * Public because the repository needs it to start sessions for transactions. The `db`
   * getter is not enough — sessions belong to the client, not to a database handle.
   */
  readonly client: MongoClient;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = new MongoClient(this.env.MONGO_URL);
  }

  get db(): Db {
    return this.client.db(this.env.MONGO_DB_NAME);
  }

  /**
   * Liveness check for the health endpoint. `ping` is the cheapest command that proves
   * the server is actually reachable and answering — unlike inspecting driver state,
   * which can report a connection the network has since dropped.
   */
  async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing MongoDB connection');
    await this.client.close();
  }
}
