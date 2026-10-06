import { isValidSlug } from './slug';

export type ParsedHost =
  | { readonly kind: 'none' }
  | { readonly kind: 'slug'; readonly slug: string }
  | { readonly kind: 'invalid' };

const normalise = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '');

export function parseOrganisationHost(
  hostname: string | undefined,
  baseDomain: string,
): ParsedHost {
  if (!hostname) return { kind: 'none' };

  const host = normalise(hostname);
  const base = normalise(baseDomain);
  const suffix = `.${base}`;

  if (!host.endsWith(suffix)) return { kind: 'none' };

  const label = host.slice(0, host.length - suffix.length);
  if (!isValidSlug(label)) return { kind: 'invalid' };

  return { kind: 'slug', slug: label };
}
