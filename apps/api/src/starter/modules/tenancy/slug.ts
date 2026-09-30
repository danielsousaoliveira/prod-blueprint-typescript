import { SLUG_PATTERN } from '../../persistence/pg/schema';

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'app',
  'api',
  'web',
  'ui',
  'admin',
  'administration',
  'status',
  'mail',
  'docs',
  'documentation',
  'marketing',
]);

const SLUG_REGEX = new RegExp(SLUG_PATTERN);

export class InvalidSlugError extends Error {
  constructor(readonly slug: string) {
    super(`Not a valid organisation slug: ${slug}`);
    this.name = 'InvalidSlugError';
  }
}

export class ReservedSlugError extends Error {
  constructor(readonly slug: string) {
    super(`The slug ${slug} is reserved`);
    this.name = 'ReservedSlugError';
  }
}

export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`The slug ${slug} is already taken`);
    this.name = 'SlugTakenError';
  }
}

export const isValidSlug = (value: string): boolean => SLUG_REGEX.test(value);

export const isReservedSlug = (value: string): boolean => RESERVED_SLUGS.has(value);

export function assertClaimableSlug(value: string): void {
  if (!isValidSlug(value)) throw new InvalidSlugError(value);
  if (isReservedSlug(value)) throw new ReservedSlugError(value);
}
