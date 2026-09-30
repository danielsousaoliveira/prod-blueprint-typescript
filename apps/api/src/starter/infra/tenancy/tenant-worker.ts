import { Worker, type ConnectionOptions, type Job, type WorkerOptions } from 'bullmq';
import {
  InvalidOrganisationIdError,
  isOrganisationId,
  type TenantTransactionRunner,
} from './tenant-transaction';

export interface TenantJobPayload {
  readonly organisationId: string;
}

export type TenantJobHandler<P extends TenantJobPayload> = (job: Job<P>) => Promise<void>;

export function tenantJobProcessor<P extends TenantJobPayload>(
  runner: TenantTransactionRunner,
  handler: TenantJobHandler<P>,
): (job: Job<P>) => Promise<void> {
  return async (job) => {
    const organisationId: unknown = (job.data as Partial<TenantJobPayload> | undefined)
      ?.organisationId;
    if (!isOrganisationId(organisationId))
      throw new InvalidOrganisationIdError(organisationId);

    await runner.run(organisationId, () => handler(job));
  };
}

export function createTenantWorker<P extends TenantJobPayload>(
  queueName: string,
  runner: TenantTransactionRunner,
  handler: TenantJobHandler<P>,
  connection: ConnectionOptions,
  options: Omit<WorkerOptions, 'connection'> = {},
): Worker<P> {
  return new Worker<P>(queueName, tenantJobProcessor(runner, handler), {
    ...options,
    connection,
  });
}
