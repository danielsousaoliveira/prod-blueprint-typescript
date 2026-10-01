import type { Request, Response } from 'express';
import type { Env } from '../../../config/env';
import type { AuthService } from '../application/auth.service';
import { AuthController } from './auth.controller';

const baseEnv = {
  SESSION_COOKIE_NAME: 'sid',
  SESSION_COOKIE_SECURE: true,
  SESSION_TTL_SECONDS: 60,
} as Env;

const signIn = async (env: Env): Promise<Record<string, unknown>> => {
  const auth = {
    login: () =>
      Promise.resolve({
        ok: true,
        sessionId: 'session-1',
        actor: { userId: 'u', role: 'doctor', profileId: 'p' },
      }),
  } as unknown as AuthService;
  let options: Record<string, unknown> = {};
  const response = {
    cookie: (_name: string, _value: string, opts: Record<string, unknown>) => {
      options = opts;
    },
  } as unknown as Response;

  await new AuthController(auth, env).login(
    { email: 'a@example.test', password: 'pw' },
    { ip: '1.2.3.4', socket: {} } as unknown as Request,
    response,
  );
  return options;
};

describe('the session cookie scope', () => {
  it('is host-only when no cookie domain is configured', async () => {
    expect(await signIn(baseEnv)).not.toHaveProperty('domain');
  });

  it('is scoped to the parent domain when one is configured', async () => {
    expect(
      await signIn({ ...baseEnv, SESSION_COOKIE_DOMAIN: 'example.com' }),
    ).toMatchObject({
      domain: 'example.com',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
  });
});
