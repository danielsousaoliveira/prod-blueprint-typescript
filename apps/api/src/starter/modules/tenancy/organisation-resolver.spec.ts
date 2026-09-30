import type { OrganisationDirectory } from '../../infra/tenancy/organisation-directory';
import { OrganisationNotFoundError, type Organisation } from './organisation';
import { OrganisationResolver } from './organisation-resolver';
import { resolveUpgradeOrganisation } from './upgrade-organisation';

const ACME: Organisation = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
};

const directory = (known: Organisation[] = [ACME]) => {
  const lookups: string[] = [];
  const stub = {
    findBySlug: (slug: string) => {
      lookups.push(slug);
      return Promise.resolve(known.find((org) => org.slug === slug) ?? null);
    },
  } as unknown as OrganisationDirectory;
  return { stub, lookups };
};

const resolverFor = (allowOverride: boolean, known?: Organisation[]) => {
  const { stub, lookups } = directory(known);
  const resolver = new OrganisationResolver(stub, {
    APP_BASE_DOMAIN: 'localtest.me',
    ALLOW_ORGANISATION_OVERRIDE: allowOverride,
  });
  return { resolver, lookups };
};

describe('OrganisationResolver', () => {
  it('resolves the organisation addressed by the subdomain', async () => {
    const { resolver } = resolverFor(false);

    await expect(resolver.resolve({ hostname: 'acme.localtest.me' })).resolves.toEqual(
      ACME,
    );
  });

  it('throws not-found for an unknown subdomain', async () => {
    const { resolver } = resolverFor(false);

    await expect(
      resolver.resolve({ hostname: 'nobody.localtest.me' }),
    ).rejects.toBeInstanceOf(OrganisationNotFoundError);
  });

  it('throws not-found for a nested or malformed subdomain without a lookup', async () => {
    const { resolver, lookups } = resolverFor(false);

    await expect(
      resolver.resolve({ hostname: 'x.acme.localtest.me' }),
    ).rejects.toBeInstanceOf(OrganisationNotFoundError);
    expect(lookups).toEqual([]);
  });

  it('treats a reserved name as infrastructure, not as an organisation lookup', async () => {
    const { resolver, lookups } = resolverFor(false);

    await expect(
      resolver.resolve({ hostname: 'app.localtest.me' }),
    ).resolves.toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it('resolves nothing for a host outside the base domain', async () => {
    const { resolver } = resolverFor(false);

    await expect(resolver.resolve({ hostname: 'localhost' })).resolves.toBeUndefined();
  });

  describe('the organisation override header', () => {
    it('is honoured when ALLOW_ORGANISATION_OVERRIDE is on', async () => {
      const { resolver } = resolverFor(true);

      await expect(
        resolver.resolve({ hostname: 'localhost', overrideSlug: 'acme' }),
      ).resolves.toEqual(ACME);
    });

    it('is ignored unless ALLOW_ORGANISATION_OVERRIDE is on', async () => {
      const { resolver, lookups } = resolverFor(false);

      await expect(
        resolver.resolve({ hostname: 'localhost', overrideSlug: 'acme' }),
      ).resolves.toBeUndefined();
      expect(lookups).toEqual([]);
    });

    it('does not override the organisation the host already names', async () => {
      const other: Organisation = {
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'globex',
        name: 'Globex',
      };
      const { resolver } = resolverFor(true, [ACME, other]);

      await expect(
        resolver.resolve({ hostname: 'globex.localtest.me', overrideSlug: 'acme' }),
      ).resolves.toEqual(other);
    });
  });
});

describe('resolveUpgradeOrganisation', () => {
  it('resolves from the Host header of the upgrade request, ignoring the port', async () => {
    const { resolver } = resolverFor(false);

    await expect(
      resolveUpgradeOrganisation(resolver, { host: 'acme.localtest.me:5173' }),
    ).resolves.toEqual({ ok: true, organisation: ACME });
  });

  it('rejects the connection for an unknown organisation', async () => {
    const { resolver } = resolverFor(false);

    await expect(
      resolveUpgradeOrganisation(resolver, { host: 'nobody.localtest.me' }),
    ).resolves.toEqual({ ok: false });
  });

  it('accepts a connection that names no organisation', async () => {
    const { resolver } = resolverFor(false);

    await expect(
      resolveUpgradeOrganisation(resolver, { host: 'localhost:3000' }),
    ).resolves.toEqual({
      ok: true,
      organisation: undefined,
    });
  });

  it('survives missing headers and a malformed Host', async () => {
    const { resolver } = resolverFor(false);

    await expect(resolveUpgradeOrganisation(resolver, undefined)).resolves.toEqual({
      ok: true,
      organisation: undefined,
    });
    await expect(
      resolveUpgradeOrganisation(resolver, { host: 'bad host' }),
    ).resolves.toEqual({
      ok: true,
      organisation: undefined,
    });
  });

  it('honours the override header only when it is enabled', async () => {
    const dev = resolverFor(true).resolver;
    const prod = resolverFor(false).resolver;
    const headers = { host: 'localhost:3000', 'x-organisation-slug': 'acme' };

    await expect(resolveUpgradeOrganisation(dev, headers)).resolves.toEqual({
      ok: true,
      organisation: ACME,
    });
    await expect(resolveUpgradeOrganisation(prod, headers)).resolves.toEqual({
      ok: true,
      organisation: undefined,
    });
  });
});
