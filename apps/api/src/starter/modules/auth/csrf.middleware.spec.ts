import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../../config/env';
import { ProblemException } from '../../shared/http/problem-details';
import { CsrfMiddleware } from './csrf.middleware';

const env = {
  ALLOWED_ORIGINS: ['https://www.example.com', 'http://localhost:5173'],
  APP_BASE_DOMAIN: 'example.com',
  SESSION_COOKIE_SECURE: true,
} as Env;

const run = (
  method: string,
  headers: Record<string, string>,
): { passed: boolean; error?: unknown } => {
  const middleware = new CsrfMiddleware(env);
  const request = {
    method,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  let passed = false;
  const next: NextFunction = () => {
    passed = true;
  };

  try {
    middleware.use(request, {} as Response, next);
  } catch (error) {
    return { passed, error };
  }
  return { passed };
};

const rejects = (origin: string): boolean => {
  const outcome = run('POST', { origin });
  return !outcome.passed && outcome.error instanceof ProblemException;
};

describe('CsrfMiddleware', () => {
  it('accepts a state-changing request from an organisation subdomain', () => {
    expect(run('POST', { origin: 'https://acme.example.com' }).passed).toBe(true);
  });

  it('rejects one from an unrelated domain', () => {
    expect(rejects('https://evil.com')).toBe(true);
  });

  it('rejects one from a domain that merely ends with the application domain', () => {
    expect(rejects('https://acme-example.com')).toBe(true);
    expect(rejects('https://evilexample.com')).toBe(true);
    expect(rejects('https://example.com.evil.com')).toBe(true);
  });

  it('rejects one from a host whose organisation label is invalid', () => {
    expect(rejects('https://a.b.example.com')).toBe(true);
    expect(rejects('https://-acme.example.com')).toBe(true);
  });

  it('still accepts the explicit origins, such as the marketing site and the dev server', () => {
    expect(run('POST', { origin: 'https://www.example.com' }).passed).toBe(true);
    expect(run('POST', { origin: 'http://localhost:5173' }).passed).toBe(true);
  });

  it('accepts a state-changing request that carries no Origin, because the payment provider webhook sends none', () => {
    expect(run('POST', {}).passed).toBe(true);
    expect(run('DELETE', {}).passed).toBe(true);
  });

  it('rejects a cross-site request by Sec-Fetch-Site even from an allowed origin', () => {
    const outcome = run('POST', {
      origin: 'https://acme.example.com',
      'sec-fetch-site': 'cross-site',
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.error).toBeInstanceOf(ProblemException);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not check the origin of a %s', (method) => {
    expect(run(method, { origin: 'https://evil.com' }).passed).toBe(true);
  });
});
