import type { Env } from '../src/starter/config/env';
import { IdentityDirectory } from '../src/starter/infra/identity-directory';
import { PostgresService } from '../src/starter/infra/postgres.service';
import {
  TenantDb,
  TenantTransactionRunner,
} from '../src/starter/infra/tenancy/tenant-transaction';
import { PgUserRepository } from '../src/starter/modules/auth/persistence/pg-user.repository';
import { createAuthHarness } from './auth-harness';
import { startPostgresHarness } from './postgres-harness';

export async function createPostgresAuthHarness() {
  const postgres = await startPostgresHarness();
  const service = new PostgresService({
    POSTGRES_URL: postgres.url.app,
    POSTGRES_POOL_MAX: 2,
  } as Env);
  const db = new TenantDb();
  const transactions = new TenantTransactionRunner(service);
  const repository = new PgUserRepository(new IdentityDirectory(service), db);
  const users = Object.assign(repository, {
    clear: async () => {
      await postgres.pool('owner').query('DELETE FROM app.identities');
    },
  });
  return {
    auth: createAuthHarness(undefined, users, transactions),
    async stop() {
      await service.onApplicationShutdown();
      await postgres.stop();
    },
  };
}
