import { parseOrganisationHost } from '../tenancy/host';

export interface OriginPolicy {
  readonly explicitOrigins: readonly string[];
  readonly baseDomain?: string | undefined;
  readonly requireHttps: boolean;
}

export function isAllowedOrigin(origin: string, policy: OriginPolicy): boolean {
  if (policy.explicitOrigins.includes(origin)) return true;
  if (!policy.baseDomain) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.origin !== origin) return false;
  if (url.protocol !== 'https:' && (url.protocol !== 'http:' || policy.requireHttps)) {
    return false;
  }

  return parseOrganisationHost(url.hostname, policy.baseDomain).kind === 'slug';
}
