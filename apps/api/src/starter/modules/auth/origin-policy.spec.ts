import { isAllowedOrigin, type OriginPolicy } from './origin-policy';

const policy: OriginPolicy = {
  explicitOrigins: ['https://www.example.com', 'http://localhost:5173'],
  baseDomain: 'example.com',
  requireHttps: true,
};

describe('isAllowedOrigin', () => {
  it.each([
    'https://acme.example.com',
    'https://a-b-c.example.com',
    'https://acme.example.com:8443',
  ])('accepts the organisation origin %p', (origin) => {
    expect(isAllowedOrigin(origin, policy)).toBe(true);
  });

  it.each(['https://www.example.com', 'http://localhost:5173'])(
    'still accepts the explicit origin %p',
    (origin) => {
      expect(isAllowedOrigin(origin, policy)).toBe(true);
    },
  );

  it.each([
    'https://evil.com',
    'https://acme.evil.com',
    'https://example.com.evil.com',
    'https://acme.example.com.evil.com',
  ])('rejects the unrelated origin %p', (origin) => {
    expect(isAllowedOrigin(origin, policy)).toBe(false);
  });

  it.each([
    'https://acme-example.com',
    'https://acmeexample.com',
    'https://notexample.com',
    'https://acme.notexample.com',
    'https://evilexample.com',
  ])('rejects %p, which merely ends with the application domain', (origin) => {
    expect(isAllowedOrigin(origin, policy)).toBe(false);
  });

  it.each([
    'https://a.b.example.com',
    'https://-acme.example.com',
    'https://acme-.example.com',
    'https://ac_me.example.com',
    'https://ab.example.com',
    'https://.example.com',
  ])('rejects %p, whose label is not a valid organisation slug', (origin) => {
    expect(isAllowedOrigin(origin, policy)).toBe(false);
  });

  it('rejects the bare application domain, which is not an organisation', () => {
    expect(isAllowedOrigin('https://example.com', policy)).toBe(false);
  });

  it.each([
    'null',
    '',
    'not a url',
    'https://',
    'ftp://acme.example.com',
    'javascript:alert(1)',
  ])('rejects the malformed or non-web origin %p', (origin) => {
    expect(isAllowedOrigin(origin, policy)).toBe(false);
  });

  it('rejects an origin that carries a path, credentials or a trailing slash', () => {
    expect(isAllowedOrigin('https://acme.example.com/', policy)).toBe(false);
    expect(isAllowedOrigin('https://user@acme.example.com', policy)).toBe(false);
    expect(isAllowedOrigin('https://acme.example.com/path', policy)).toBe(false);
  });

  it('compares the host case-insensitively', () => {
    expect(isAllowedOrigin('https://ACME.Example.COM', policy)).toBe(false);
    expect(isAllowedOrigin('https://acme.example.com', policy)).toBe(true);
  });

  it('refuses plain http for an organisation when https is required', () => {
    expect(isAllowedOrigin('http://acme.example.com', policy)).toBe(false);
  });

  it('allows plain http for an organisation when https is not required', () => {
    expect(
      isAllowedOrigin('http://acme.example.com:5173', { ...policy, requireHttps: false }),
    ).toBe(true);
  });

  it('accepts only the explicit list when no base domain is configured', () => {
    const explicitOnly: OriginPolicy = { ...policy, baseDomain: undefined };

    expect(isAllowedOrigin('https://www.example.com', explicitOnly)).toBe(true);
    expect(isAllowedOrigin('https://acme.example.com', explicitOnly)).toBe(false);
  });
});
