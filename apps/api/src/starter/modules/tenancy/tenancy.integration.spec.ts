import { Controller, Get, Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import request from 'supertest';
import {
  startPostgresHarness,
  type PostgresHarness,
} from '../../../../test/postgres-harness';
import { ENV, type Env } from '../../config/env';
import { OrganisationDirectory } from '../../infra/tenancy/organisation-directory';
import { PostgresService } from '../../infra/postgres.service';
import { PrivilegedDatabase } from '../../infra/tenancy/privileged-database';
import { RedisService } from '../../infra/redis.service';
import { ProblemDetailsFilter } from '../../shared/http/problem-details';
import { OptionalOrganisation } from './organisation.decorator';
import type { Organisation } from './organisation';
import { ReservedSlugError, SlugTakenError } from './slug';
import { TenancyModule } from './tenancy.module';

jest.setTimeout(180_000);

let harness: PostgresHarness;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let postgres: PostgresService;
let privileged: PrivilegedDatabase;

@Controller('whoami')
class WhoAmIController {
  @Get()
  whoami(@OptionalOrganisation() organisation: Organisation | undefined): {
    organisation: Organisation | null;
  } {
    return { organisation: organisation ?? null };
  }
}

const buildApp = async (allowOverride: boolean): Promise<INestApplication> => {
  const env = {
    ALLOW_ORGANISATION_OVERRIDE: allowOverride,
    APP_BASE_DOMAIN: 'localtest.me',
  } as Env;

  @Global()
  @Module({
    providers: [
      { provide: ENV, useValue: env },
      {
        provide: PostgresService,
        useValue: { queryOutsideTenant: postgres.queryOutsideTenant.bind(postgres) },
      },
      {
        provide: PrivilegedDatabase,
        useValue: { query: privileged.query.bind(privileged) },
      },
      { provide: RedisService, useValue: { client: redis } },
    ],
    exports: [ENV, PostgresService, PrivilegedDatabase, RedisService],
  })
  class TestInfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestInfraModule, TenancyModule],
    controllers: [WhoAmIController],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
};

const hostOf = (app: INestApplication, host: string) =>
  request(app.getHttpServer()).get('/whoami').set('Host', host);

let app: INestApplication;
let directory: OrganisationDirectory;

beforeAll(async () => {
  harness = await startPostgresHarness();
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(redisContainer.getConnectionUrl());
  postgres = new PostgresService({
    POSTGRES_URL: harness.url.app,
    POSTGRES_POOL_MAX: 4,
  } as Env);
  privileged = new PrivilegedDatabase({
    POSTGRES_CROSS_TENANT_URL: harness.url.crosstenant,
  } as Env);
  directory = new OrganisationDirectory(postgres, privileged, {
    client: redis,
  } as unknown as RedisService);
  app = await buildApp(true);
});

afterAll(async () => {
  await app?.close();
  await postgres?.onApplicationShutdown();
  await privileged?.onApplicationShutdown();
  await redis?.quit();
  await redisContainer?.stop();
  await harness?.stop();
});

beforeEach(async () => {
  await redis.flushall();
});

describe('organisation resolution from the request host', () => {
  it('resolves the organisation named by the subdomain', async () => {
    const acme = await directory.create('acme', 'Acme');

    const response = await hostOf(app, 'acme.localtest.me:3000').expect(200);

    expect(response.body).toEqual({ organisation: acme });
  });

  it('returns 404 problem+json for an unknown subdomain', async () => {
    const response = await hostOf(app, 'nobody.localtest.me').expect(404);

    expect(response.headers['content-type']).toMatch(/problem\+json/);
    expect(response.body.type).toMatch(/not-found$/);
  });

  it('returns 404 for a nested subdomain', async () => {
    await directory.create('nested', 'Nested');

    await hostOf(app, 'deep.nested.localtest.me').expect(404);
  });

  it('resolves no organisation for reserved, base and unrelated hosts', async () => {
    for (const host of [
      'app.localtest.me',
      'www.localtest.me',
      'localtest.me',
      'localhost:3000',
    ]) {
      const response = await hostOf(app, host).expect(200);
      expect(response.body).toEqual({ organisation: null });
    }
  });

  it('refuses to create an organisation with a reserved slug', async () => {
    await expect(directory.create('admin', 'Admin')).rejects.toBeInstanceOf(
      ReservedSlugError,
    );
  });

  it('caches slug lookups', async () => {
    await directory.create('cached', 'Cached');
    await hostOf(app, 'cached.localtest.me').expect(200);

    expect(await redis.exists('organisation:slug:cached')).toBe(1);

    await harness
      .pool('owner')
      .query("UPDATE app.organisations SET name = 'Changed' WHERE slug = 'cached'");
    const response = await hostOf(app, 'cached.localtest.me').expect(200);

    expect(response.body.organisation.name).toBe('Cached');
  });

  it('invalidates the cache when a slug is renamed', async () => {
    const created = await directory.create('before', 'Renamed Co');
    await hostOf(app, 'before.localtest.me').expect(200);

    await directory.renameSlug(created.id, 'after');

    await hostOf(app, 'before.localtest.me').expect(404);
    const response = await hostOf(app, 'after.localtest.me').expect(200);
    expect(response.body.organisation.id).toBe(created.id);
  });

  it('reports a taken slug as SlugTakenError on create and on rename', async () => {
    await directory.create('taken-one', 'Taken One');
    const other = await directory.create('taken-two', 'Taken Two');

    await expect(directory.create('taken-one', 'Again')).rejects.toBeInstanceOf(
      SlugTakenError,
    );
    await expect(directory.renameSlug(other.id, 'taken-one')).rejects.toBeInstanceOf(
      SlugTakenError,
    );
  });

  it('lets unrelated database errors through untranslated', async () => {
    await expect(
      directory.renameSlug('not-a-uuid', 'valid-slug'),
    ).rejects.not.toBeInstanceOf(SlugTakenError);
  });

  it('refuses to rename an organisation onto a reserved slug', async () => {
    const created = await directory.create('renamable', 'Renamable');

    await expect(directory.renameSlug(created.id, 'status')).rejects.toBeInstanceOf(
      ReservedSlugError,
    );
  });
});

describe('the organisation override header', () => {
  it('names the organisation when the override is enabled', async () => {
    const created = await directory.create('headered', 'Headered');

    const response = await request(app.getHttpServer())
      .get('/whoami')
      .set('Host', 'localhost')
      .set('X-Organisation-Slug', 'headered')
      .expect(200);

    expect(response.body.organisation).toEqual(created);
  });

  it('is ignored when the override is not enabled', async () => {
    await directory.create('prodheader', 'Prod Header');
    const production = await buildApp(false);

    try {
      const response = await request(production.getHttpServer())
        .get('/whoami')
        .set('Host', 'localhost')
        .set('X-Organisation-Slug', 'prodheader')
        .expect(200);

      expect(response.body).toEqual({ organisation: null });
    } finally {
      await production.close();
    }
  });
});
