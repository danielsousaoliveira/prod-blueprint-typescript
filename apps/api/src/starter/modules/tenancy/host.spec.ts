import { parseOrganisationHost } from './host';

const BASE = 'localtest.me';

describe('parseOrganisationHost', () => {
  it.each([
    ['acme.localtest.me', 'acme'],
    ['ACME.LocalTest.me', 'acme'],
    ['acme.localtest.me.', 'acme'],
    ['a-b-c.localtest.me', 'a-b-c'],
  ])('resolves %p to the slug %p', (host, slug) => {
    expect(parseOrganisationHost(host, BASE)).toEqual({ kind: 'slug', slug });
  });

  it.each(['localtest.me', 'localhost', '127.0.0.1', 'example.com', undefined, ''])(
    'finds no organisation in %p',
    (host) => {
      expect(parseOrganisationHost(host, BASE)).toEqual({ kind: 'none' });
    },
  );

  it.each([
    'a.b.localtest.me',
    '-acme.localtest.me',
    'acme-.localtest.me',
    'ac_me.localtest.me',
    'ab.localtest.me',
    '.localtest.me',
  ])('rejects %p as an invalid organisation host', (host) => {
    expect(parseOrganisationHost(host, BASE)).toEqual({ kind: 'invalid' });
  });

  it('does not treat a host that merely ends with the base domain as a subdomain', () => {
    expect(parseOrganisationHost('acme.notlocaltest.me', BASE)).toEqual({ kind: 'none' });
    expect(parseOrganisationHost('acmelocaltest.me', BASE)).toEqual({ kind: 'none' });
  });
});
