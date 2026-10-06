import { OrganisationNotFoundError, type Organisation } from './organisation';
import {
  ORGANISATION_OVERRIDE_HEADER,
  type OrganisationResolver,
} from './organisation-resolver';

export type UpgradeOrganisation =
  | { readonly ok: true; readonly organisation: Organisation | undefined }
  | { readonly ok: false };

function hostnameOf(hostHeader: unknown): string | undefined {
  if (typeof hostHeader !== 'string') return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

export async function resolveUpgradeOrganisation(
  resolver: Pick<OrganisationResolver, 'resolve'>,
  headers: unknown,
): Promise<UpgradeOrganisation> {
  const source = (headers ?? {}) as Record<string, unknown>;
  const override = source[ORGANISATION_OVERRIDE_HEADER];

  try {
    const organisation = await resolver.resolve({
      hostname: hostnameOf(source.host),
      overrideSlug: typeof override === 'string' ? override : undefined,
    });
    return { ok: true, organisation };
  } catch (error) {
    if (error instanceof OrganisationNotFoundError) return { ok: false };
    throw error;
  }
}
