import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { Db, MongoClient } from 'mongodb';
import { runMigrations } from '../src/persistence/migrations';
import type { MongoService } from '../src/infra/mongo.service';

/**
 * A real MongoDB, started in a container for the duration of a test file.
 *
 * Why a real database rather than `mongodb-memory-server` or a mocked driver: every
 * property worth testing at this layer is a property of MongoDB itself. The partial
 * unique index, duplicate-key error 11000, `$dateTrunc` week bucketing, index selection —
 * none of those exist in a mock, so a mocked test would assert only that my own code
 * calls the functions my own code calls.
 *
 * `MongoDBContainer` starts a single-node REPLICA SET, which is required for transactions
 * and matches docker-compose. Testcontainers picks a random host port, so parallel test
 * files cannot collide.
 */
export interface MongoHarness {
  readonly db: Db;
  /**
   * A MongoService stand-in carrying BOTH `db` and `client`.
   *
   * `client` is needed because sessions — and therefore transactions — belong to the
   * client, not to a database handle. Provided here rather than reconstructed in each
   * spec so that adding a transactional code path cannot silently break every test that
   * built its own partial stub.
   */
  readonly mongoService: MongoService;
  /** Wipe all data between tests while KEEPING indexes — see `reset` below. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startMongoHarness(): Promise<MongoHarness> {
  const container: StartedMongoDBContainer = await new MongoDBContainer(
    'mongo:7',
  ).start();

  const client = new MongoClient(container.getConnectionString(), {
    // Same reason as local development: without it the driver reads the replica set
    // config, sees the member advertised under its in-container hostname, and tries to
    // reconnect through that instead of the mapped port.
    directConnection: true,
  });
  await client.connect();
  const db = client.db('scheduler_test');

  // Migrations run once, exactly as they would in a deploy. Tests therefore exercise the
  // REAL index definitions — if a migration is wrong, the contract tests fail rather than
  // passing against indexes that only exist in the test setup.
  await runMigrations(db);

  return {
    db,
    mongoService: { db, client } as unknown as MongoService,

    /**
     * Delete documents rather than dropping collections.
     *
     * Dropping a collection also drops its indexes, so the second test in a file would
     * run without the unique constraint and the uniqueness assertions would pass for the
     * wrong reason — the worst kind of green test. Deleting documents preserves the
     * indexes that migrations created.
     */
    async reset() {
      const collections = await db.collections();
      await Promise.all(
        collections
          .filter((collection) => collection.collectionName !== 'migrations')
          .map((collection) => collection.deleteMany({})),
      );
    },

    async stop() {
      await client.close();
      await container.stop();
    },
  };
}
