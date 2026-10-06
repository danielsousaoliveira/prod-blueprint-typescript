import {
  InvalidSlugError,
  RESERVED_SLUGS,
  ReservedSlugError,
  assertClaimableSlug,
  isValidSlug,
} from './slug';

describe('slugs', () => {
  it.each(['www', 'app', 'web', 'admin', 'status', 'mail', 'docs', 'marketing'])(
    'reserves %p',
    (slug) => {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
      expect(() => assertClaimableSlug(slug)).toThrow(ReservedSlugError);
    },
  );

  it('accepts an ordinary slug', () => {
    expect(() => assertClaimableSlug('acme-health')).not.toThrow();
  });

  it.each(['', 'ab', 'Acme', 'a b', '-acme', 'acme-', 'a.b'])('rejects %p', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
    expect(() => assertClaimableSlug(slug)).toThrow(InvalidSlugError);
  });
});
