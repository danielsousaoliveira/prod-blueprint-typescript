import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import pinoHttp, { type Options } from 'pino-http';
import request from 'supertest';
import { httpLoggerOptions } from './http-logger';

const options = httpLoggerOptions({ LOG_LEVEL: 'info', NODE_ENV: 'production' });
const session = 'session-secret-that-must-never-be-logged';
const refresh = 'refresh-secret-that-must-never-be-logged';
const bearer = 'bearer-secret-that-must-never-be-logged';

async function captureLog(config: Options, cookies: string | string[]): Promise<string> {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const log = pinoHttp(config, stream);
  const server = createServer((req, res) => {
    log(req, res);
    res.setHeader('Set-Cookie', cookies);
    res.end('ok');
  });
  const response = await request(server)
    .get('/v1/auth/me')
    .set('Cookie', `sid=${session}`)
    .set('Authorization', `Bearer ${bearer}`);
  expect(response.status).toBe(200);
  // Redaction is only a logging operation; the browser must still receive its cookies.
  expect(response.headers['set-cookie']).toEqual(
    typeof cookies === 'string' ? [cookies] : cookies,
  );
  return output;
}

it.each([
  [`sid=${session}; HttpOnly`],
  [[`sid=${session}; HttpOnly`, `refresh=${refresh}; HttpOnly`]],
])(
  'redacts request credentials and single or multiple response cookies',
  async (cookies) => {
    const output = await captureLog(options, cookies);
    expect(output).not.toContain(session);
    expect(output).not.toContain(refresh);
    expect(output).not.toContain(bearer);
    const entry = JSON.parse(output);
    expect(entry.req).toMatchObject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: '[Redacted]', authorization: '[Redacted]' },
    });
    expect(entry.res).toMatchObject({
      statusCode: 200,
      headers: { 'set-cookie': '[Redacted]' },
    });
  },
);

it('actually captures the credentials when redaction is disabled', async () => {
  const output = await captureLog({ ...options, redact: [] }, [
    `sid=${session}; HttpOnly`,
    `refresh=${refresh}; HttpOnly`,
  ]);
  expect(output).toContain(session);
  expect(output).toContain(refresh);
  expect(output).toContain(bearer);
});
