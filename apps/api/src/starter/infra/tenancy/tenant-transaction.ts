import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PostgresService } from '../postgres.service';

export const TENANT_SETTING = 'app.current_organisation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NoTenantTransactionError extends Error {
  constructor() {
    super(
      'Tenant data was accessed outside a tenant transaction. Wrap the call in TenantTransactionRunner.run().',
    );
    this.name = 'NoTenantTransactionError';
  }
}

export class InvalidOrganisationIdError extends Error {
  constructor(value: unknown) {
    super(`Not a valid organisation id: ${String(value)}`);
    this.name = 'InvalidOrganisationIdError';
  }
}

export class NestedTenantTransactionError extends Error {
  constructor(outer: string, inner: string) {
    super(`Cannot start a transaction for ${inner} inside one for ${outer}.`);
    this.name = 'NestedTenantTransactionError';
  }
}

interface ActiveTransaction {
  readonly organisationId: string;
  readonly client: PoolClient;
  open: boolean;
}

const storage = new AsyncLocalStorage<ActiveTransaction>();

export function isOrganisationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

@Injectable()
export class TenantTransactionRunner {
  constructor(private readonly postgres: PostgresService) {}

  async run<T>(organisationId: string, work: () => Promise<T>): Promise<T> {
    if (!isOrganisationId(organisationId))
      throw new InvalidOrganisationIdError(organisationId);

    const outer = storage.getStore();
    if (outer?.open) {
      if (outer.organisationId !== organisationId) {
        throw new NestedTenantTransactionError(outer.organisationId, organisationId);
      }
      return work();
    }

    const client = await this.postgres.connect();
    const transaction: ActiveTransaction = { organisationId, client, open: true };
    let discard = false;

    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        TENANT_SETTING,
        organisationId,
      ]);
      const result = await storage.run(transaction, work);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      transaction.open = false;
      client.release(discard ? true : undefined);
    }
  }
}

@Injectable()
export class TenantDb {
  get organisationId(): string {
    return this.current().organisationId;
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.current().client.query<R>(
      text,
      values === undefined ? undefined : [...values],
    );
  }

  private current(): ActiveTransaction {
    const transaction = storage.getStore();
    if (!transaction?.open) throw new NoTenantTransactionError();
    return transaction;
  }
}
