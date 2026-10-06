import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { OrganisationDirectory } from '../../infra/tenancy/organisation-directory';
import { parseOrganisationHost } from './host';
import { OrganisationNotFoundError, type Organisation } from './organisation';
import { isReservedSlug } from './slug';

export const ORGANISATION_OVERRIDE_HEADER = 'x-organisation-slug';

export interface HostInput {
  readonly hostname: string | undefined;
  readonly overrideSlug?: string | undefined;
}

@Injectable()
export class OrganisationResolver {
  constructor(
    private readonly directory: OrganisationDirectory,
    @Inject(ENV)
    private readonly env: Pick<Env, 'APP_BASE_DOMAIN' | 'ALLOW_ORGANISATION_OVERRIDE'>,
  ) {}

  async resolve(input: HostInput): Promise<Organisation | undefined> {
    const parsed = parseOrganisationHost(input.hostname, this.env.APP_BASE_DOMAIN);

    if (parsed.kind === 'invalid') {
      throw new OrganisationNotFoundError(input.hostname ?? '');
    }

    if (parsed.kind === 'slug' && !isReservedSlug(parsed.slug)) {
      return this.lookup(parsed.slug);
    }

    if (
      parsed.kind === 'none' &&
      this.env.ALLOW_ORGANISATION_OVERRIDE &&
      input.overrideSlug
    ) {
      return this.lookup(input.overrideSlug.trim().toLowerCase());
    }

    return undefined;
  }

  private async lookup(slug: string): Promise<Organisation> {
    const organisation = await this.directory.findBySlug(slug);
    if (!organisation) throw new OrganisationNotFoundError(slug);
    return organisation;
  }
}
