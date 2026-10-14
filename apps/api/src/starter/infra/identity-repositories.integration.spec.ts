import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { type INestApplication, VersioningType } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Env } from '../config/env';
import { PostgresService } from './postgres.service';
import { IdentityDirectory } from './identity-directory';
import {
  NoTenantTransactionError,
  TenantDb,
  TenantTransactionRunner,
} from './tenancy/tenant-transaction';
import { PgUserRepository } from '../modules/auth/persistence/pg-user.repository';
import { PgPersonRepository } from '../modules/auth/persistence/pg-person.repository';
import { PgMembershipRepository } from '../modules/auth/persistence/pg-membership.repository';
import { AuthController } from '../modules/auth/api/auth.controller';
import { AuthService } from '../modules/auth/application/auth.service';
import * as password from '../modules/auth/domain/password';
import { createAuthHarness, TEST_PASSWORD } from '../../../test/auth-harness';
import {
  startPostgresHarness,
  type PostgresHarness,
} from '../../../test/postgres-harness';
import { ProblemDetailsFilter } from '../shared/http/problem-details';

jest.setTimeout(180_000);
let harness: PostgresHarness;
let postgres: PostgresService;
let transactions: TenantTransactionRunner;
let users: PgUserRepository;
let people: PgPersonRepository;
let memberships: PgMembershipRepository;
let app: INestApplication;
let acme: string;
let globex: string;
const personId = randomUUID();
const membershipId = randomUUID();
const otherPersonId = randomUUID();
const createdAt = 1_800_000_000_123;

beforeAll(async () => {
  harness = await startPostgresHarness();
  postgres = new PostgresService({
    POSTGRES_URL: harness.url.app,
    POSTGRES_POOL_MAX: 2,
  } as Env);
  transactions = new TenantTransactionRunner(postgres);
  const db = new TenantDb();
  users = new PgUserRepository(new IdentityDirectory(postgres), db);
  people = new PgPersonRepository(db);
  memberships = new PgMembershipRepository(db);
  const orgs = await harness
    .pool('owner')
    .query<{ id: string; slug: string }>(
      "INSERT INTO app.organisations (slug, name) VALUES ('acme', 'Acme'), ('globex', 'Globex') RETURNING id, slug",
    );
  acme = orgs.rows.find((row) => row.slug === 'acme')!.id;
  globex = orgs.rows.find((row) => row.slug === 'globex')!.id;
  await users.save({
    id: 'human-1',
    email: ' Human@Example.test ',
    passwordHash: await password.hashPassword(TEST_PASSWORD),
    role: 'patient',
    profileId: 'patient-1',
    createdAt,
  });
  await transactions.run(acme, async () => {
    await people.save({
      id: personId,
      identityId: 'human-1',
      email: ' Human@Example.test ',
      displayName: 'Human',
      createdAt,
    });
    await memberships.save({
      id: membershipId,
      personId,
      role: 'owner',
      status: 'active',
      createdAt,
    });
  });
  await transactions.run(globex, () =>
    people.save({
      id: otherPersonId,
      identityId: 'human-1',
      email: 'human@example.test',
      displayName: 'Same human',
      createdAt,
    }),
  );

  const auth = createAuthHarness(
    undefined,
    Object.assign(users, { clear: () => {} }),
    transactions,
  );
  const module = await Test.createTestingModule({
    controllers: [AuthController],
    providers: auth.providers,
  }).compile();
  app = module.createNestApplication();
  app.use(cookieParser());
  // Fixture for the output of the already-tested host resolver, not an auth shortcut.
  app.use(
    (
      req: { headers: Record<string, unknown>; organisation?: { id: string } },
      _res: unknown,
      next: () => void,
    ) => {
      if (req.headers['x-test-organisation'] === 'acme') req.organisation = { id: acme };
      if (req.headers['x-test-organisation'] === 'globex')
        req.organisation = { id: globex };
      next();
    },
  );
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await postgres?.onApplicationShutdown();
  await harness?.stop();
});

it('authenticates globally with the ordinary non-bypass runtime role', async () => {
  const role = await harness
    .pool('app')
    .query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
  expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  const user = await users.findByEmail(' HUMAN@example.TEST ');
  expect(user).toMatchObject({ id: 'human-1', email: 'human@example.test', createdAt });
  expect(await users.findById('human-1')).toEqual(user);
  expect(await users.findByEmail('absent@example.test')).toBeNull();
});

it('round-trips people and memberships and hides other organisations by both id and email', async () => {
  await transactions.run(acme, async () => {
    expect(await people.findByEmail(' HUMAN@example.test ')).toEqual({
      id: personId,
      identityId: 'human-1',
      email: 'human@example.test',
      displayName: 'Human',
      createdAt,
    });
    expect(await people.findById(otherPersonId)).toBeNull();
    expect(await memberships.findByPersonId(personId)).toEqual({
      id: membershipId,
      personId,
      role: 'owner',
      status: 'active',
      createdAt,
    });
    expect(await memberships.findByPersonId(otherPersonId)).toBeNull();
    expect(await users.findById('human-1')).not.toBeNull();
  });
  await transactions.run(globex, async () => {
    expect(await people.findById(personId)).toBeNull();
    expect((await people.findByEmail('human@example.test'))?.id).toBe(otherPersonId);
    expect(await users.findByEmail('human@example.test')).toBeNull();
    await memberships.remove(personId);
  });
  expect(
    await transactions.run(acme, () => memberships.findByPersonId(personId)),
  ).not.toBeNull();
});

it('refuses tenant repository reads and writes without a transaction', async () => {
  await expect(people.findById(personId)).rejects.toThrow(NoTenantTransactionError);
  await expect(memberships.findByPersonId(personId)).rejects.toThrow(
    NoTenantTransactionError,
  );
  await expect(memberships.remove(personId)).rejects.toThrow(NoTenantTransactionError);
  await expect(
    people.save({
      id: randomUUID(),
      identityId: null,
      email: 'outside@example.test',
      displayName: 'Outside',
      createdAt,
    }),
  ).rejects.toThrow(NoTenantTransactionError);
});

it('enforces global email uniqueness and prevents tenant work from changing shared credentials', async () => {
  const user = (await users.findById('human-1'))!;
  await expect(users.save({ ...user, id: 'duplicate' })).rejects.toMatchObject({
    code: '23505',
  });
  await expect(
    transactions.run(acme, () => users.save({ ...user, email: 'changed@example.test' })),
  ).rejects.toThrow('Save identities outside');
  expect(await users.findByEmail('human@example.test')).toEqual(user);
  await users.save({ ...user, profileId: 'patient-updated' });
  expect((await users.findById(user.id))?.profileId).toBe('patient-updated');
  await users.save(user);
});

it('rolls back a person when its membership violates the tenant foreign key', async () => {
  const id = randomUUID();
  await expect(
    transactions.run(globex, async () => {
      await people.save({
        id,
        identityId: null,
        email: 'rolled-back@example.test',
        displayName: 'Rollback',
        createdAt,
      });
      await memberships.save({
        id: randomUUID(),
        personId,
        role: 'member',
        status: 'active',
        createdAt,
      });
    }),
  ).rejects.toMatchObject({ code: '23503' });
  expect(await transactions.run(globex, () => people.findById(id))).toBeNull();
});

it('signs in globally and in an active organisation, signs out, and reports the current user', async () => {
  for (const organisation of ['', 'acme']) {
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('x-test-organisation', organisation)
      .send({ email: 'human@example.test', password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
    expect(cookie).not.toBe('');
    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Cookie', cookie);
    expect(me.body).toEqual({ role: 'patient', profileId: 'patient-1' });
    expect(
      (await request(app.getHttpServer()).post('/v1/auth/logout').set('Cookie', cookie))
        .status,
    ).toBe(204);
    expect(
      (await request(app.getHttpServer()).get('/v1/auth/me').set('Cookie', cookie)).body,
    ).toEqual({});
  }
  expect(
    (
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('x-test-organisation', 'globex')
        .send({ email: 'human@example.test', password: TEST_PASSWORD })
    ).status,
  ).toBe(401);
});

it('performs one real Argon2 verification for unknown addresses and wrong passwords, and retains both rate limits', async () => {
  const verify = jest.spyOn(password, 'verifyPassword');
  try {
    const auth = app.get(AuthService);
    await password.dummyHash();
    expect(await auth.login('human@example.test', 'wrong', 'timing-ip')).toEqual({
      ok: false,
      reason: 'INVALID_CREDENTIALS',
    });
    expect(await auth.login('absent@example.test', 'wrong', 'timing-ip')).toEqual({
      ok: false,
      reason: 'INVALID_CREDENTIALS',
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]?.[0]).toBe(
      (await users.findById('human-1'))?.passwordHash,
    );
    expect(verify.mock.calls[1]?.[0]).toBe(await password.dummyHash());
    for (let n = 0; n < 5; n++)
      await auth.login('limit@example.test', 'wrong', `address-ip-${n}`);
    expect(await auth.login('limit@example.test', TEST_PASSWORD, 'new-ip')).toEqual({
      ok: false,
      reason: 'RATE_LIMITED',
    });
    for (let n = 0; n < 30; n++)
      await auth.login(`limit-${n}@example.test`, 'wrong', 'source-ip');
    const calls = verify.mock.calls.length;
    expect(await auth.login('fresh@example.test', 'wrong', 'source-ip')).toEqual({
      ok: false,
      reason: 'RATE_LIMITED',
    });
    expect(verify).toHaveBeenCalledTimes(calls);
  } finally {
    verify.mockRestore();
  }
});

it('suspends, restores and removes standing without changing identity or another organisation', async () => {
  await transactions.run(acme, async () => {
    await memberships.save({
      id: membershipId,
      personId,
      role: 'admin',
      status: 'suspended',
      createdAt,
    });
    expect(await users.findByEmail('human@example.test')).toBeNull();
    expect((await memberships.findByPersonId(personId))?.role).toBe('admin');
    await memberships.save({
      id: membershipId,
      personId,
      role: 'member',
      status: 'active',
      createdAt,
    });
    expect(await users.findByEmail('human@example.test')).not.toBeNull();
    await memberships.remove(personId);
    expect(await memberships.findByPersonId(personId)).toBeNull();
    expect(await users.findById('human-1')).toBeNull();
  });
  expect(await users.findById('human-1')).not.toBeNull();
  expect(
    await transactions.run(globex, () => people.findById(otherPersonId)),
  ).not.toBeNull();
});

it('never turns an expired tenant context into a global identity lookup', async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookup!: Promise<unknown>;
  await transactions.run(acme, () => {
    lookup = (async () => {
      await released;
      return users.findByEmail('human@example.test');
    })();
    return Promise.resolve();
  });
  release();
  await expect(lookup).rejects.toThrow(NoTenantTransactionError);
});
