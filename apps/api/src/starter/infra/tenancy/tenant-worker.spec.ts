import type { Job } from 'bullmq';
import {
  InvalidOrganisationIdError,
  type TenantTransactionRunner,
} from './tenant-transaction';
import { tenantJobProcessor, type TenantJobPayload } from './tenant-worker';

const ACME = '11111111-1111-4111-8111-111111111111';

const jobWith = (data: unknown): Job<TenantJobPayload> =>
  ({ data }) as Job<TenantJobPayload>;

const fakeRunner = (): { runner: TenantTransactionRunner; runs: string[] } => {
  const runs: string[] = [];
  const runner = {
    run: <T>(organisationId: string, work: () => Promise<T>): Promise<T> => {
      runs.push(organisationId);
      return work();
    },
  } as unknown as TenantTransactionRunner;
  return { runner, runs };
};

describe('tenantJobProcessor', () => {
  it('runs the handler inside a tenant transaction for the payload organisation', async () => {
    const { runner, runs } = fakeRunner();
    const handled: unknown[] = [];

    await tenantJobProcessor(runner, (job) => {
      handled.push(job.data);
      return Promise.resolve();
    })(jobWith({ organisationId: ACME, other: 1 }));

    expect(runs).toEqual([ACME]);
    expect(handled).toEqual([{ organisationId: ACME, other: 1 }]);
  });

  it.each([undefined, {}, { organisationId: 'acme' }, { organisationId: 5 }])(
    'fails a job whose payload is %p without running the handler',
    async (data) => {
      const { runner, runs } = fakeRunner();
      let called = false;

      await expect(
        tenantJobProcessor(runner, () => {
          called = true;
          return Promise.resolve();
        })(jobWith(data)),
      ).rejects.toBeInstanceOf(InvalidOrganisationIdError);

      expect(called).toBe(false);
      expect(runs).toEqual([]);
    },
  );
});
